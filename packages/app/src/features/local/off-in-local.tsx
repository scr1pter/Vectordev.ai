import type { LocalStatus, VectorClient } from "@vectordevai/sdk/v2/client"
import { Show, createMemo, createSignal } from "solid-js"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { DialogAllowSource } from "./allow-dialog"
import { OFF_STATE, offInLocal, type OffItem } from "./local-model"
import { useLocalStatus } from "./use-local"
import "./local.css"

// The "Off in Vector Local" label (section 4.11): where Vector Local keeps a feature off, the place says so, with Why
// and, where it may be allowed, Allow…. Nothing is hidden without a word: a source the app hides in this release says
// that too. With Vector Local off, or for a source it does not restrict, the label renders nothing.

export function OffInLocal(props: {
  /** The registry source, such as "github" or "share". */
  source: string
  /** The status the caller already reads; without it the label reads Vector Local itself. */
  status?: LocalStatus
  client?: VectorClient
  onChanged?: (status?: LocalStatus) => void
}) {
  const reader = props.status ? undefined : useLocalStatus()
  const status = () => props.status ?? reader?.status()
  const client = () => props.client ?? reader?.client()
  const item = createMemo(() => {
    const current = status()
    if (!current?.policy.enabled) return undefined
    return offInLocal(current).find((entry) => entry.source.id === props.source)
  })
  return (
    <Show when={item()}>
      {(entry) => (
        <OffInLocalRow
          item={entry()}
          status={status()!}
          client={client()}
          onChanged={(next) => {
            reader?.refresh()
            props.onChanged?.(next)
          }}
        />
      )}
    </Show>
  )
}

/** One source's row: its state, Why, and Allow… where allowable. */
export function OffInLocalRow(props: {
  item: OffItem
  status: LocalStatus
  client?: VectorClient
  /** Shows the source's name; a label beside a feature leaves it out. */
  named?: boolean
  onChanged?: (status?: LocalStatus) => void
  /**
   * Opens the Allow dialog from the caller, whose owner outlives this row: a list of rows is built again when what
   * Vector Local allows changes, which would dispose a dialog the row opened itself.
   */
  onAllow?: (item: OffItem) => void
}) {
  const dialog = useDialog()
  const [open, setOpen] = createSignal(false)
  const allow = () => {
    if (props.onAllow) return props.onAllow(props.item)
    const client = props.client
    if (!client) return
    void dialog.push(() => (
      <DialogAllowSource source={props.item.source} status={props.status} client={client} onDone={props.onChanged} />
    ))
  }
  return (
    <div data-component="local-off" data-state={props.item.state} data-source={props.item.source.id}>
      <div data-slot="local-off-head">
        <span data-slot="local-off-label">{OFF_STATE[props.item.state]}</span>
        <Show when={props.named}>
          <span data-slot="local-off-name">{props.item.name}</span>
        </Show>
        <button type="button" data-slot="local-link" aria-expanded={open()} onClick={() => setOpen((value) => !value)}>
          Why
        </button>
        <Show when={props.item.allowable && props.item.state !== "allowed" && props.client}>
          <button type="button" data-slot="local-link" data-action="local-allow" onClick={allow}>
            Allow…
          </button>
        </Show>
      </div>
      <Show when={props.item.allowed}>
        {(entry) => <p data-slot="local-muted">You allowed it: {entry().reason}</p>}
      </Show>
      <Show when={open()}>
        <p data-slot="local-why">{props.item.why}</p>
        <Show when={props.item.source.note}>{(note) => <p data-slot="local-muted">{note()}</p>}</Show>
      </Show>
    </div>
  )
}
