import type { VectorClient } from "@vectordevai/sdk/v2/client"
import { For, Show, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { Switch } from "@vectordevai/ui/v2/switch-v2"
import { getFilename } from "@vectordevai/core/util/path"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { LocalMemoryPanel } from "@/features/memory/local-memory-panel"
import { SettingsMemoryDocuments } from "./memory-documents"
import { SettingsMemorySearchModel } from "./memory-search-model"
import {
  MEMORY_FILTERS,
  MEMORY_KINDS,
  MEMORY_TABS,
  RECENT,
  approvable,
  editable,
  fileLabel,
  forgettable,
  holdLabel,
  kindLabel,
  originLabel,
  pinnable,
  rejectable,
  savedNotice,
  summary,
  UNDONE,
  usage,
  type MemoryEntryView,
  type MemoryFiles,
  type MemoryFilter,
  type MemoryTab,
} from "./memory-model"
import "./settings-memory.css"

type Scope = "repository" | "personal"

const PRIVATE = "Learned from a private document, so it is kept from guests and from models that may train on prompts."

// Settings > Memory: one place for what steers Vector. Rules people wrote and the user's MEMORY.md are shown as they
// are read (and changed in their files); what Vector learned is listed with where it came from, and can be searched,
// edited, pinned, approved, put away or forgotten. It replaces the Local memory card in General and the old rules page.
export function SettingsMemoryV2(props: { repositoryPath?: string; sessionDirectory?: string; tab?: MemoryTab }) {
  const global = useGlobal()
  const server = useServer()
  const directory = () => props.sessionDirectory ?? props.repositoryPath
  const [tab, setTab] = createSignal<MemoryTab>(props.tab ?? "memory")
  const [scope, setScope] = createSignal<Scope>(directory() ? "repository" : "personal")
  const [filter, setFilter] = createSignal<MemoryFilter>("active")
  const [query, setQuery] = createSignal("")
  const [search, setSearch] = createSignal("")
  const [version, setVersion] = createSignal(0)
  const [notice, setNotice] = createSignal("")
  const [error, setError] = createSignal("")
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))

  const client = createMemo((): VectorClient | undefined => {
    const conn = server.current
    if (!conn) return undefined
    const sdk = global.ensureServerCtx(conn).sdk
    const dir = directory()
    return sdk.createClient(dir ? { directory: dir } : {})
  })

  const [list] = createResource(
    () => {
      const current = client()
      if (!current) return false
      return { client: current, scope: scope(), filter: filter(), query: search(), version: version() }
    },
    (input) =>
      input.client.memory
        .list({ scope: input.scope, filter: input.filter, ...(input.query ? { query: input.query } : {}) })
        .then((result) => result.data),
  )
  // What Vector put in use on its own, in this repository and about the user, newest first.
  const [learned] = createResource(
    () => {
      const current = client()
      if (!current) return false
      return { client: current, version: version() }
    },
    (input) => input.client.memory.list({ filter: "learned" }).then((result) => result.data),
  )
  const [settings, { mutate: setSettings }] = createResource(
    () => client() ?? false,
    (current) => current.memory.settings.get().then((result) => result.data),
  )

  const refresh = () => setVersion((value) => value + 1)
  const say = (message: string) => {
    setError("")
    setNotice(message)
  }
  // Every change goes through the engine, which applies the same checks to the user's edits as to the agent's. What
  // the page says afterwards can depend on what the engine answered.
  const act = async <T,>(
    run: (current: VectorClient) => Promise<{ error?: unknown; data?: T }>,
    done: string | ((data: T | undefined) => string),
  ) => {
    const current = client()
    if (!current) return
    const result = await run(current).catch((cause: unknown) => ({ error: cause, data: undefined }))
    if (result.error) {
      setNotice("")
      setError(errorMessage(result.error))
      return
    }
    say(typeof done === "string" ? done : done(result.data))
    refresh()
  }

  const entries = (): readonly MemoryEntryView[] => list.latest?.entries ?? []
  const files = (): MemoryFiles | undefined => list.latest?.files

  return (
    <section class="settings-v2-page settings-memory">
      <div class="settings-v2-page-hero">
        <div>
          <p class="settings-v2-page-kicker">Memory</p>
          <h2 class="settings-v2-page-title">What Vector remembers</h2>
          <p class="settings-v2-page-subtitle">
            The rules you and your team wrote, what you told Vector about yourself, what it learned while working, and
            the documents you gave it. All of it stays on this computer. A request carries your rules and only the
            memory that bears on it, so memory saves tokens instead of adding them, and a greeting carries none.
          </p>
        </div>
      </div>

      <div class="settings-memory-segments settings-memory-tabs" role="tablist" aria-label="Memory sections">
        <For each={MEMORY_TABS}>
          {(item) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab() === item.value}
              classList={{ "is-active": tab() === item.value }}
              data-tab={item.value}
              onClick={() => setTab(item.value)}
            >
              {item.label}
            </button>
          )}
        </For>
      </div>

      <Show when={tab() === "documents"}>
        <SettingsMemoryDocuments client={client} repository={!!directory()} onModel={() => setTab("model")} />
      </Show>

      <Show when={tab() === "model"}>
        <SettingsMemorySearchModel client={client} />
      </Show>

      <Show when={tab() === "memory"}>
        <div class="settings-v2-card settings-v2-card--wide">
          <div class="settings-v2-card-head">
            <div class="settings-v2-card-copy">
              <h3 class="settings-v2-card-title">
                {scope() === "repository" ? getFilename(directory() ?? "") || "This repository" : "Your memory"}
              </h3>
              <p class="settings-v2-card-description">
                <Show when={list.latest} fallback={list.loading ? "Reading memory…" : "Memory is not available."}>
                  {(current) => <>{summary(current().stats)}</>}
                </Show>
              </p>
            </div>
          </div>
          <div class="settings-v2-card-body">
            <div class="settings-v2-row-modern">
              <div class="settings-v2-row-copy">
                <div class="settings-v2-row-title">Let Vector learn as it works</div>
                <div class="settings-v2-row-description">
                  Vector saves a short lesson, decision or preference as it works, when you state one, when a fix makes
                  a failing check pass, or when a lasting decision is made, and uses it from the next request. Each one
                  is listed under Recently learned, where one click undoes it. It never writes rules: only you do. What
                  it learns in a session that read web pages or other outside content, ran MCP tools, or had a guest or
                  a subagent in it waits for your review instead.
                </div>
              </div>
              <div class="settings-v2-row-control settings-v2-row-control--compact">
                <Switch
                  checked={settings.latest?.learning ?? true}
                  onChange={(learning) => {
                    setSettings((current) => current && { ...current, learning })
                    void act(
                      (current) => current.memory.settings.update({ learning }),
                      learning ? "Vector will learn as it works." : "Vector will not add to its memory.",
                    )
                  }}
                />
              </div>
            </div>
            <Show when={list.latest?.held}>
              <p class="settings-memory-warning">
                This repository has settings you have not trusted, so memory it ships (its BRAIN.md) waits for review.
                Trust it in Repository trust to use that memory.
              </p>
            </Show>
          </div>
        </div>

        <RecentlyLearned entries={learned.latest?.entries ?? []} act={act} />

        <div class="settings-v2-card settings-v2-card--wide">
          <div class="settings-memory-toolbar">
            <div class="settings-memory-segments" role="tablist" aria-label="Whose memory">
              <Show when={directory()}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={scope() === "repository"}
                  classList={{ "is-active": scope() === "repository" }}
                  onClick={() => setScope("repository")}
                >
                  This repository
                </button>
              </Show>
              <button
                type="button"
                role="tab"
                aria-selected={scope() === "personal"}
                classList={{ "is-active": scope() === "personal" }}
                onClick={() => setScope("personal")}
              >
                About you
              </button>
            </div>
            <div class="settings-memory-segments" role="tablist" aria-label="Which entries">
              <For each={MEMORY_FILTERS}>
                {(item) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={filter() === item.value}
                    classList={{ "is-active": filter() === item.value }}
                    onClick={() => setFilter(item.value)}
                  >
                    {item.label}
                    <Show when={item.value === "review" && (list.latest?.stats.review ?? 0) > 0}>
                      <span class="settings-memory-count">{list.latest?.stats.review}</span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
            <input
              class="settings-memory-search"
              type="search"
              placeholder="Search memory"
              aria-label="Search memory"
              value={query()}
              onInput={(event) => {
                const value = event.currentTarget.value
                setQuery(value)
                clearTimeout(timer)
                timer = setTimeout(() => setSearch(value.trim()), 200)
              }}
            />
          </div>

          <AddMemory
            scope={scope()}
            onAdd={(input) =>
              act(
                (current) => current.memory.create({ ...input, scope: scope() }),
                (entry) => (entry ? savedNotice(entry, input.text) : "Saved. Vector will use it when it is relevant."),
              )
            }
          />

          <Show when={notice()}>
            <p class="settings-memory-notice" role="status">
              {notice()}
            </p>
          </Show>
          <Show when={error()}>
            <p class="settings-memory-error" role="alert">
              {error()}
            </p>
          </Show>

          <div class="settings-memory-list">
            <Show
              when={entries().length > 0}
              fallback={
                <p class="settings-memory-empty">
                  {filter() === "review"
                    ? "Nothing waits for your review."
                    : search()
                      ? "Nothing in memory matches."
                      : scope() === "repository"
                        ? "Nothing remembered for this repository yet. Rules in .vector/RULES.md and what Vector learns here show up in this list."
                        : "Nothing remembered about you yet. Add a preference above, or write it in your memory file below."}
                </p>
              }
            >
              <For each={entries()}>
                {(entry) => <MemoryRow entry={entry} files={files()} root={directory()} act={act} />}
              </For>
            </Show>
          </div>
        </div>

        <Show when={scope() === "personal"}>
          <LocalMemoryPanel />
        </Show>

        <EraseCard scope={scope()} repository={!!directory()} act={act} />
      </Show>
    </section>
  )
}

function RecentlyLearned(props: {
  entries: readonly MemoryEntryView[]
  act: (run: (current: VectorClient) => Promise<{ error?: unknown }>, done: string) => Promise<void>
}) {
  const [all, setAll] = createSignal(false)
  const shown = () => (all() ? props.entries : props.entries.slice(0, RECENT))
  return (
    <div class="settings-v2-card settings-v2-card--wide" data-component="settings-memory-learned">
      <div class="settings-v2-card-head">
        <div class="settings-v2-card-copy">
          <h3 class="settings-v2-card-title">Recently learned</h3>
          <p class="settings-v2-card-description">
            What Vector put in use on its own, newest first. Undo takes one back, and Vector does not learn it again.
          </p>
        </div>
      </div>
      <div class="settings-v2-card-body">
        <Show
          when={props.entries.length > 0}
          fallback={<p class="settings-memory-empty">Vector has not learned anything on its own yet.</p>}
        >
          <div class="settings-memory-list">
            <For each={shown()}>
              {(entry) => (
                <article class="settings-memory-row" data-component="settings-memory-learned-entry">
                  <div class="settings-memory-row-head">
                    <span class="settings-memory-kind-badge" data-kind={entry.kind}>
                      {kindLabel(entry.kind)}
                    </span>
                    <Show when={entry.scope === "personal"}>
                      <span class="settings-memory-tag">Every repository</span>
                    </Show>
                    <Show when={entry.private}>
                      <span class="settings-memory-tag" title={PRIVATE}>
                        Private
                      </span>
                    </Show>
                    <span class="settings-memory-id">{entry.id}</span>
                  </div>
                  <p class="settings-memory-text">{entry.text}</p>
                  <div class="settings-memory-actions">
                    <ButtonV2
                      size="small"
                      variant="ghost"
                      icon="reset"
                      onClick={() =>
                        props.act((current) => current.memory.update({ memoryID: entry.id, action: "undo" }), UNDONE)
                      }
                    >
                      Undo
                    </ButtonV2>
                  </div>
                </article>
              )}
            </For>
          </div>
          <Show when={props.entries.length > shown().length}>
            <ButtonV2 size="small" variant="ghost" onClick={() => setAll(true)}>
              Show all {props.entries.length}
            </ButtonV2>
          </Show>
        </Show>
      </div>
    </div>
  )
}

function AddMemory(props: {
  scope: Scope
  onAdd: (input: { kind: "preference" | "decision" | "lesson" | "fact"; text: string }) => Promise<void>
}) {
  const [text, setText] = createSignal("")
  const [kind, setKind] = createSignal<"preference" | "decision" | "lesson" | "fact">("lesson")
  const [busy, setBusy] = createSignal(false)
  const submit = async () => {
    if (!text().trim() || busy()) return
    setBusy(true)
    await props.onAdd({ kind: props.scope === "personal" ? "preference" : kind(), text: text().trim() })
    setBusy(false)
    setText("")
  }
  return (
    <form
      class="settings-memory-add"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <Show when={props.scope === "repository"}>
        <select
          class="settings-memory-kind"
          aria-label="Kind of memory"
          value={kind()}
          onChange={(event) => setKind(event.currentTarget.value as "preference" | "decision" | "lesson" | "fact")}
        >
          <For each={MEMORY_KINDS}>{(item) => <option value={item.value}>{item.label}</option>}</For>
        </select>
      </Show>
      <input
        class="settings-memory-input"
        placeholder={
          props.scope === "personal"
            ? "Something about how you work, for every repository"
            : "Something Vector should remember about this repository"
        }
        aria-label="New memory"
        maxlength={1000}
        value={text()}
        onInput={(event) => setText(event.currentTarget.value)}
      />
      <ButtonV2 type="submit" variant="outline" icon="plus" disabled={busy() || !text().trim()}>
        Remember
      </ButtonV2>
    </form>
  )
}

function MemoryRow(props: {
  entry: MemoryEntryView
  files?: MemoryFiles
  root?: string
  act: (run: (current: VectorClient) => Promise<{ error?: unknown }>, done: string) => Promise<void>
}) {
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [confirming, setConfirming] = createSignal(false)
  const id = () => props.entry.id
  const update = (
    change: { text?: string; pinned?: boolean; action?: "approve" | "reject" | "archive" | "restore" },
    done: string,
  ) => props.act((current) => current.memory.update({ memoryID: id(), ...change }), done)
  const waiting = () => props.entry.status === "proposed" || props.entry.status === "quarantined"

  return (
    <article
      class="settings-memory-row"
      classList={{
        "is-waiting": waiting(),
        "is-off": props.entry.status === "archived" || props.entry.status === "superseded",
      }}
      data-component="settings-memory-entry"
    >
      <div class="settings-memory-row-head">
        <span class="settings-memory-kind-badge" data-kind={props.entry.kind}>
          {kindLabel(props.entry.kind)}
        </span>
        <Show when={props.entry.pinned}>
          <span class="settings-memory-tag">Pinned</span>
        </Show>
        <Show when={props.entry.scope === "personal"}>
          <span class="settings-memory-tag">Every repository</span>
        </Show>
        <Show when={props.entry.private}>
          <span class="settings-memory-tag" title={PRIVATE}>
            Private
          </span>
        </Show>
        <Show when={props.entry.stale}>
          <span class="settings-memory-tag settings-memory-tag--warn">Its cited code changed</span>
        </Show>
        <span class="settings-memory-id">{props.entry.id}</span>
      </div>

      <Show when={editing()} fallback={<p class="settings-memory-text">{props.entry.text}</p>}>
        <textarea
          class="settings-memory-edit"
          aria-label="Edit memory"
          maxlength={1000}
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
      </Show>

      <p class="settings-memory-meta">
        {originLabel(props.entry, props.files)}
        <Show when={props.entry.paths.length > 0 && props.entry.kind !== "rule"}>
          {" "}
          · about {props.entry.paths.slice(0, 3).join(", ")}
        </Show>
        <Show when={props.entry.kind === "review"}> · only code reviews read this</Show> · {usage(props.entry)}
      </p>
      <Show when={waiting()}>
        <p class="settings-memory-hold">{holdLabel(props.entry.hold)}</p>
      </Show>

      <div class="settings-memory-actions">
        <Show when={editing()}>
          <ButtonV2
            size="small"
            disabled={!draft().trim()}
            onClick={async () => {
              await update({ text: draft() }, "Saved your edit.")
              setEditing(false)
            }}
          >
            Save
          </ButtonV2>
          <ButtonV2 size="small" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </ButtonV2>
        </Show>
        <Show when={!editing() && !confirming()}>
          <Show when={approvable(props.entry)}>
            <ButtonV2
              size="small"
              variant="outline"
              icon="check"
              onClick={() => update({ action: "approve" }, "Approved. Vector will use it.")}
            >
              Approve
            </ButtonV2>
          </Show>
          <Show when={rejectable(props.entry)}>
            <ButtonV2
              size="small"
              variant="ghost"
              onClick={() => update({ action: "reject" }, "Rejected and forgotten.")}
            >
              Reject
            </ButtonV2>
          </Show>
          <Show when={pinnable(props.entry)}>
            <ButtonV2
              size="small"
              variant="ghost"
              onClick={() =>
                update(
                  { pinned: !props.entry.pinned },
                  props.entry.pinned ? "Unpinned." : "Pinned: it now goes with every request.",
                )
              }
            >
              {props.entry.pinned ? "Unpin" : "Pin"}
            </ButtonV2>
          </Show>
          <Show when={editable(props.entry)}>
            <ButtonV2
              size="small"
              variant="ghost"
              icon="edit"
              onClick={() => {
                setDraft(props.entry.text)
                setEditing(true)
              }}
            >
              Edit
            </ButtonV2>
          </Show>
          <Show when={editable(props.entry) && props.entry.status === "active"}>
            <ButtonV2
              size="small"
              variant="ghost"
              icon="archive"
              onClick={() => update({ action: "archive" }, "Archived. Restore it any time.")}
            >
              Archive
            </ButtonV2>
          </Show>
          <Show
            when={editable(props.entry) && (props.entry.status === "archived" || props.entry.status === "superseded")}
          >
            <ButtonV2
              size="small"
              variant="ghost"
              icon="reset"
              onClick={() => update({ action: "restore" }, "Restored.")}
            >
              Restore
            </ButtonV2>
          </Show>
          <Show when={forgettable(props.entry)}>
            <ButtonV2 size="small" variant="ghost" onClick={() => setConfirming(true)}>
              Forget
            </ButtonV2>
          </Show>
          <Show when={!editable(props.entry) && props.entry.origin === "file"}>
            <span class="settings-memory-file-hint">
              Change it in{" "}
              {props.entry.source ? fileLabel(props.entry.source.file, props.files, props.root) : "its file"}
            </span>
          </Show>
        </Show>
        <Show when={confirming()}>
          <span class="settings-memory-confirm">Forget this for good? Vector will not learn it again.</span>
          <ButtonV2
            size="small"
            variant="danger"
            onClick={async () => {
              await props.act((current) => current.memory.remove({ memoryID: id() }), "Forgotten.")
              setConfirming(false)
            }}
          >
            Forget
          </ButtonV2>
          <ButtonV2 size="small" variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </ButtonV2>
        </Show>
      </div>
    </article>
  )
}

function EraseCard(props: {
  scope: Scope
  repository: boolean
  act: (run: (current: VectorClient) => Promise<{ error?: unknown }>, done: string) => Promise<void>
}) {
  const [confirming, setConfirming] = createSignal<"repository" | "personal" | "all" | undefined>()
  const what = (scope: "repository" | "personal" | "all") =>
    scope === "all"
      ? "everything Vector learned, in every repository and about you"
      : scope === "personal"
        ? "everything Vector learned about you"
        : "everything Vector learned in this repository, its failure memory included"
  return (
    <div class="settings-v2-card settings-v2-card--wide">
      <div class="settings-v2-card-head">
        <div class="settings-v2-card-copy">
          <h3 class="settings-v2-card-title">Tidy and erase</h3>
          <p class="settings-v2-card-description">
            Vector tidies its memory on its own every few hours, with no model call: it merges duplicates, archives what
            goes unused, and drops what waited for your review for 30 days. Erasing never touches files you or your team
            wrote.
          </p>
        </div>
      </div>
      <div class="settings-v2-card-body">
        <Show
          when={confirming()}
          fallback={
            <div class="settings-v2-action-grid">
              <ButtonV2
                variant="outline"
                onClick={() =>
                  props.act(
                    (current) => current.memory.tidy(),
                    "Tidied: duplicates merged and unused entries archived.",
                  )
                }
              >
                Tidy now
              </ButtonV2>
              <Show when={props.repository}>
                <ButtonV2 variant="outline" onClick={() => setConfirming("repository")}>
                  Erase what Vector learned here
                </ButtonV2>
              </Show>
              <ButtonV2 variant="outline" onClick={() => setConfirming("personal")}>
                Erase what Vector learned about you
              </ButtonV2>
              <ButtonV2 variant="danger" onClick={() => setConfirming("all")}>
                Erase all learned memory
              </ButtonV2>
            </div>
          }
        >
          {(scope) => (
            <div class="settings-memory-erase">
              <p>This erases {what(scope())}. Vector cannot restore it.</p>
              <div class="settings-v2-action-grid">
                <ButtonV2
                  variant="danger"
                  onClick={async () => {
                    await props.act((current) => current.memory.erase({ scope: scope() }), "Erased.")
                    setConfirming(undefined)
                  }}
                >
                  Erase
                </ButtonV2>
                <ButtonV2 variant="ghost" onClick={() => setConfirming(undefined)}>
                  Cancel
                </ButtonV2>
              </div>
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}

function errorMessage(error: unknown) {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { message?: unknown } }).data
    if (typeof data?.message === "string") return data.message
  }
  if (error instanceof Error) return error.message
  return "Vector could not change its memory. Try again in a moment."
}
