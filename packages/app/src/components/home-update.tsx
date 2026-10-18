import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { createUpdateRestart, type PendingUpdate } from "./updater-action"

/**
 * Home's Update button, before Settings, once an update has downloaded and while it installs. Home shows no sidebar, so
 * without it someone who stays on Home only learns of the update in Settings > Updates & about. It restarts the way the
 * sidebar's button does, asking first while agents in the workspace are running. Its own data-variant keeps the tour's
 * Home selectors on the buttons they describe.
 */
export function HomeUpdate(props: {
  update?: PendingUpdate
  onUpdate: () => void
  runningAgents?: () => number | Promise<number>
}) {
  const restart = createUpdateRestart({
    update: () => props.update,
    install: () => props.onUpdate(),
    runningAgents: props.runningAgents,
  })
  // Where the question hangs, under the button. Home's header clips what overflows it, so the question is drawn on the
  // page's top layer at a fixed place instead, and closes if the page scrolls or resizes under it.
  const [place, setPlace] = createSignal({ top: 0, right: 0 })
  let button: HTMLButtonElement | undefined
  let later: HTMLButtonElement | undefined
  const close = () => {
    restart.setConfirming(false)
    button?.focus()
  }
  createEffect(() => {
    if (!restart.confirming()) return
    const dismiss = () => restart.setConfirming(false)
    window.addEventListener("resize", dismiss)
    window.addEventListener("scroll", dismiss, true)
    onCleanup(() => {
      window.removeEventListener("resize", dismiss)
      window.removeEventListener("scroll", dismiss, true)
    })
  })
  return (
    <>
      <span role="status" aria-live="polite" class="sr-only">
        {restart.announcement()}
      </span>
      <Show when={props.update}>
        {(pending) => (
          <>
            <button
              type="button"
              ref={button}
              data-variant="update"
              data-vector-home-update
              data-state={pending().installing ? "installing" : "ready"}
              disabled={pending().installing}
              aria-busy={pending().installing ? "true" : undefined}
              aria-haspopup={!pending().installing && props.runningAgents ? "dialog" : undefined}
              aria-expanded={!pending().installing && props.runningAgents ? restart.confirming() : undefined}
              aria-label={
                pending().installing
                  ? `Updating to Vector ${pending().version}`
                  : `Restart to update to Vector ${pending().version}`
              }
              title={
                pending().installing
                  ? `Updating to Vector ${pending().version}`
                  : `Restart to update to Vector ${pending().version}`
              }
              onClick={async () => {
                if (!(await restart.start()) || !button) return
                const rect = button.getBoundingClientRect()
                setPlace({ top: rect.bottom + 8, right: Math.max(16, window.innerWidth - rect.right) })
                queueMicrotask(() => later?.focus())
              }}
            >
              <Show
                when={pending().installing}
                fallback={
                  <svg viewBox="0 0 14 14" class="size-3.5 shrink-0" aria-hidden="true">
                    <path
                      d="M7 11V3M3.5 7.63128L7 11L10.5 7.63128"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.3"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                }
              >
                <span data-vector-update-spinner aria-hidden="true" />
              </Show>
              <span>{pending().installing ? "Updating…" : "Update"}</span>
            </button>
            <Show when={restart.confirming()}>
              <Portal>
                <div
                  data-vector-update-confirm
                  role="dialog"
                  aria-label="Restart to update"
                  aria-describedby="vector-home-update-confirm-detail"
                  class="vector-home-update__confirm"
                  style={{ top: `${place().top}px`, right: `${place().right}px` }}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return
                    event.preventDefault()
                    event.stopPropagation()
                    close()
                  }}
                >
                  <p data-update-confirm-title>Restart to update to Vector {pending().version}?</p>
                  <p id="vector-home-update-confirm-detail" data-update-confirm-detail>
                    {restart.stopping() === 1
                      ? "1 agent in the workspace is still running and will stop."
                      : `${restart.stopping()} agents in the workspace are still running and will stop.`}
                  </p>
                  <div data-update-confirm-actions>
                    <button type="button" data-update-confirm-later ref={later} onClick={close}>
                      Later
                    </button>
                    <button
                      type="button"
                      data-update-confirm-restart
                      onClick={() => {
                        restart.setConfirming(false)
                        props.onUpdate()
                      }}
                    >
                      Restart now
                    </button>
                  </div>
                </div>
              </Portal>
            </Show>
          </>
        )}
      </Show>
    </>
  )
}
