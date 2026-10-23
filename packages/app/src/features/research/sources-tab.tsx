import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup } from "solid-js"
import type { Message, MemoryResearchSource, ResearchNote } from "@vectordevai/sdk/v2/client"
import { ResearchSignals } from "@vectordevai/core/research/signals"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { showToast } from "@/utils/toast"
import { ResearchSourceViewer } from "./source-viewer"
import {
  AGENT,
  GUEST,
  PREVIEW,
  VIEW_ONLY,
  WRAP_UP,
  chipText,
  ownerOnly,
  reading,
  runChips,
  scopeLabel,
  sessionRuns,
  statusLabel,
  type BrowserChip,
  type OpenSources,
} from "./research-model"
import "./research.css"

const RUN_STATUS: Record<string, string> = {
  planned: "planned",
  running: "researching",
  done: "done",
  stopped: "stopped",
  failed: "failed",
}

/**
 * The Sources tab (section 8.3): the run's searches, one row per source with its status, signals and notes, the saved
 * text of each, the research browsers working for the run, and Wrap up. The routes are the owner's, so a guest is told
 * whose they are.
 */
export function ResearchSourcesTab(props: {
  sessionID: string
  /** What a citation or a research row asked to open. */
  request?: OpenSources
  onOpenInBrowser: (url: string) => void
}) {
  const sdk = useSDK()
  const sync = useSync()
  const [version, setVersion] = createSignal(0)
  const [picked, setPicked] = createSignal<string>()
  const [viewing, setViewing] = createSignal<{ source: string; note?: string }>()

  // The session and its subagents: a research lead the build agent started runs in a child session.
  const lineage = createMemo(() => [
    props.sessionID,
    ...(sync().data.session ?? []).filter((item) => item.parentID === props.sessionID).map((item) => item.id),
  ])
  const parts = createMemo(() =>
    lineage().flatMap((id) =>
      (sync().data.message?.[id] ?? []).flatMap((message) => sync().data.part?.[message.id] ?? []),
    ),
  )
  const named = createMemo(() => sessionRuns(parts()))

  const [listed] = createResource(
    () => ({ version: version(), client: sdk().client }),
    (input) => input.client.memory.research.list({}, { throwOnError: false }),
  )
  const guest = createMemo(() => ownerOnly(listed.latest?.response?.status))
  // The runs of this session, newest last: those its parts name, and those the store keeps for it.
  const runs = createMemo(() => {
    const known = new Set(lineage())
    const stored = (listed.latest?.data?.runs ?? [])
      .filter((item) => known.has(item.run.session_id))
      .toSorted((a, b) => a.run.created_at - b.run.created_at)
      .map((item) => item.run.id)
    return [...new Set([...stored, ...named()])]
  })
  const runID = createMemo(() => picked() ?? runs().at(-1))

  const [detail] = createResource(
    () => {
      const id = runID()
      if (!id || guest()) return false
      return { runID: id, version: version(), client: sdk().client }
    },
    (input) =>
      input.client.memory.research
        .get({ runID: input.runID }, { throwOnError: false })
        .then((result) => (result.data ? result.data : undefined)),
  )

  // A run changed: read it again, at most every half second however many sources it reads at once.
  const timer: { id?: ReturnType<typeof setTimeout> } = {}
  const refresh = () => {
    if (timer.id) return
    timer.id = setTimeout(() => {
      timer.id = undefined
      setVersion((value) => value + 1)
    }, 500)
  }
  onCleanup(() => clearTimeout(timer.id))
  const stop = sdk().event.on("research.updated", (event) => {
    const changed = event.properties.runID
    if (runs().includes(changed) || !runID()) refresh()
  })
  onCleanup(stop)

  // A citation or a research row asked for a run, a source or a note.
  createEffect(
    on(
      () => props.request,
      (request) => {
        if (!request) return
        if (request.runID) setPicked(request.runID)
        if (request.source) setViewing({ source: request.source, note: request.note })
      },
    ),
  )

  const run = () => detail.latest?.run
  const notes = createMemo(() => {
    const map = new Map<string, ResearchNote[]>()
    for (const note of detail.latest?.notes ?? []) map.set(note.source, [...(map.get(note.source) ?? []), note])
    return map
  })
  const viewed = createMemo(() => {
    const current = viewing()
    if (!current) return undefined
    const source = detail.latest?.sources.find((item) => item.id === current.source)
    return source ? { source, note: current.note } : undefined
  })
  const pending = createMemo(() => {
    const saved = new Set((detail.latest?.sources ?? []).flatMap((item) => [item.url, item.canonical_url]))
    return reading(parts()).filter((url) => !saved.has(url))
  })

  const wrapUp = async () => {
    const lead = run()?.session_id ?? props.sessionID
    const last = (sync().data.message?.[lead] ?? []).findLast(
      (message): message is Extract<Message, { role: "user" }> => message.role === "user",
    )
    const result = await sdk()
      .client.session.promptAsync({
        sessionID: lead,
        agent: AGENT,
        ...(last ? { model: { providerID: last.model.providerID, modelID: last.model.modelID } } : {}),
        ...(last?.model.variant ? { variant: last.model.variant } : {}),
        parts: [{ type: "text", text: WRAP_UP }],
      })
      .then(
        () => true,
        () => false,
      )
    if (!result) showToast({ title: "Could not ask for the report", variant: "error" })
  }

  return (
    <div data-component="research-sources">
      <div data-slot="research-sources-head">
        <div data-slot="research-row">
          <span data-slot="research-title">Sources</span>
          <span data-component="research-preview-label">{PREVIEW}</span>
          <Show when={run()?.status === "running"}>
            <button type="button" data-slot="research-button" style={{ "margin-left": "auto" }} onClick={wrapUp}>
              Wrap up
            </button>
          </Show>
        </div>
        <Show when={run()}>
          {(current) => (
            <>
              <div data-slot="research-source-title">{current().question}</div>
              <div data-slot="research-muted">
                {[
                  current().depth === "deep" ? "Deep" : "Focused",
                  scopeLabel(current().scope),
                  RUN_STATUS[current().status] ?? current().status,
                  `${current().pages} page${current().pages === 1 ? "" : "s"}`,
                  `${current().searches} search${current().searches === 1 ? "" : "es"}`,
                ].join(" · ")}
              </div>
            </>
          )}
        </Show>
        <Show when={runs().length > 1}>
          <select
            data-slot="research-input"
            aria-label="Research run"
            value={runID()}
            onChange={(event) => {
              setPicked(event.currentTarget.value)
              setViewing(undefined)
            }}
          >
            <For each={runs()}>
              {(id, index) => (
                <option value={id}>
                  Research {index() + 1}
                  {id === runID() && run() ? `: ${run()!.question.slice(0, 60)}` : ""}
                </option>
              )}
            </For>
          </select>
        </Show>
      </div>

      <div data-slot="research-sources-body">
        <Show when={!guest()} fallback={<div data-slot="research-notice">{GUEST}</div>}>
          <ResearchBrowsers runs={runs()} lead={run()?.session_id ?? props.sessionID} />
          <Show
            when={viewed()}
            fallback={
              <SourceList
                queries={detail.latest?.queries ?? []}
                sources={detail.latest?.sources ?? []}
                notes={notes()}
                pending={pending()}
                empty={
                  !runID()
                    ? "Sources appear here once a research plan starts."
                    : detail.loading && !detail.latest
                      ? "Reading the run…"
                      : "No sources yet."
                }
                onOpen={(source) => setViewing({ source })}
              />
            }
          >
            {(current) => (
              <ResearchSourceViewer
                runID={runID()!}
                source={current().source}
                notes={notes().get(current().source.id) ?? []}
                focus={current().note}
                onBack={() => setViewing(undefined)}
                onOpenInBrowser={props.onOpenInBrowser}
              />
            )}
          </Show>
        </Show>
      </div>
    </div>
  )
}

function SourceList(props: {
  queries: readonly string[]
  sources: readonly MemoryResearchSource[]
  notes: ReadonlyMap<string, readonly ResearchNote[]>
  pending: readonly string[]
  empty: string
  onOpen: (source: string) => void
}) {
  return (
    <div data-component="research-card">
      <Show when={props.queries.length > 0}>
        <details>
          <summary>
            {props.queries.length} search{props.queries.length === 1 ? "" : "es"} so far
          </summary>
          <ol data-slot="research-queries">
            <For each={props.queries}>{(query) => <li>{query}</li>}</For>
          </ol>
        </details>
      </Show>
      <For each={props.pending}>
        {(url) => (
          <div data-slot="research-source">
            <div data-slot="research-source-head">
              <span data-slot="research-source-title">{url}</span>
              <span data-slot="research-status">reading</span>
            </div>
          </div>
        )}
      </For>
      <For each={props.sources}>
        {(source) => (
          <button type="button" data-slot="research-source" onClick={() => props.onOpen(source.id)}>
            <span data-slot="research-source-head">
              <span data-slot="research-source-id">{source.id}</span>
              <span data-slot="research-source-title">{source.title || source.url}</span>
              <span data-slot="research-status" data-status={source.status}>
                {statusLabel(source)}
              </span>
            </span>
            <span data-slot="research-muted">{source.site}</span>
            <Show when={source.signals}>
              {(signals) => (
                <span data-slot="research-row">
                  <For each={ResearchSignals.labels(signals())}>
                    {(label) => <span data-slot="research-tag">{label}</span>}
                  </For>
                </span>
              )}
            </Show>
            <Show when={(props.notes.get(source.id) ?? []).length > 0}>
              <ul data-slot="research-notes">
                <For each={props.notes.get(source.id)}>
                  {(note) => (
                    <li data-paraphrase={note.support ? undefined : "true"}>
                      {note.id}: {note.claim}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </button>
        )}
      </For>
      <Show when={props.sources.length === 0 && props.pending.length === 0}>
        <div data-slot="research-muted">{props.empty}</div>
      </Show>
    </div>
  )
}

/**
 * One chip per research browser of these runs (section 5.6a), on the desktop. A chip opens a view-only watch: about two
 * snapshots a second, and Stop. Stop closes that browser; on a researcher's chip it also ends that researcher.
 */
function ResearchBrowsers(props: { runs: readonly string[]; lead: string }) {
  const sdk = useSDK()
  const watch = () => globalThis.window?.api?.researchWatch
  const [chips, setChips] = createSignal<BrowserChip[]>([])
  const [watching, setWatching] = createSignal<string>()
  const [snapshot, setSnapshot] = createSignal<string>()

  const load = () => {
    const api = watch()
    if (!api) return
    void api.list().then(setChips, () => setChips([]))
  }
  load()
  const unsubscribe = watch()?.onChange(load)
  onCleanup(() => unsubscribe?.())

  const shown = createMemo(() => runChips(chips(), props.runs))
  const current = createMemo(() => shown().find((chip) => chip.id === watching()))

  // About two snapshots a second while a chip is open and the window can be seen.
  createEffect(
    on(current, (chip) => {
      setSnapshot(undefined)
      if (!chip) return
      const api = watch()
      if (!api) return
      const take = () => {
        if (document.visibilityState === "hidden") return
        void api.snapshot(chip.id).then(
          (image) => setSnapshot(image),
          () => setSnapshot(undefined),
        )
      }
      take()
      const timer = setInterval(take, 500)
      onCleanup(() => clearInterval(timer))
    }),
  )

  const stop = async (chip: BrowserChip) => {
    const api = watch()
    if (!api) return
    await api.stop(chip.id).catch(() => false)
    setWatching(undefined)
    // A researcher is its own session: Stop ends it. The lead keeps researching without a browser.
    if (chip.sessionID !== props.lead)
      await sdk()
        .client.session.abort({ sessionID: chip.sessionID })
        .catch(() => undefined)
  }

  return (
    <Show when={shown().length > 0}>
      <div data-component="research-card" style={{ "margin-bottom": "12px" }}>
        <span data-slot="research-label">Research browsers</span>
        <div data-slot="research-browsers">
          <For each={shown()}>
            {(chip) => (
              <button
                type="button"
                data-slot="research-browser-chip"
                data-state={chip.state}
                aria-pressed={watching() === chip.id}
                onClick={() => setWatching((id) => (id === chip.id ? undefined : chip.id))}
              >
                {chipText(chip)}
              </button>
            )}
          </For>
        </div>
        <Show when={current()}>
          {(chip) => (
            <div data-slot="research-watch">
              <div data-slot="research-row">
                <span data-slot="research-muted" style={{ flex: "1 1 auto" }}>
                  {VIEW_ONLY}
                </span>
                <button type="button" data-slot="research-button" data-variant="danger" onClick={() => stop(chip())}>
                  {chip().sessionID === props.lead ? "Stop browsing" : "Stop researcher"}
                </button>
              </div>
              <Show when={snapshot()} fallback={<div data-slot="research-muted">Waiting for the page…</div>}>
                {(image) => <img src={image()} alt={`What ${chip().label} sees`} draggable={false} />}
              </Show>
            </div>
          )}
        </Show>
      </div>
    </Show>
  )
}
