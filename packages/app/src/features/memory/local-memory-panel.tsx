import { createSignal, onMount, Show } from "solid-js"

export type LocalMemoryState = {
  path: string
  exists: boolean
  bytes: number
  entries: number
  updatedAt?: string
  content: string
}

type LocalMemoryApi = {
  read: () => Promise<LocalMemoryState>
  write: (content: string) => Promise<LocalMemoryState>
  clear: () => Promise<LocalMemoryState>
}

function api(): LocalMemoryApi | undefined {
  return (globalThis.window as unknown as { api?: { localMemory?: LocalMemoryApi } } | undefined)?.api?.localMemory
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Local memory is the feature most likely to make someone uneasy, so this panel
// shows exactly what is stored, where it lives on disk, and offers a real
// delete rather than a toggle that merely stops reading it.
export function LocalMemoryPanel() {
  const [state, setState] = createSignal<LocalMemoryState>()
  const [confirming, setConfirming] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [unavailable, setUnavailable] = createSignal(false)

  const refresh = async () => {
    const bridge = api()
    if (!bridge) {
      setUnavailable(true)
      return
    }
    setState(await bridge.read().catch(() => undefined))
  }

  onMount(() => void refresh())

  const clear = async () => {
    const bridge = api()
    if (!bridge) return
    setBusy(true)
    setState(await bridge.clear().catch(() => undefined))
    setBusy(false)
    setConfirming(false)
  }

  return (
    <div class="flex flex-col gap-3">
      <div>
        <h3 class="text-[13px] font-semibold text-white">Local memory</h3>
        <p class="mt-1 text-[12px] leading-relaxed text-white/55">
          Vector remembers durable facts about how you work and carries them across every project and repository. This
          is stored only on this computer and is never uploaded.
        </p>
      </div>

      <Show
        when={!unavailable()}
        fallback={<p class="text-[12px] text-white/45">Local memory is available in the Vector desktop app.</p>}
      >
        <div class="rounded-[8px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)] px-3 py-2.5">
          <Show
            when={state()?.exists}
            fallback={<p class="text-[12px] text-white/50">Nothing remembered yet.</p>}
          >
            <div class="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-white/55">
              <span>
                <span class="text-white/80">{state()!.entries}</span> entries
              </span>
              <span>{formatBytes(state()!.bytes)}</span>
              <Show when={state()!.updatedAt}>
                <span>updated {new Date(state()!.updatedAt!).toLocaleDateString()}</span>
              </Show>
            </div>
            <div class="mt-1.5 truncate font-mono text-[10.5px] text-white/35" title={state()!.path}>
              {state()!.path}
            </div>
          </Show>
        </div>

        <Show when={state()?.exists && state()!.content}>
          <details class="rounded-[8px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)]">
            <summary class="cursor-pointer px-3 py-2 text-[12px] text-white/65">
              Show everything Vector remembers
            </summary>
            <pre class="max-h-[240px] overflow-auto whitespace-pre-wrap break-words border-t border-[color:var(--vx-line)] px-3 py-2.5 text-[11.5px] leading-relaxed text-white/70">
              {state()!.content}
            </pre>
          </details>
        </Show>

        <Show when={state()?.exists}>
          <Show
            when={confirming()}
            fallback={
              <button
                type="button"
                class="self-start rounded-[6px] border border-[color:var(--vx-line)] px-3 py-1.5 text-[12px] text-white/70 transition hover:border-rose-400/50 hover:text-rose-200"
                onClick={() => setConfirming(true)}
              >
                Clear application cache and erase memory
              </button>
            }
          >
            <div class="rounded-[8px] border border-rose-400/40 bg-rose-400/[0.07] px-3 py-2.5">
              <p class="text-[12px] text-rose-100">
                This permanently deletes everything Vector has remembered about you. It cannot be undone.
              </p>
              <div class="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={busy()}
                  class="rounded-[6px] bg-rose-500/85 px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
                  onClick={() => void clear()}
                >
                  {busy() ? "Erasing…" : "Erase everything"}
                </button>
                <button
                  type="button"
                  class="rounded-[6px] px-3 py-1.5 text-[12px] text-white/60 hover:text-white"
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  )
}
