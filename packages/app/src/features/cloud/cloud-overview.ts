import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import type { CloudApi, CloudOverview } from "./cloud-api"

/**
 * A directory's Vector Cloud overview, kept live: it reloads whenever the
 * desktop reports a cloud change (a Cloud screen, a publish from the preview,
 * or the agent), when the window regains focus, and when the directory changes.
 */
export function createCloudOverview(input: {
  api: Pick<CloudApi, "overview" | "onChange">
  directory: Accessor<string | undefined>
}) {
  const [overview, setOverview] = createSignal<CloudOverview>()
  const [error, setError] = createSignal("")

  const refresh = async () => {
    const directory = input.directory()
    if (!directory) return
    await input.api
      .overview(directory)
      .then((next) => {
        // A slower answer for a directory the session has left is dropped.
        if (input.directory() !== directory) return
        setOverview(next)
        setError("")
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Vector Cloud is unavailable right now."))
  }

  createEffect(
    on(input.directory, () => {
      setOverview(undefined)
      void refresh()
    }),
  )
  onCleanup(input.api.onChange(() => void refresh()))
  const onFocus = () => void refresh()
  globalThis.window?.addEventListener("focus", onFocus)
  onCleanup(() => globalThis.window?.removeEventListener("focus", onFocus))

  return { overview, error, setError, refresh }
}
