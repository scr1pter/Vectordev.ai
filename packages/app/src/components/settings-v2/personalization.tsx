import { createSignal, onMount, Show } from "solid-js"
import { LocalMemoryPanel } from "@/features/memory/local-memory-panel"

type CustomInstructionsState = {
  path: string
  exists: boolean
  bytes: number
  updatedAt?: string
  content: string
}

type CustomInstructionsApi = {
  read: () => Promise<CustomInstructionsState>
  write: (content: string) => Promise<CustomInstructionsState>
  clear: () => Promise<CustomInstructionsState>
}

function api(): CustomInstructionsApi | undefined {
  return (globalThis.window as unknown as { api?: { customInstructions?: CustomInstructionsApi } } | undefined)?.api
    ?.customInstructions
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

// Standing instructions the user wants applied to every session. This edits the
// global AGENTS.md the engine already loads as an instruction file on each
// prompt, so what is typed here genuinely reaches the model rather than being
// stored in a setting nothing reads.
export function SettingsPersonalizationV2() {
  const [state, setState] = createSignal<CustomInstructionsState>()
  const [draft, setDraft] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [saved, setSaved] = createSignal(false)
  const [unavailable, setUnavailable] = createSignal(false)

  const refresh = async () => {
    const bridge = api()
    if (!bridge) {
      setUnavailable(true)
      return
    }
    const next = await bridge.read().catch(() => undefined)
    if (!next) return
    setState(next)
    setDraft(next.content)
  }

  onMount(() => void refresh())

  const save = async () => {
    const bridge = api()
    if (!bridge || busy()) return
    setBusy(true)
    const next = await bridge.write(draft()).catch(() => undefined)
    setBusy(false)
    if (!next) return
    setState(next)
    setDraft(next.content)
    setSaved(true)
    setTimeout(() => setSaved(false), 2_000)
  }

  const clear = async () => {
    const bridge = api()
    if (!bridge || busy()) return
    setBusy(true)
    const next = await bridge.clear().catch(() => undefined)
    setBusy(false)
    if (!next) return
    setState(next)
    setDraft("")
  }

  return (
    <section class="settings-v2-page">
      <div class="settings-v2-page-hero">
        <div>
          <p class="settings-v2-page-kicker">Personalization</p>
          <h2 class="settings-v2-page-title">What Vector remembers about you</h2>
          <p class="settings-v2-page-subtitle">
            Standing instructions applied to every session, and what Vector has learned about how you work.
          </p>
        </div>
      </div>

      <div class="settings-v2-card settings-v2-card--wide">
        <div class="settings-v2-card-head">
          <div class="settings-v2-card-copy">
            <h3 class="settings-v2-card-title">Custom instructions</h3>
            <p class="settings-v2-card-description">
              Applied to every new session, in every repository — how you like code written, what to always check,
              what never to do.
            </p>
          </div>
        </div>
        <div class="settings-v2-card-body">
          <Show
            when={!unavailable()}
            fallback={
              <p class="settings-v2-card-description">
                Custom instructions are stored on your computer and activate once Vector connects to this workspace.
              </p>
            }
          >
            <textarea
              class="settings-v2-textarea" style={{ width: "100%" }}
              rows="10"
              placeholder="Always run the tests before telling me the work is done. Prefer small, focused commits."
              value={draft()}
              onInput={(event) => setDraft(event.currentTarget.value)}
            />
            <div class="settings-v2-action-grid">
              <button type="button" class="settings-v2-action" disabled={busy()} onClick={() => void save()}>
                {saved() ? "Saved" : "Save instructions"}
              </button>
              <Show when={state()?.exists}>
                <button type="button" class="settings-v2-action" disabled={busy()} onClick={() => void clear()}>
                  Clear
                </button>
              </Show>
            </div>
            <p class="settings-v2-card-description">
              <Show when={state()?.exists} fallback={<>Nothing saved yet. These are read by every new session.</>}>
                {formatBytes(state()!.bytes)} · read by every new session · {state()!.path}
              </Show>
            </p>
          </Show>
        </div>
      </div>

      <LocalMemoryPanel />
    </section>
  )
}
