import type { MemoryAnchor, MemoryDistillEstimate, MemoryRecord, VectorClient } from "@vectordevai/sdk/v2/client"
import { For, Show, createMemo, createResource, createSignal } from "solid-js"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import {
  DISTILL,
  FORGET,
  RECORD_KINDS,
  anchorLine,
  approvable,
  codeLinks,
  distilledLabel,
  distillEstimateLabel,
  evidence,
  documentHoldLabel,
  documentMeta,
  forgottenLabel,
  heldLabel,
  highlight,
  historyDate,
  historyLine,
  kindCounts,
  notApplicableLabel,
  outlineRows,
  pageHeading,
  recordKindLabel,
  recordPlace,
  recordStatusLabel,
  recordUsage,
  refusal,
  statusLabel,
  statusTone,
  steps,
  suggestedBy,
  suggestion,
  suggestionsLabel,
  usageLabel,
  versionDiffLabel,
  visibilityLabel,
  warningLabel,
  type RecordKind,
} from "./memory-documents-model"

type View = "learned" | "outline" | "pages" | "links" | "history"

// One document as Vector read it: what it learned (records by kind, each editable), its outline with pages, and its
// pages as extracted text with the records marked. The app never renders the original file; it shows what was read.
export function MemoryDocumentPage(props: {
  client: () => VectorClient | undefined
  documentID: string
  onBack: () => void
}) {
  const [view, setView] = createSignal<View>("learned")
  const [version, setVersion] = createSignal(0)
  const [kind, setKind] = createSignal<RecordKind>()
  const [page, setPage] = createSignal(1)
  const [notice, setNotice] = createSignal("")
  const [error, setError] = createSignal("")
  const [extra, setExtra] = createSignal<{ records: MemoryRecord[]; cursor?: string }>({ records: [] })
  const refresh = () => setVersion((value) => value + 1)

  const [detail] = createResource(
    () => {
      const client = props.client()
      return client ? { client, id: props.documentID, version: version() } : false
    },
    (input) => input.client.memory.documents.get({ documentID: input.id }).then((result) => result.data),
  )
  // The first records come with the document; a kind filter or "Show more" pages through the rest.
  const [filtered] = createResource(
    () => {
      const client = props.client()
      const current = kind()
      return client && current ? { client, kind: current, version: version() } : false
    },
    (input) =>
      input.client.memory.records
        .list({ document: props.documentID, kind: input.kind, status: "all", limit: "50" })
        .then((result) => result.data),
  )
  const [shown] = createResource(
    () => {
      const client = props.client()
      const document = detail.latest?.document
      return client && view() === "pages" && document?.pages ? { client, page: page(), version: version() } : false
    },
    (input) =>
      input.client.memory.documents
        .page({ documentID: props.documentID, page: String(input.page) })
        .then((result) => result.data),
  )

  // What a model suggested for the document and the user has not looked at yet.
  const [held] = createResource(
    () => {
      const client = props.client()
      return client ? { client, version: version() } : false
    },
    (input) =>
      input.client.memory.records
        .list({ document: props.documentID, status: "held", limit: "100" })
        .then((result) => result.data),
  )
  const suggested = createMemo(() => (held.latest?.records ?? []).filter(suggestion))
  const [reviewing, setReviewing] = createSignal(false)

  const records = createMemo(() => {
    const first = kind() ? filtered.latest : detail.latest?.records
    return [...(first?.records ?? []), ...extra().records]
  })
  const cursor = () =>
    extra().records.length ? extra().cursor : (kind() ? filtered.latest : detail.latest?.records)?.cursor
  const anchors = (record: string) => (detail.latest?.anchors ?? []).filter((anchor) => anchor.owner === record)

  const say = (message: string) => {
    setError("")
    setNotice(message)
  }
  const change = async (run: (client: VectorClient) => Promise<{ error?: unknown; data?: unknown }>, done: string) => {
    const client = props.client()
    if (!client) return false
    const result = await run(client).catch((cause: unknown) => ({ error: cause, data: undefined }))
    if (result.error) {
      setNotice("")
      setError(refusal(result.error).message ?? "Vector could not change this. Try again in a moment.")
      return false
    }
    say(done)
    setExtra({ records: [] })
    refresh()
    return true
  }

  const more = async () => {
    const client = props.client()
    const at = cursor()
    if (!client || !at) return
    const result = await client.memory.records.list({
      document: props.documentID,
      ...(kind() ? { kind: kind() } : {}),
      status: "all",
      cursor: at,
      limit: "50",
    })
    if (result.data)
      setExtra((current) => ({ records: [...current.records, ...result.data.records], cursor: result.data.cursor }))
  }

  return (
    <div class="settings-v2-card settings-v2-card--wide" data-component="settings-memory-document-page">
      <div class="settings-memory-document-head">
        <ButtonV2 size="small" variant="ghost" icon="reset" onClick={props.onBack}>
          All documents
        </ButtonV2>
      </div>
      <Show
        when={detail.latest}
        fallback={
          <p class="settings-memory-empty settings-memory-pad">
            {detail.loading ? "Reading…" : "This document is gone."}
          </p>
        }
      >
        {(current) => (
          <>
            <div class="settings-v2-card-head">
              <div class="settings-v2-card-copy">
                <h3 class="settings-v2-card-title">
                  {current().document.title}{" "}
                  <span class="settings-memory-status" data-tone={statusTone(current().document)}>
                    {statusLabel(current().document)}
                  </span>
                </h3>
                <p class="settings-v2-card-description">{documentMeta(current().document)}</p>
                <p class="settings-v2-card-description">{visibilityLabel(current().document.visibility)}</p>
                <Show when={current().diff}>
                  {(diff) => <p class="settings-v2-card-description">{versionDiffLabel(diff())}</p>}
                </Show>
              </div>
            </div>
            <div class="settings-v2-card-body">
              <ol class="settings-memory-steps" aria-label="Progress">
                <For each={steps(current().document)}>
                  {(step) => (
                    <li class="settings-memory-step" data-state={step.state}>
                      {step.label}
                    </li>
                  )}
                </For>
              </ol>
              <For each={current().warnings}>
                {(warning) => <p class="settings-memory-meta">{warningLabel(warning, current().document)}</p>}
              </For>
              <Show when={current().held.length > 0}>
                <p class="settings-memory-hold">{heldLabel(current().held, !!current().document.pages)}</p>
              </Show>
              <Show when={approvable(current().document)}>
                <div class="settings-memory-actions">
                  <ButtonV2
                    size="small"
                    variant="outline"
                    icon="check"
                    onClick={() =>
                      change(
                        (client) => client.memory.documents.update({ documentID: props.documentID, action: "approve" }),
                        "Approved. Vector uses it now.",
                      )
                    }
                  >
                    Approve
                  </ButtonV2>
                  <ButtonV2
                    size="small"
                    variant="ghost"
                    onClick={async () => {
                      if (
                        await change(
                          (client) =>
                            client.memory.documents.update({ documentID: props.documentID, action: "reject" }),
                          forgottenLabel(current().document.title),
                        )
                      )
                        props.onBack()
                    }}
                  >
                    Reject
                  </ButtonV2>
                </div>
              </Show>
            </div>

            <div class="settings-memory-toolbar">
              <div class="settings-memory-segments" role="tablist" aria-label="What to show">
                <For
                  each={
                    [
                      ["learned", "Learned"],
                      ["outline", "Outline"],
                      ["pages", "Pages"],
                      ["links", "Code links"],
                      ["history", "History"],
                    ] as const
                  }
                >
                  {([value, label]) => (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={view() === value}
                      classList={{ "is-active": view() === value }}
                      onClick={() => setView(value)}
                    >
                      {label}
                    </button>
                  )}
                </For>
              </div>
            </div>

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

            <Show when={view() === "learned"}>
              <p class="settings-memory-meta settings-memory-pad">{kindCounts(current().document.stats.kinds)}</p>
              <Show when={current().distill}>
                <FindMore
                  client={props.client}
                  documentID={props.documentID}
                  onDone={(message) => {
                    say(message)
                    setReviewing(true)
                    setExtra({ records: [] })
                    refresh()
                  }}
                  onError={(message) => {
                    setNotice("")
                    setError(message)
                  }}
                />
              </Show>
              <Show when={suggested().length > 0}>
                <div class="settings-memory-list" data-component="settings-memory-suggestions">
                  <div class="settings-memory-row is-waiting">
                    <div class="settings-memory-row-head">
                      <span>{suggestionsLabel(suggested().length, suggestedBy(current().history))}</span>
                    </div>
                    <div class="settings-memory-actions">
                      <ButtonV2
                        size="small"
                        variant="outline"
                        icon="check"
                        onClick={() =>
                          change(
                            (client) =>
                              client.memory.documents.update({ documentID: props.documentID, action: "keep-suggestions" }),
                            "Kept. Vector uses them now.",
                          )
                        }
                      >
                        Keep all
                      </ButtonV2>
                      <ButtonV2 size="small" variant="ghost" onClick={() => setReviewing(!reviewing())}>
                        {reviewing() ? "Hide" : "Review"}
                      </ButtonV2>
                    </div>
                  </div>
                  <Show when={reviewing()}>
                    <For each={suggested()}>
                      {(record) => <RecordCard record={record} anchors={anchors(record.id)} change={change} />}
                    </For>
                  </Show>
                </div>
              </Show>
              <div class="settings-memory-segments settings-memory-kinds" role="tablist" aria-label="Kind of record">
                <button
                  type="button"
                  role="tab"
                  aria-selected={!kind()}
                  classList={{ "is-active": !kind() }}
                  onClick={() => {
                    setExtra({ records: [] })
                    setKind(undefined)
                  }}
                >
                  All
                </button>
                <For each={RECORD_KINDS.filter((item) => (current().document.stats.kinds[item] ?? 0) > 0)}>
                  {(item) => (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={kind() === item}
                      classList={{ "is-active": kind() === item }}
                      onClick={() => {
                        setExtra({ records: [] })
                        setKind(item)
                      }}
                    >
                      {recordKindLabel(item, true)}
                      <span class="settings-memory-count">{current().document.stats.kinds[item]}</span>
                    </button>
                  )}
                </For>
              </div>
              <div class="settings-memory-list">
                <Show
                  when={records().length > 0}
                  fallback={
                    <p class="settings-memory-empty">
                      {current().document.status === "queued" || current().document.status === "reading"
                        ? "Vector is still reading it."
                        : "Vector found no requirements, limits, decisions, contracts or other records in it. Its passages are still searchable."}
                    </p>
                  }
                >
                  <For each={records()}>
                    {(record) => <RecordCard record={record} anchors={anchors(record.id)} change={change} />}
                  </For>
                </Show>
                <Show when={cursor()}>
                  <ButtonV2 size="small" variant="ghost" onClick={() => void more()}>
                    Show more
                  </ButtonV2>
                </Show>
              </div>
            </Show>

            <Show when={view() === "outline"}>
              <div class="settings-memory-list">
                <Show
                  when={current().outline.length > 0}
                  fallback={
                    <p class="settings-memory-empty">
                      It has no headings Vector could find, so it reads as one section.
                    </p>
                  }
                >
                  <ol class="settings-memory-outline">
                    <For each={outlineRows(current(), current().document.unread)}>
                      {(row) => (
                        <li style={{ "padding-left": `${row.level * 16}px` }}>
                          <button
                            type="button"
                            class="settings-memory-outline-row"
                            disabled={!row.pages || !current().document.pages}
                            onClick={() => {
                              const start = /\d+/.exec(row.pages)?.[0]
                              if (!start) return
                              setPage(Number(start))
                              setView("pages")
                            }}
                          >
                            <span>{row.heading}</span>
                            <span class="settings-memory-outline-pages">{row.pages}</span>
                            <Show when={row.unread}>
                              <span class="settings-memory-tag settings-memory-tag--warn">Unread pages</span>
                            </Show>
                          </button>
                        </li>
                      )}
                    </For>
                  </ol>
                </Show>
              </div>
            </Show>

            <Show when={view() === "pages"}>
              <div class="settings-memory-list">
                <Show
                  when={current().document.pages}
                  fallback={
                    <p class="settings-memory-empty">
                      This kind of document has no pages. Its sections are under Outline and what Vector learned from it
                      under Learned.
                    </p>
                  }
                >
                  {(pages) => (
                    <>
                      <div class="settings-memory-pager">
                        <ButtonV2
                          size="small"
                          variant="ghost"
                          disabled={page() <= 1}
                          onClick={() => setPage(page() - 1)}
                        >
                          Previous
                        </ButtonV2>
                        <span>
                          Page{" "}
                          <input
                            class="settings-memory-page-input"
                            type="number"
                            min="1"
                            max={pages()}
                            aria-label="Page"
                            value={page()}
                            onChange={(event) => {
                              const value = Math.round(Number(event.currentTarget.value))
                              if (value >= 1 && value <= pages()) setPage(value)
                            }}
                          />{" "}
                          of {pages()}
                        </span>
                        <ButtonV2
                          size="small"
                          variant="ghost"
                          disabled={page() >= pages()}
                          onClick={() => setPage(page() + 1)}
                        >
                          Next
                        </ButtonV2>
                      </div>
                      <Show
                        when={shown.latest}
                        fallback={
                          <p class="settings-memory-empty">
                            {shown.loading ? "Reading the page…" : "This page has no text."}
                          </p>
                        }
                      >
                        {(view) => (
                          <div class="settings-memory-page" data-component="settings-memory-page">
                            <p class="settings-memory-meta">{pageHeading(view())}</p>
                            <For each={view().passages}>
                              {(passage) => (
                                <section class="settings-memory-passage" classList={{ "is-held": !!passage.hold }}>
                                  <Show when={passage.section}>
                                    <p class="settings-memory-passage-section">{passage.section}</p>
                                  </Show>
                                  <Show when={passage.hold}>
                                    <p class="settings-memory-hold">
                                      Held for your review: {documentHoldLabel(passage.hold)}. It never reaches the
                                      agent.
                                    </p>
                                  </Show>
                                  <p class="settings-memory-passage-text">
                                    <For each={highlight(passage)}>
                                      {(span) => (
                                        <Show when={span.record} fallback={<>{span.text}</>}>
                                          {(mark) => (
                                            <mark
                                              data-kind={mark().kind}
                                              title={`${recordKindLabel(mark().kind)} ${mark().id}`}
                                            >
                                              {span.text}
                                            </mark>
                                          )}
                                        </Show>
                                      )}
                                    </For>
                                  </p>
                                </section>
                              )}
                            </For>
                          </div>
                        )}
                      </Show>
                    </>
                  )}
                </Show>
              </div>
            </Show>

            <Show when={view() === "history"}>
              <div class="settings-memory-list" data-component="settings-memory-history">
                <p class="settings-memory-meta">{usageLabel(current().usage)}</p>
                <Show
                  when={current().history.length > 0}
                  fallback={<p class="settings-memory-empty">Nothing has happened to it yet.</p>}
                >
                  <For each={current().history}>
                    {(event) => (
                      <div class="settings-memory-row">
                        <div class="settings-memory-row-head">
                          <span class="settings-memory-tag">{historyDate(event.at)}</span>
                          <span>{historyLine(event)}</span>
                          <Show when={event.record}>
                            <span class="settings-memory-id">{event.record}</span>
                          </Show>
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </Show>

            <Show when={view() === "links"}>
              <div class="settings-memory-list" data-component="settings-memory-code-links">
                <Show
                  when={current().anchors.length > 0}
                  fallback={
                    <p class="settings-memory-empty">
                      Nothing in it is linked to this repository's code yet. Vector links a record when the code
                      defines, uses or serves what it names; link one yourself with Link to file… under Learned.
                    </p>
                  }
                >
                  <For each={codeLinks(current().anchors, records())}>
                    {(group) => (
                      <article class="settings-memory-row">
                        <div class="settings-memory-row-head">
                          <Show when={group.record}>
                            {(record) => (
                              <span class="settings-memory-kind-badge" data-kind={record().kind}>
                                {recordKindLabel(record().kind)}
                              </span>
                            )}
                          </Show>
                          <span class="settings-memory-id">{group.owner}</span>
                        </div>
                        <Show when={group.record}>
                          {(record) => (
                            <p class="settings-memory-text">
                              <For each={evidence(record().card, group.anchors[0]?.symbol)}>
                                {(span) => (span.mark ? <mark>{span.text}</mark> : <>{span.text}</>)}
                              </For>
                            </p>
                          )}
                        </Show>
                        <For each={group.anchors}>
                          {(anchor) => (
                            <div class="settings-memory-actions">
                              <span class="settings-memory-meta">{anchorLine(anchor)}</span>
                              <Show when={group.record}>
                                <ButtonV2
                                  size="small"
                                  variant="ghost"
                                  onClick={() =>
                                    change(
                                      (client) => client.memory.records.update({ recordID: group.owner, unlink: anchor.id }),
                                      "Unlinked. Vector does not link it there again.",
                                    )
                                  }
                                >
                                  Unlink
                                </ButtonV2>
                              </Show>
                            </div>
                          )}
                        </For>
                      </article>
                    )}
                  </For>
                </Show>
              </div>
            </Show>

            <ForgetDocument
              title={current().document.title}
              documentID={props.documentID}
              change={change}
              onGone={props.onBack}
            />
          </>
        )}
      </Show>
    </div>
  )
}

function RecordCard(props: {
  record: MemoryRecord
  anchors: readonly MemoryAnchor[]
  change: (
    run: (client: VectorClient) => Promise<{ error?: unknown; data?: unknown }>,
    done: string,
  ) => Promise<boolean>
}) {
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [linking, setLinking] = createSignal(false)
  const [file, setFile] = createSignal("")
  const [symbol, setSymbol] = createSignal("")
  const update = (
    patch: { text?: string; pinned?: boolean; action?: "not-applicable" | "forget" | "restore" | "make-memory" },
    done: string,
  ) => props.change((client) => client.memory.records.update({ recordID: props.record.id, ...patch }), done)
  const active = () => props.record.status === "active"

  return (
    <article
      class="settings-memory-row"
      classList={{
        "is-waiting": props.record.status === "proposed" || props.record.status === "quarantined",
        "is-off": props.record.status === "archived",
      }}
      data-component="settings-memory-record"
    >
      <div class="settings-memory-row-head">
        <span class="settings-memory-kind-badge" data-kind={props.record.kind}>
          {recordKindLabel(props.record.kind)}
        </span>
        <Show when={recordPlace(props.record)}>
          <span class="settings-memory-tag">{recordPlace(props.record)}</span>
        </Show>
        <Show when={recordStatusLabel(props.record)}>
          <span class="settings-memory-tag">{recordStatusLabel(props.record)}</span>
        </Show>
        <span class="settings-memory-id">{props.record.id}</span>
      </div>
      <Show when={editing()} fallback={<p class="settings-memory-text">{props.record.card}</p>}>
        <textarea
          class="settings-memory-edit"
          aria-label="Edit record"
          maxlength={1000}
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
      </Show>
      <Show when={props.record.quote && props.record.quote !== props.record.card}>
        <p class="settings-memory-quote">“{props.record.quote}”</p>
      </Show>
      <p class="settings-memory-meta">
        {recordUsage(props.record)}
        <Show when={props.anchors.length > 0}>
          {" "}
          · linked to{" "}
          {props.anchors
            .slice(0, 3)
            .map(
              (anchor) =>
                `${anchor.path}${anchor.line ? `:${anchor.line}` : ""}${anchor.symbol ? ` ${anchor.symbol}` : ""}`,
            )
            .join(", ")}
        </Show>
      </p>
      <div class="settings-memory-actions">
        <Show
          when={!editing()}
          fallback={
            <>
              <ButtonV2
                size="small"
                disabled={!draft().trim()}
                onClick={async () => {
                  if (
                    await update({ text: draft().trim() }, "Saved your edit. It holds when the document is read again.")
                  )
                    setEditing(false)
                }}
              >
                Save
              </ButtonV2>
              <ButtonV2 size="small" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </ButtonV2>
            </>
          }
        >
          <Show when={suggestion(props.record)}>
            <ButtonV2
              size="small"
              variant="outline"
              icon="check"
              onClick={() =>
                props.change(
                  (client) => client.memory.review.resolve({ itemID: props.record.id, action: "approve" }),
                  "Kept. Vector uses it now.",
                )
              }
            >
              Keep
            </ButtonV2>
            <ButtonV2
              size="small"
              variant="ghost"
              onClick={() =>
                props.change(
                  (client) => client.memory.review.resolve({ itemID: props.record.id, action: "reject" }),
                  "Dropped. A model's suggestion of it is not proposed again.",
                )
              }
            >
              Drop
            </ButtonV2>
          </Show>
          <Show when={props.record.status !== "archived"}>
            <ButtonV2
              size="small"
              variant="ghost"
              icon="edit"
              onClick={() => {
                setDraft(props.record.card)
                setEditing(true)
              }}
            >
              Edit
            </ButtonV2>
          </Show>
          <Show when={active()}>
            <ButtonV2
              size="small"
              variant="ghost"
              onClick={() =>
                update(
                  { pinned: !props.record.pinned },
                  props.record.pinned ? "Unpinned." : "Pinned: it now goes with every request in this repository.",
                )
              }
            >
              {props.record.pinned ? "Unpin" : "Pin"}
            </ButtonV2>
            <ButtonV2
              size="small"
              variant="ghost"
              onClick={() =>
                update({ action: "not-applicable" }, "Noted. Vector will not use it as one, also after a reindex.")
              }
            >
              {notApplicableLabel(props.record.kind)}
            </ButtonV2>
            <ButtonV2
              size="small"
              variant="ghost"
              onClick={() =>
                update({ action: "make-memory" }, "Saved as a memory entry, with this record as its evidence.")
              }
            >
              Make this a memory
            </ButtonV2>
            <ButtonV2
              size="small"
              variant="ghost"
              onClick={() => update({ action: "forget" }, "Forgotten. Restore it from this list.")}
            >
              Forget
            </ButtonV2>
          </Show>
          <Show when={active() && !linking()}>
            <ButtonV2 size="small" variant="ghost" onClick={() => setLinking(true)}>
              Link to file…
            </ButtonV2>
          </Show>
          <Show when={props.record.status === "archived"}>
            <ButtonV2
              size="small"
              variant="ghost"
              icon="reset"
              onClick={() => update({ action: "restore" }, "Restored.")}
            >
              Restore
            </ButtonV2>
          </Show>
        </Show>
      </div>
      <Show when={linking()}>
        <div class="settings-memory-actions" data-component="settings-memory-link-file">
          <input
            class="settings-memory-page-input"
            aria-label="File in this repository"
            placeholder="src/auth/session.ts"
            value={file()}
            onInput={(event) => setFile(event.currentTarget.value)}
          />
          <input
            class="settings-memory-page-input"
            aria-label="Symbol in the file (optional)"
            placeholder="refreshTokenTtl"
            value={symbol()}
            onInput={(event) => setSymbol(event.currentTarget.value)}
          />
          <ButtonV2
            size="small"
            disabled={!file().trim()}
            onClick={async () => {
              if (
                await props.change(
                  (client) =>
                    client.memory.records.update({
                      recordID: props.record.id,
                      link: { path: file().trim(), ...(symbol().trim() ? { symbol: symbol().trim() } : {}) },
                    }),
                  "Linked. Opening or editing that file now brings this record up.",
                )
              )
                setLinking(false)
            }}
          >
            Link
          </ButtonV2>
          <ButtonV2 size="small" variant="ghost" onClick={() => setLinking(false)}>
            Cancel
          </ButtonV2>
        </div>
      </Show>
    </article>
  )
}

// "Find more with a model…": the estimate first, then the request only when the user sends it. Whatever the model
// suggests that holds its quotes comes back as suggestions on this page.
function FindMore(props: {
  client: () => VectorClient | undefined
  documentID: string
  onDone: (message: string) => void
  onError: (message: string) => void
}) {
  const [estimate, setEstimate] = createSignal<MemoryDistillEstimate>()
  const [busy, setBusy] = createSignal(false)
  const ask = async () => {
    const client = props.client()
    if (!client) return
    setBusy(true)
    const result = await client.memory.distill
      .estimate({ documentID: props.documentID })
      .catch((cause: unknown) => ({ error: cause, data: undefined }))
    setBusy(false)
    if (!result.data) return props.onError(refusal(result.error).message ?? "Vector could not work out what this would send. Try again.")
    setEstimate(result.data)
  }
  const send = async () => {
    const client = props.client()
    if (!client) return
    setBusy(true)
    const result = await client.memory.distill
      .run({ documentID: props.documentID })
      .catch((cause: unknown) => ({ error: cause, data: undefined }))
    setBusy(false)
    setEstimate(undefined)
    if (!result.data) return props.onError(refusal(result.error).message ?? "Vector could not ask the model. Try again.")
    props.onDone(distilledLabel(result.data))
  }
  return (
    <div class="settings-memory-actions settings-memory-pad" data-component="settings-memory-find-more">
      <Show
        when={estimate()}
        fallback={
          <ButtonV2 size="small" variant="outline" disabled={busy()} onClick={() => void ask()}>
            Find more with a model…
          </ButtonV2>
        }
      >
        {(current) => (
          <div class="settings-memory-row">
            <p class="settings-memory-meta">{DISTILL}</p>
            <p class="settings-memory-text">{distillEstimateLabel(current())}</p>
            <div class="settings-memory-actions">
              <ButtonV2 size="small" disabled={busy() || !!current().refused} onClick={() => void send()}>
                {busy() ? "Asking the model…" : "Send"}
              </ButtonV2>
              <ButtonV2 size="small" variant="ghost" disabled={busy()} onClick={() => setEstimate(undefined)}>
                Cancel
              </ButtonV2>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}

function ForgetDocument(props: {
  title: string
  documentID: string
  change: (
    run: (client: VectorClient) => Promise<{ error?: unknown; data?: unknown }>,
    done: string,
  ) => Promise<boolean>
  onGone: () => void
}) {
  const [confirming, setConfirming] = createSignal(false)
  return (
    <div class="settings-memory-actions settings-memory-pad">
      <Show
        when={confirming()}
        fallback={
          <ButtonV2 size="small" variant="ghost" onClick={() => setConfirming(true)}>
            Forget this document…
          </ButtonV2>
        }
      >
        <span class="settings-memory-confirm">{FORGET}</span>
        <ButtonV2
          size="small"
          variant="danger"
          onClick={async () => {
            if (
              await props.change(
                (client) => client.memory.documents.remove({ documentID: props.documentID }),
                forgottenLabel(props.title),
              )
            )
              props.onGone()
          }}
        >
          Forget
        </ButtonV2>
        <ButtonV2 size="small" variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </ButtonV2>
      </Show>
    </div>
  )
}
