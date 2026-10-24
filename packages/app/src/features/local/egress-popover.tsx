import { For, Show, createEffect, createResource, createSignal, onCleanup } from "solid-js"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { DialogBody, DialogHeader, DialogTitleGroup, DialogV2 } from "@vectordevai/ui/v2/dialog-v2"
import {
  ADMIN,
  COVERS_TITLE,
  DEFINITION,
  LOCKED,
  LOG_TITLE,
  NOT_COVERED,
  PROGRAMS,
  notCovered,
  pillText,
  popoverLines,
  sourceName,
} from "./local-model"
import type { LocalStatusReader } from "./use-local"
import "./local.css"

// The session popover (section 8.5): what this session sent with Vector Local on, its subagents and helpers included,
// from the network log's counters. It reads them when it opens, every few seconds while it is open, and after a block
// the engine tells the app about. Links open the network log for this session and what Vector Local covers.

export function EgressPopover(props: {
  reader: LocalStatusReader
  sessionID?: string
  /** Opens the network log, what Vector Local covers or its settings, from an owner that outlives the popover. */
  onOpen: (view: "log" | "covers" | "settings") => void
}) {
  const [version, setVersion] = createSignal(0)
  const refresh = () => setVersion((value) => value + 1)
  const status = () => props.reader.status()
  const [summary] = createResource(
    () => {
      const client = props.reader.client()
      return client ? { client, session: props.sessionID, version: version() } : false
    },
    (input) =>
      input.client.local.egress
        .summary(input.session ? { session: input.session } : {}, { throwOnError: false })
        .then((result) => result.data)
        .catch(() => undefined),
  )
  const timer = setInterval(refresh, 4_000)
  onCleanup(() => clearInterval(timer))
  createEffect(() => {
    const events = props.reader.events()
    if (!events) return
    const stop = events.on("global", (event) => {
      if (event.type === "local.blocked") refresh()
    })
    onCleanup(stop)
  })

  return (
    <div data-component="local-popover">
      <Show when={status()}>
        {(current) => (
          <>
            <div data-slot="local-popover-head">
              <strong>{pillText(current().policy, props.reader.remote())}</strong>
              <span data-slot="local-muted">
                {props.sessionID ? "This session, with its subagents and helpers" : "This Vector"}
              </span>
            </div>
            <Show when={current().policy.lock}>
              <p data-slot="local-muted">{LOCKED}</p>
            </Show>
            <Show
              when={summary.latest}
              fallback={<p data-slot="local-muted">{summary.loading ? "Reading the counters…" : "No counters yet."}</p>}
            >
              {(counters) => (
                <ul data-slot="local-lines">
                  <For each={popoverLines(counters(), { policy: current().policy, sources: current().sources })}>
                    {(line) => <li data-line={line.id}>{line.text}</li>}
                  </For>
                </ul>
              )}
            </Show>
            <Show when={current().held}>
              {(held) => (
                <p data-slot="local-note">
                  A change to your config would loosen Vector Local: it {held().changes.join(", ")}. It waits for you in
                  Settings.
                </p>
              )}
            </Show>
          </>
        )}
      </Show>
      <div data-slot="local-popover-links">
        <button type="button" data-slot="local-link" data-action="local-open-log" onClick={() => props.onOpen("log")}>
          {LOG_TITLE}
        </button>
        <button type="button" data-slot="local-link" onClick={() => props.onOpen("covers")}>
          {COVERS_TITLE}
        </button>
        <button type="button" data-slot="local-link" onClick={() => props.onOpen("settings")}>
          Settings
        </button>
      </div>
    </div>
  )
}

/** What Vector Local covers and what it does not (section 1.1), with the registry's own notes on what it cannot see. */
export function DialogLocalCovers(props: { reader?: LocalStatusReader }) {
  const dialog = useDialog()
  return (
    <DialogV2 size="large" class="vector-local-dialog">
      <DialogHeader>
        <DialogTitleGroup title={COVERS_TITLE} description={DEFINITION} />
      </DialogHeader>
      <DialogBody class="vector-local-dialog__body">
        <LocalCovers status={props.reader?.status()} />
        <div data-slot="local-actions">
          <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
            Close
          </ButtonV2>
        </div>
      </DialogBody>
    </DialogV2>
  )
}

export function LocalCovers(props: { status?: ReturnType<LocalStatusReader["status"]> }) {
  return (
    <div data-component="local-covers">
      <h4 data-slot="local-subhead">What Vector Local does not cover</h4>
      <ul data-slot="local-list">
        <For each={NOT_COVERED}>
          {(item) => (
            <li>
              <strong>{item.title}.</strong> {item.body}
            </li>
          )}
        </For>
      </ul>
      <p data-slot="local-muted">{PROGRAMS}</p>
      <Show when={props.status}>
        {(status) => (
          <For each={notCovered(status())}>
            {(source) => (
              <details data-slot="local-details">
                <summary>{sourceName(source.id)}</summary>
                <p data-slot="local-muted">{source.why}.</p>
                <Show when={source.note}>{(note) => <p data-slot="local-muted">{note()}.</p>}</Show>
              </details>
            )}
          </For>
        )}
      </Show>
      <p data-slot="local-muted">{ADMIN}</p>
    </div>
  )
}
