import type { EgressEvent, LocalSource, VectorClient } from "@vectordevai/sdk/v2/client"
import { For, Show, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { DialogBody, DialogFooter, DialogHeader, DialogTitleGroup, DialogV2 } from "@vectordevai/ui/v2/dialog-v2"
import { GUEST, LOG_TITLE, exportName, logRows, refusal, retention, type LogFilter } from "./local-model"
import { message } from "./allow-dialog"
import "./local.css"

// The network log, "What Vector sent" (section 8.5): one row per request Vector decided while Vector Local was on,
// newest first, with when, what, where (host and class), the session, the sizes, the result and the rule. It records
// origins only, never a path, a query, a header or a body. The routes are the owner's: a guest is told so and sees no
// row. Export downloads what the log keeps on this computer, and Clear erases it after asking.

export function DialogEgressLog(props: {
  client: VectorClient
  sources?: readonly LocalSource[]
  retainDays?: number
  /** Opens filtered to this session, its subagents and helpers. */
  session?: string
  sessionTitle?: (id: string) => string | undefined
}) {
  return (
    <DialogV2 size="x-large" class="vector-local-dialog vector-local-log-dialog">
      <DialogHeader>
        <DialogTitleGroup
          title={LOG_TITLE}
          description={`Every request Vector decided while Vector Local was on: where it went, never what it said. ${retention(props.retainDays ?? 30)}`}
        />
      </DialogHeader>
      <DialogBody class="vector-local-log-dialog__body">
        <EgressLog {...props} />
      </DialogBody>
    </DialogV2>
  )
}

export function EgressLog(props: {
  client: VectorClient
  sources?: readonly LocalSource[]
  session?: string
  sessionTitle?: (id: string) => string | undefined
}) {
  const dialog = useDialog()
  const [filter, setFilter] = createSignal<LogFilter>({ result: "all", session: props.session, text: "" })
  const [version, setVersion] = createSignal(0)
  const [notice, setNotice] = createSignal("")
  const [error, setError] = createSignal("")
  const [events] = createResource(
    () => version() + 1,
    () =>
      props.client.local.egress
        .list({}, { throwOnError: false })
        .then((result) => ({ data: result.data, status: result.response?.status, error: result.error }))
        .catch((cause: unknown) => ({ data: undefined, status: undefined, error: cause })),
  )
  const guest = () => events.latest?.status === 401 || events.latest?.status === 403
  const all = (): readonly EgressEvent[] => events.latest?.data ?? []
  const rows = createMemo(() => logRows(all(), { filter: filter(), sources: props.sources }))
  const refresh = () => setVersion((value) => value + 1)
  // Read again every five seconds while the log is open, so a running session's requests appear.
  const timer = setInterval(refresh, 5_000)
  onCleanup(() => clearInterval(timer))

  const download = async (format: "csv" | "jsonl") => {
    setError("")
    const result = await props.client.local.egress
      .export(
        { format, ...(filter().session ? { session: filter().session } : {}) },
        { throwOnError: false, parseAs: "text" },
      )
      .catch((cause: unknown) => ({ error: cause, data: undefined }))
    if (result.error || typeof result.data !== "string") return setError(message(refusal(result.error)))
    const url = URL.createObjectURL(
      new Blob([result.data], { type: format === "csv" ? "text/csv" : "application/x-ndjson" }),
    )
    const link = document.createElement("a")
    link.href = url
    link.download = exportName(format)
    link.click()
    URL.revokeObjectURL(url)
    setNotice(`Exported as ${link.download}.`)
  }

  const clear = () =>
    void dialog.push(() => (
      <DialogClearLog
        onClear={async () => {
          const result = await props.client.local.egress
            .clear({}, { throwOnError: false })
            .catch((cause: unknown) => ({ error: cause, data: undefined }))
          if (result.data !== true) {
            setError(message(refusal(result.error)))
            return
          }
          setNotice("The network log is erased.")
          refresh()
        }}
      />
    ))

  return (
    <Show when={!guest()} fallback={<p data-slot="local-note">{GUEST}</p>}>
      <div data-component="local-log">
        <div data-slot="local-log-toolbar">
          <div role="group" aria-label="Result" data-slot="local-segmented">
            <For
              each={
                [
                  ["all", "All"],
                  ["allowed", "Allowed"],
                  ["blocked", "Blocked or asked"],
                ] as const
              }
            >
              {([id, label]) => (
                <button
                  type="button"
                  aria-pressed={filter().result === id}
                  onClick={() => setFilter((current) => ({ ...current, result: id }))}
                >
                  {label}
                </button>
              )}
            </For>
          </div>
          <Show when={props.session}>
            {(session) => (
              <label data-slot="local-check">
                <input
                  type="checkbox"
                  checked={filter().session === session()}
                  onChange={(event) =>
                    setFilter((current) => ({
                      ...current,
                      session: event.currentTarget.checked ? session() : undefined,
                    }))
                  }
                />
                This session only
              </label>
            )}
          </Show>
          <input
            type="search"
            data-slot="local-search"
            placeholder="Filter by host or service"
            aria-label="Filter by host or service"
            value={filter().text}
            onInput={(event) => {
              const text = event.currentTarget.value
              setFilter((current) => ({ ...current, text }))
            }}
          />
          <span data-slot="local-spacer" />
          <ButtonV2 size="small" variant="ghost" onClick={refresh}>
            Refresh
          </ButtonV2>
          <ButtonV2
            size="small"
            variant="outline"
            data-action="local-log-export-csv"
            onClick={() => void download("csv")}
          >
            Export CSV
          </ButtonV2>
          <ButtonV2 size="small" variant="outline" onClick={() => void download("jsonl")}>
            Export JSONL
          </ButtonV2>
          <ButtonV2 size="small" variant="ghost" data-action="local-log-clear" onClick={clear}>
            Clear
          </ButtonV2>
        </div>
        <Show when={notice()}>
          <p data-slot="local-muted" role="status">
            {notice()}
          </p>
        </Show>
        <Show when={error()}>
          <p data-slot="local-error" role="alert">
            {error()}
          </p>
        </Show>
        <Show
          when={rows().length > 0}
          fallback={
            <p data-slot="local-muted">
              {events.loading && !events.latest
                ? "Reading the network log…"
                : all().length
                  ? "No request matches these filters."
                  : "Nothing yet. The log records requests while Vector Local is on."}
            </p>
          }
        >
          <div data-slot="local-log-scroll">
            <table data-slot="local-log-table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">What</th>
                  <th scope="col">Where</th>
                  <th scope="col">Session</th>
                  <th scope="col">Sent</th>
                  <th scope="col">Received</th>
                  <th scope="col">Result</th>
                  <th scope="col">Rule</th>
                </tr>
              </thead>
              <tbody>
                <For each={rows()}>
                  {(row) => (
                    <tr data-decision={row.decision}>
                      <td data-slot="local-nowrap">{row.time}</td>
                      <td>
                        {row.what}
                        <Show when={row.carried}>{(carried) => <span data-slot="local-sub">{carried()}</span>}</Show>
                      </td>
                      <td>
                        {row.host}
                        <span data-slot="local-sub">{row.where}</span>
                      </td>
                      <td title={row.session}>
                        {row.session ? (props.sessionTitle?.(row.session) ?? shortID(row.session)) : "–"}
                      </td>
                      <td data-slot="local-nowrap">{row.sent}</td>
                      <td data-slot="local-nowrap">{row.received}</td>
                      <td data-slot="local-result">{row.result}</td>
                      <td title={row.rule}>{row.reason}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </div>
    </Show>
  )
}

function DialogClearLog(props: { onClear: () => Promise<void> }) {
  const dialog = useDialog()
  return (
    <DialogV2 fit class="vector-local-dialog">
      <DialogHeader hideClose>
        <DialogTitleGroup
          title="Erase the network log?"
          description="This erases the requests in memory, the counters and the log files on this computer. It cannot be undone."
        />
      </DialogHeader>
      <DialogBody class="vector-local-dialog__body">
        <span />
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
          Cancel
        </ButtonV2>
        <ButtonV2
          variant="danger"
          data-action="local-log-clear-confirm"
          onClick={() => {
            dialog.close()
            void props.onClear()
          }}
        >
          Erase
        </ButtonV2>
      </DialogFooter>
    </DialogV2>
  )
}

function shortID(id: string) {
  return id.length > 10 ? `…${id.slice(-6)}` : id
}
