import type { SessionReviewExpandMode } from "@vectordevai/session-ui/v2/session-review-v2"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"

export function createReviewPanelV2State() {
  const [store, setStore] = persisted(
    Persist.global("review-panel-v2"),
    createStore({
      expandMode: "collapse" as SessionReviewExpandMode,
    }),
  )
  // The rest is transient by design: a persisted filter would silently hide files
  // after a reload, and the list's expanded rows, scroll offset and last-read file
  // only need to survive a visit to the reader.
  const [filter, setFilter] = createSignal("")
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const [lastOpened, setLastOpened] = createSignal<string>()
  const [listScroll, setListScroll] = createSignal(0)

  return {
    filter,
    setFilter,
    expandMode: () => store.expandMode,
    setExpandMode: (mode: SessionReviewExpandMode) => setStore("expandMode", mode),
    expanded,
    setExpanded: (file: string, open: boolean) =>
      setExpanded((current) => {
        if (current.has(file) === open) return current
        const next = new Set(current)
        if (open) next.add(file)
        if (!open) next.delete(file)
        return next
      }),
    lastOpened,
    setLastOpened,
    listScroll,
    setListScroll,
    /** Clears the transient state, for another session. */
    reset: () => {
      setFilter("")
      setExpanded(new Set<string>())
      setLastOpened(undefined)
      setListScroll(0)
    },
  }
}

export type ReviewPanelV2State = ReturnType<typeof createReviewPanelV2State>
