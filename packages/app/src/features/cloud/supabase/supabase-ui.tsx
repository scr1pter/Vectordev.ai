import { createSignal, onCleanup, Show, type JSX } from "solid-js"
import type { SupabaseClient, SupabaseReport } from "./supabase-api"

export type SupabaseNotice = (notice: { tone: "info" | "success" | "error"; text: string }) => void

export type SupabasePanelProps = {
  client: SupabaseClient
  /** A Supabase project is linked to this repository. */
  linked: boolean
  projectName?: string
  notice: SupabaseNotice
  onOpenDatabase: () => void
}

// A report that did not go through becomes the console notice, with the step
// the user can take next.
export function failed(notice: SupabaseNotice, report: SupabaseReport) {
  if (report.ok) return false
  notice({ tone: "error", text: [report.error ?? "Supabase did not complete that.", report.nextStep].filter(Boolean).join(" ") })
  return true
}

// Destructive and billed actions take two clicks: the first arms the button for
// a few seconds and names what will happen, the second runs it.
export function createConfirm() {
  const [armed, setArmed] = createSignal("")
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  return {
    armed,
    ask: (id: string, action: () => void) => {
      clearTimeout(timer)
      if (armed() === id) {
        setArmed("")
        action()
        return
      }
      setArmed(id)
      timer = setTimeout(() => setArmed(""), 4000)
    },
  }
}

export function NotLinked(props: { onOpenDatabase: () => void; what: string; icon: JSX.Element }) {
  return (
    <div class="cloud-empty">
      <svg viewBox="0 0 16 16" class="cloud-empty-icon" aria-hidden="true">
        {props.icon}
      </svg>
      <strong>Link a Supabase project first</strong>
      <p>{props.what}</p>
      <button class="cloud-button mt-4" data-variant="primary" type="button" onClick={props.onOpenDatabase}>
        Open Database
      </button>
    </div>
  )
}

export function PanelHead(props: { title: string; detail?: string; children?: JSX.Element }) {
  return (
    <div class="sb-panel-head">
      <div>
        <div class="cloud-panel-title">{props.title}</div>
        <Show when={props.detail}>
          <p class="cloud-muted mt-1 text-[12px]">{props.detail}</p>
        </Show>
      </div>
      <Show when={props.children}>
        <div class="sb-actions">{props.children}</div>
      </Show>
    </div>
  )
}

export function formatWhen(value?: string) {
  if (!value || Number.isNaN(Date.parse(value))) return "—"
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}
