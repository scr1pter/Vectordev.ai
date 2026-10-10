import { createSignal, onCleanup, Show, type JSX } from "solid-js"
import "./vercel.css"

export type VercelNotice = (notice: { tone: "info" | "success" | "error"; text: string }) => void

// A destructive or production-moving button arms on the first click and acts
// on a second click within three seconds, as the rest of Cloud Services does.
export function createConfirm() {
  const [armed, setArmed] = createSignal("")
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  return {
    armed: (id: string) => armed() === id,
    request: (id: string, action: () => void) => {
      clearTimeout(timer)
      if (armed() === id) {
        setArmed("")
        action()
        return
      }
      setArmed(id)
      timer = setTimeout(() => setArmed(""), 3000)
    },
  }
}

export function VercelLinkRequired(props: { linked: boolean; onOpenConnections?: () => void; children: JSX.Element }) {
  return (
    <Show
      when={props.linked}
      fallback={
        <div class="cloud-inline-empty">
          <span>Link a Vercel project to this repository first.</span>
          <Show when={props.onOpenConnections}>
            {(open) => (
              <button class="cloud-button" type="button" onClick={() => open()()}>
                Open Integrations
              </button>
            )}
          </Show>
        </div>
      }
    >
      {props.children}
    </Show>
  )
}

export function formatWhen(value?: string) {
  if (!value) return "—"
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}
