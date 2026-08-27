import { createSignal } from "solid-js"

export type LocalMemoryState = {
  path: string
  exists: boolean
  bytes: number
  entries: number
  updatedAt?: string
  content: string
}

export type LocalMemoryApi = {
  read: () => Promise<LocalMemoryState>
  write: (content: string) => Promise<LocalMemoryState>
  clear: () => Promise<LocalMemoryState>
}

export function createLocalMemoryEditor(api: () => LocalMemoryApi | undefined) {
  const [state, setState] = createSignal<LocalMemoryState>()
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [confirming, setConfirming] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [unavailable, setUnavailable] = createSignal(false)
  const [error, setError] = createSignal("")

  const message = (action: string, cause: unknown) =>
    `${action}: ${cause instanceof Error ? cause.message : String(cause)}`

  const refresh = async () => {
    const bridge = api()
    if (!bridge) {
      setUnavailable(true)
      return
    }
    setUnavailable(false)
    const next = await bridge.read().catch((cause: unknown) => {
      setError(message("Vector could not load local memory", cause))
      return undefined
    })
    if (!next) return
    setError("")
    setState(next)
  }

  const edit = () => {
    setConfirming(false)
    setError("")
    setDraft(state()?.content ?? "")
    setEditing(true)
  }

  const cancelEdit = () => {
    setDraft("")
    setEditing(false)
  }

  const save = async () => {
    const bridge = api()
    const content = draft().trim()
    if (!bridge || !content || busy()) return
    setBusy(true)
    setError("")
    const next = await bridge.write(content).catch((cause: unknown) => {
      setError(message("Vector could not save local memory", cause))
      return undefined
    })
    if (next) {
      setState(next)
      setDraft("")
      setEditing(false)
    }
    setBusy(false)
  }

  const clear = async () => {
    const bridge = api()
    if (!bridge) return
    setBusy(true)
    setError("")
    const next = await bridge.clear().catch((cause: unknown) => {
      setError(message("Vector could not erase local memory", cause))
      return undefined
    })
    if (next) setState(next)
    setBusy(false)
    if (next) setConfirming(false)
  }

  return {
    state,
    editing,
    draft,
    setDraft,
    confirming,
    setConfirming,
    busy,
    unavailable,
    error,
    refresh,
    edit,
    cancelEdit,
    save,
    clear,
  }
}
