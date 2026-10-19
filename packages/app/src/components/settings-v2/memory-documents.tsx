import type { MemoryDocument, VectorClient } from "@vectordevai/sdk/v2/client"
import { For, Show, createEffect, createResource, createSignal, onCleanup } from "solid-js"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { IconButtonV2 } from "@vectordevai/ui/v2/icon-button-v2"
import { Icon } from "@vectordevai/ui/v2/icon"
import { MenuV2 } from "@vectordevai/ui/v2/menu-v2"
import { Switch } from "@vectordevai/ui/v2/switch-v2"
import { usePlatform } from "@/context/platform"
import { ServerConnection, useServer } from "@/context/server"
import { MemoryDocumentPage } from "./memory-document"
import {
  DOCUMENT_ACCEPT,
  DROP,
  FORGET,
  KEEP_ORIGINALS,
  POLL,
  REPOSITORY_DOCS,
  addedLabel,
  approvable,
  documentList,
  documentMeta,
  documentsSummary,
  forgottenLabel,
  needsLook,
  needsLookCount,
  pausable,
  polling,
  precheck,
  refusalLabel,
  refusal,
  reindexable,
  replaceable,
  resumable,
  statusLabel,
  statusTone,
  steps,
  uploadMode,
  visibilityLabel,
  warningLabel,
} from "./memory-documents-model"

type Note = { id: number; tone: "ok" | "error" | "ask"; text: string; retry?: () => void }

// Settings > Memory > Documents: the documents Vector keeps for this repository. Files dropped here are read on this
// computer into sections, passages and typed records; a request gets only the cards that bear on it. Progress is read
// by polling while anything is being read, never pushed over the event stream.
export function SettingsMemoryDocuments(props: { client: () => VectorClient | undefined; repository: boolean }) {
  const platform = usePlatform()
  const server = useServer()
  const [version, setVersion] = createSignal(0)
  const [open, setOpen] = createSignal<string>()
  const [notes, setNotes] = createSignal<Note[]>([])
  const [over, setOver] = createSignal(false)
  const refresh = () => setVersion((value) => value + 1)
  let picker: HTMLInputElement | undefined
  let replacer: HTMLInputElement | undefined
  let replacing: MemoryDocument | undefined
  let next = 0

  const [list, { mutate }] = createResource(
    () => {
      const client = props.client()
      return client ? { client, version: version() } : false
    },
    (input) => input.client.memory.documents.list().then((result) => documentList(result.data)),
  )

  // While anything is read or the search model downloads, ask again every two seconds; stop once all is idle.
  createEffect(() => {
    if (!polling(list.latest)) return
    const timer = setTimeout(refresh, POLL)
    onCleanup(() => clearTimeout(timer))
  })

  const note = (input: Omit<Note, "id">) => setNotes((all) => [{ ...input, id: ++next }, ...all].slice(0, 6))
  const dismiss = (id: number) => setNotes((all) => all.filter((item) => item.id !== id))

  const send = async (file: File, replace = false) => {
    const client = props.client()
    if (!client) return
    const refused = precheck(file)
    if (refused) {
      note({ tone: "error", text: refused })
      return
    }
    const path = platform.getPathForFile?.(file) || undefined
    const builtin = !!server.current && ServerConnection.builtin(server.current)
    const result = await (
      uploadMode({ builtin, path }) === "path" && path
        ? client.memory.documents.path({ path, replace })
        : client.memory.documents.upload({ file, replace: replace ? "true" : "false" })
    ).catch((cause: unknown) => ({ error: cause, data: undefined }))
    if (result.data) {
      note({ tone: "ok", text: addedLabel(result.data, file.name) })
      refresh()
      return
    }
    const why = refusal(result.error)
    note({
      tone: why.reason === "version" ? "ask" : "error",
      text: refusalLabel(why.reason, why.message, file.name),
      ...(why.reason === "version" ? { retry: () => void send(file, true) } : {}),
    })
  }

  const add = async (files: readonly File[]) => {
    for (const file of files) await send(file)
  }

  // Every change goes through the engine; the list is read again after it.
  const change = async (run: (client: VectorClient) => Promise<{ error?: unknown; data?: unknown }>, done: string) => {
    const client = props.client()
    if (!client) return
    const result = await run(client).catch((cause: unknown) => ({ error: cause, data: undefined }))
    if (result.error) {
      const why = refusal(result.error)
      note({ tone: "error", text: why.message ?? "Vector could not change this document. Try again in a moment." })
      return
    }
    note({ tone: "ok", text: done })
    refresh()
  }

  const setSetting = (patch: { repositoryDocs?: boolean; keepOriginals?: boolean }) => {
    const current = list.latest
    if (current) mutate({ ...current, settings: { ...current.settings, ...patch } })
    void change(
      (client) => client.memory.settings.update(patch),
      patch.repositoryDocs === false
        ? "Vector no longer reads this repository's docs, and forgot what it read of them."
        : patch.repositoryDocs
          ? "Vector reads this repository's docs."
          : patch.keepOriginals
            ? "Vector keeps a copy of each file you add from now on."
            : "Vector no longer keeps copies, and deleted the ones it kept.",
    )
  }

  const shown = () => (list.latest?.documents ?? []).filter((document) => document.status !== "superseded")

  return (
    <Show
      when={open()}
      fallback={
        <>
          <div class="settings-v2-card settings-v2-card--wide" data-component="settings-memory-documents">
            <div class="settings-v2-card-head">
              <div class="settings-v2-card-copy">
                <h3 class="settings-v2-card-title">Documents</h3>
                <p class="settings-v2-card-description">
                  <Show
                    when={list.latest}
                    fallback={list.loading ? "Reading documents…" : "Documents are not available."}
                  >
                    {(current) => <>{documentsSummary(current())}</>}
                  </Show>
                </p>
              </div>
            </div>
            <div class="settings-v2-card-body">
              <div
                class="settings-memory-drop"
                classList={{ "is-over": over() }}
                data-component="settings-memory-drop"
                onDragEnter={(event) => {
                  event.preventDefault()
                  setOver(true)
                }}
                onDragOver={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
                  setOver(true)
                }}
                onDragLeave={(event) => {
                  const next = event.relatedTarget
                  if (!(next instanceof Node) || !event.currentTarget.contains(next)) setOver(false)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setOver(false)
                  void add(Array.from(event.dataTransfer?.files ?? []))
                }}
              >
                <Icon name="download" class="settings-memory-drop-icon" />
                <p class="settings-memory-drop-title">{over() ? DROP.over : DROP.idle}</p>
                <p class="settings-memory-drop-hint">{DROP.formats}</p>
                <ButtonV2 variant="outline" icon="plus" onClick={() => picker?.click()}>
                  Add documents…
                </ButtonV2>
                <p class="settings-memory-drop-hint">{DROP.private}</p>
                <input
                  ref={(element) => (picker = element)}
                  type="file"
                  multiple
                  accept={DOCUMENT_ACCEPT}
                  class="hidden"
                  aria-label="Add documents"
                  data-component="settings-memory-documents-input"
                  onChange={(event) => {
                    const files = Array.from(event.currentTarget.files ?? [])
                    event.currentTarget.value = ""
                    void add(files)
                  }}
                />
                <input
                  ref={(element) => (replacer = element)}
                  type="file"
                  class="hidden"
                  aria-label="Replace document"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0]
                    event.currentTarget.value = ""
                    const target = replacing
                    replacing = undefined
                    // Read as the document's next version: same name, so the same lineage.
                    if (file && target) void send(new File([file], target.name, { type: file.type }), true)
                  }}
                />
              </div>

              <Show when={list.latest?.worker?.mode === "in-process"}>
                <p class="settings-memory-warning">
                  Large documents need Vector's background reader, which could not start here
                  {list.latest?.worker?.reason ? `: ${list.latest.worker.reason}` : "."}
                </p>
              </Show>

              <Show when={notes().length > 0}>
                <div class="settings-memory-notes" role="status">
                  <For each={notes()}>
                    {(item) => (
                      <div class="settings-memory-note" data-tone={item.tone}>
                        <span>{item.text}</span>
                        <Show when={item.retry}>
                          {(retry) => (
                            <ButtonV2
                              size="small"
                              variant="outline"
                              onClick={() => {
                                dismiss(item.id)
                                retry()()
                              }}
                            >
                              Read as next version
                            </ButtonV2>
                          )}
                        </Show>
                        <IconButtonV2
                          size="small"
                          variant="ghost-muted"
                          icon={<Icon name="xmark-small" />}
                          aria-label="Dismiss"
                          onClick={() => dismiss(item.id)}
                        />
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </div>

          <Show when={needsLookCount(shown()) > 0}>
            <div class="settings-v2-card settings-v2-card--wide" data-component="settings-memory-needs-look">
              <div class="settings-v2-card-head">
                <div class="settings-v2-card-copy">
                  <h3 class="settings-v2-card-title">
                    Needs a look <span class="settings-memory-count">{needsLookCount(shown())}</span>
                  </h3>
                  <p class="settings-v2-card-description">
                    Held parts are never searched, recalled or shown to the agent until you approve them.
                  </p>
                </div>
              </div>
              <div class="settings-memory-list">
                <For each={needsLook(shown())}>
                  {(item) => (
                    <div class="settings-memory-row is-waiting">
                      <div class="settings-memory-row-head">
                        <span class="settings-memory-doc-title">{item.title}</span>
                      </div>
                      <p class="settings-memory-hold">{item.text}</p>
                      <div class="settings-memory-actions">
                        <ButtonV2 size="small" variant="ghost" onClick={() => setOpen(item.document)}>
                          Open
                        </ButtonV2>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <div class="settings-v2-card settings-v2-card--wide">
            <div class="settings-memory-list settings-memory-list--top">
              <Show
                when={shown().length > 0}
                fallback={
                  <p class="settings-memory-empty">
                    {props.repository
                      ? "No documents for this repository yet. Add a spec, a runbook or an API description, and Vector brings in the parts that bear on each request."
                      : "Open a repository to add documents to it."}
                  </p>
                }
              >
                <For each={shown()}>
                  {(document) => (
                    <DocumentRow
                      document={document}
                      onOpen={() => setOpen(document.id)}
                      onReplace={() => {
                        replacing = document
                        if (replacer) replacer.accept = `.${document.name.split(".").pop() ?? ""}`
                        replacer?.click()
                      }}
                      change={change}
                    />
                  )}
                </For>
              </Show>
            </div>
          </div>

          <Show when={list.latest?.settings}>
            {(settings) => (
              <div class="settings-v2-card settings-v2-card--wide">
                <div class="settings-v2-card-body">
                  <div class="settings-v2-row-modern">
                    <div class="settings-v2-row-copy">
                      <div class="settings-v2-row-title">Read this repository's docs</div>
                      <div class="settings-v2-row-description">{REPOSITORY_DOCS}</div>
                    </div>
                    <div class="settings-v2-row-control settings-v2-row-control--compact">
                      <Switch
                        checked={settings().repositoryDocs}
                        onChange={(repositoryDocs) => setSetting({ repositoryDocs })}
                      />
                    </div>
                  </div>
                  <div class="settings-v2-row-modern">
                    <div class="settings-v2-row-copy">
                      <div class="settings-v2-row-title">Keep copies of added files</div>
                      <div class="settings-v2-row-description">{KEEP_ORIGINALS}</div>
                    </div>
                    <div class="settings-v2-row-control settings-v2-row-control--compact">
                      <Switch
                        checked={settings().keepOriginals}
                        onChange={(keepOriginals) => setSetting({ keepOriginals })}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </Show>
        </>
      }
    >
      {(id) => (
        <MemoryDocumentPage
          client={props.client}
          documentID={id()}
          onBack={() => {
            setOpen(undefined)
            refresh()
          }}
        />
      )}
    </Show>
  )
}

function DocumentRow(props: {
  document: MemoryDocument
  onOpen: () => void
  onReplace: () => void
  change: (run: (client: VectorClient) => Promise<{ error?: unknown; data?: unknown }>, done: string) => Promise<void>
}) {
  const [confirming, setConfirming] = createSignal(false)
  const id = () => props.document.id
  const act = (action: "approve" | "reject" | "reindex" | "pause" | "resume", done: string) =>
    props.change((client) => client.memory.documents.update({ documentID: id(), action }), done)

  return (
    <article
      class="settings-memory-row"
      classList={{ "is-waiting": statusTone(props.document) === "waiting" }}
      data-component="settings-memory-document"
      data-status={props.document.status}
    >
      <div class="settings-memory-row-head">
        <button type="button" class="settings-memory-doc-title" onClick={props.onOpen}>
          {props.document.title}
        </button>
        <span
          class="settings-memory-status"
          data-tone={statusTone(props.document)}
          data-component="settings-memory-document-status"
        >
          {statusLabel(props.document)}
        </span>
        <span class="settings-memory-tag" title={visibilityLabel(props.document.visibility)}>
          {props.document.visibility === "private" ? "Private" : "Repository"}
        </span>
        <span class="settings-memory-id">{props.document.id}</span>
      </div>
      <p class="settings-memory-meta">{documentMeta(props.document)}</p>
      <Show when={props.document.status !== "failed"}>
        <ol class="settings-memory-steps" aria-label="Progress">
          <For each={steps(props.document)}>
            {(step) => (
              <li class="settings-memory-step" data-state={step.state}>
                {step.label}
              </li>
            )}
          </For>
        </ol>
      </Show>
      <Show when={props.document.error}>
        <p class="settings-memory-error-line">{props.document.error}</p>
      </Show>
      <For each={props.document.warnings}>
        {(warning) => <p class="settings-memory-meta">{warningLabel(warning, props.document)}</p>}
      </For>

      <div class="settings-memory-actions">
        <Show
          when={!confirming()}
          fallback={
            <>
              <span class="settings-memory-confirm">{FORGET}</span>
              <ButtonV2
                size="small"
                variant="danger"
                onClick={async () => {
                  await props.change(
                    (client) => client.memory.documents.remove({ documentID: id() }),
                    forgottenLabel(props.document.title),
                  )
                  setConfirming(false)
                }}
              >
                Forget
              </ButtonV2>
              <ButtonV2 size="small" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </ButtonV2>
            </>
          }
        >
          <ButtonV2 size="small" variant="ghost" onClick={props.onOpen}>
            Open
          </ButtonV2>
          <Show when={approvable(props.document)}>
            <ButtonV2
              size="small"
              variant="outline"
              icon="check"
              onClick={() => act("approve", "Approved. Vector uses it now.")}
            >
              Approve
            </ButtonV2>
            <ButtonV2 size="small" variant="ghost" onClick={() => act("reject", "Rejected and forgotten.")}>
              Reject
            </ButtonV2>
          </Show>
          <Show when={pausable(props.document)}>
            <ButtonV2
              size="small"
              variant="ghost"
              onClick={() => act("pause", "Paused. What is read so far stays searchable.")}
            >
              Pause
            </ButtonV2>
          </Show>
          <Show when={resumable(props.document)}>
            <ButtonV2
              size="small"
              variant="ghost"
              onClick={() => act("resume", "Reading it again from where it stopped.")}
            >
              Resume
            </ButtonV2>
          </Show>
          <MenuV2 gutter={4} modal={false} placement="bottom-end">
            <MenuV2.Trigger
              as={IconButtonV2}
              variant="ghost-muted"
              size="small"
              icon={<Icon name="outline-dots" />}
              aria-label={`More for ${props.document.title}`}
            />
            <MenuV2.Portal>
              <MenuV2.Content>
                <MenuV2.Item
                  disabled={!reindexable(props.document)}
                  onSelect={() => act("reindex", "Reading it again. Your edits, pins and links carry over.")}
                >
                  Reindex
                </MenuV2.Item>
                <Show when={replaceable(props.document)}>
                  <MenuV2.Item onSelect={props.onReplace}>Replace…</MenuV2.Item>
                </Show>
                <MenuV2.Separator />
                <MenuV2.Item onSelect={() => setConfirming(true)}>Forget…</MenuV2.Item>
              </MenuV2.Content>
            </MenuV2.Portal>
          </MenuV2>
        </Show>
      </div>
    </article>
  )
}
