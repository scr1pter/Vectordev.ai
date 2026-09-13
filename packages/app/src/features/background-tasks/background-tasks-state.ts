import { createStore } from "solid-js/store"

/*
 * Panel state shared by the header button, the pane, the inline chips and the
 * command palette without a provider: the session page registers its commands
 * from its own component body, where no provider below it is visible. The
 * panel is one per window, like Claude Code's, so it stays open when you move
 * from a session into one of its subagents.
 */

export const BACKGROUND_TASKS_COMMAND = "backgroundTasks.toggle"

const LAYOUT_KEY = "vector.backgroundTasks.pane.v1"
const DISMISSED_KEY = "vector.backgroundTasks.dismissed.v1:"
const DISMISSED_LIMIT = 200

/** Docked pane: 330px wide plus an 8px gap on each side (see background-tasks.css). */
const DOCKED_RESERVE = "346px"
const EXPANDED_RESERVE = "(clamp(330px, 46vw, 720px) + 16px)"

type Layout = { open: boolean; floating: boolean; expanded: boolean }

export type RevealTarget = { cardKey: string; phaseKey?: string; nonce: number }

function storage() {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage
  } catch {
    return undefined
  }
}

function loadLayout(): Layout {
  const fallback: Layout = { open: false, floating: false, expanded: false }
  try {
    const raw = storage()?.getItem(LAYOUT_KEY)
    if (!raw) return fallback
    const value = JSON.parse(raw) as Partial<Layout>
    return {
      open: value.open === true,
      floating: value.floating === true,
      expanded: value.expanded === true,
    }
  } catch {
    return fallback
  }
}

const [store, setStore] = createStore<Layout & { reveal?: RevealTarget }>({ ...loadLayout(), reveal: undefined })

let nonce = 0

function persist() {
  try {
    storage()?.setItem(
      LAYOUT_KEY,
      JSON.stringify({ open: store.open, floating: store.floating, expanded: store.expanded }),
    )
  } catch {
    // Private windows and blocked storage keep the defaults.
  }
}

function update(patch: Partial<Layout>) {
  setStore(patch)
  persist()
}

export const backgroundTasksPane = {
  opened: () => store.open,
  floating: () => store.floating,
  expanded: () => store.expanded,
  open: () => update({ open: true }),
  close: () => update({ open: false }),
  toggle: () => update({ open: !store.open }),
  setFloating: (floating: boolean) => update({ floating }),
  setExpanded: (expanded: boolean) => update({ expanded }),
  /** The last chip-driven request to show a card; the pane consumes it and clears it. */
  reveal: () => store.reveal,
  revealCard(cardKey: string, phaseKey?: string) {
    nonce += 1
    setStore({ open: true, reveal: { cardKey, phaseKey, nonce } })
    persist()
  },
  clearReveal: () => setStore("reveal", undefined),
  /**
   * CSS length the docked pane takes out of the session split row, for the
   * conversation width in session.tsx. Undefined while closed or floating.
   */
  dockedReserve(): string | undefined {
    if (!store.open || store.floating) return undefined
    return store.expanded ? EXPANDED_RESERVE : DOCKED_RESERVE
  },
}

/** Finished cards the trash hid for one root session: card key → when it was cleared. */
export function loadDismissed(rootID: string): Record<string, number> {
  try {
    const raw = storage()?.getItem(DISMISSED_KEY + rootID)
    if (!raw) return {}
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ),
    )
  } catch {
    return {}
  }
}

export function saveDismissed(rootID: string, value: Record<string, number>) {
  const entries = Object.entries(value)
    .sort((a, b) => b[1] - a[1])
    .slice(0, DISMISSED_LIMIT)
  try {
    storage()?.setItem(DISMISSED_KEY + rootID, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // The hide still applies for as long as the page stays open.
  }
}
