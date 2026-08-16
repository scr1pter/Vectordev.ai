import { createSignal, For, Show } from "solid-js"
import { helpContextFor, helpDocs } from "./help-retrieval"

type HelpTurn = { role: "user" | "assistant"; content: string }
type HelpApi = {
  askHelpAssistant?: (input: { messages: HelpTurn[]; context: string }) => Promise<{ reply?: string; error?: string }>
}

// Desktop routes through the main process; the web build is same-origin.
async function askAssistant(messages: HelpTurn[], context: string) {
  const api = (globalThis.window as unknown as { api?: HelpApi } | undefined)?.api
  if (api?.askHelpAssistant) return api.askHelpAssistant({ messages, context })

  const response = await fetch("/api/help/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages, context }),
  }).catch(() => undefined)
  if (!response) return { error: "Vector could not reach the help assistant." }
  const body = (await response.json().catch(() => undefined)) as
    | { reply?: string; error?: { message?: string } }
    | undefined
  if (!response.ok) return { error: body?.error?.message ?? "The help assistant is unavailable right now." }
  return { reply: body?.reply }
}

const SUGGESTIONS = [
  "How do I run agents in parallel?",
  "Where is the code editor?",
  "How do I connect a model provider?",
]

export function HelpPanel(props: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = createSignal<"assistant" | "docs">("assistant")
  const [turns, setTurns] = createSignal<HelpTurn[]>([])
  const [draft, setDraft] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [openDoc, setOpenDoc] = createSignal<string>()

  const ask = async (question: string) => {
    const trimmed = question.trim()
    if (!trimmed || busy()) return
    setDraft("")
    setError(undefined)
    const next = [...turns(), { role: "user" as const, content: trimmed }]
    setTurns(next)
    setBusy(true)
    // Ground every question in the same documentation the Docs tab renders,
    // so the assistant cannot describe a control the user cannot look up.
    const result = await askAssistant(next, helpContextFor(trimmed))
    setBusy(false)
    if (!result.reply) {
      setError(result.error ?? "The help assistant returned nothing.")
      return
    }
    setTurns((items) => [...items, { role: "assistant", content: result.reply! }])
  }

  return (
    <aside
      data-vector-help-panel
      aria-hidden={!props.open}
      inert={!props.open}
      aria-label="Vector Help AI Assistant"
      class="fixed bottom-0 right-0 top-0 z-40 flex w-[380px] max-w-[92vw] flex-col border-l border-[color:var(--vx-line)] bg-[color:var(--vx-sidebar)] backdrop-blur-2xl transition duration-200"
      classList={{
        "translate-x-0 opacity-100": props.open,
        "pointer-events-none translate-x-4 opacity-0": !props.open,
      }}
    >
      <header class="flex h-16 shrink-0 items-center gap-2 border-b border-[color:var(--vx-line)] px-4">
        <div class="min-w-0 flex-1">
          <div class="truncate text-[13px] font-semibold text-white">Vector Help AI Assistant</div>
          <div class="truncate text-[11px] text-white/45">Answers only from Vector's documentation</div>
        </div>
        <button
          type="button"
          aria-label="Close help"
          class="grid size-7 place-items-center rounded-[5px] text-white/45 transition hover:bg-white/[0.06] hover:text-white"
          onClick={props.onClose}
        >
          <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
            <path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </button>
      </header>

      <div class="flex shrink-0 gap-1 border-b border-[color:var(--vx-line)] px-3 py-2">
        <For each={["assistant", "docs"] as const}>
          {(value) => (
            <button
              type="button"
              class="rounded-[5px] px-2.5 py-1 text-[12px] capitalize transition"
              classList={{
                "bg-[color:var(--vx-purple)] text-white": tab() === value,
                "text-white/50 hover:text-white": tab() !== value,
              }}
              onClick={() => setTab(value)}
            >
              {value === "assistant" ? "Assistant" : "Documentation"}
            </button>
          )}
        </For>
      </div>

      <Show
        when={tab() === "assistant"}
        fallback={
          <div class="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            <For each={helpDocs}>
              {(doc) => (
                <div class="mb-1.5 rounded-[6px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)]">
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 px-3 py-2 text-left"
                    onClick={() => setOpenDoc((current) => (current === doc.id ? undefined : doc.id))}
                    aria-expanded={openDoc() === doc.id}
                  >
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-[12.5px] font-medium text-white">{doc.title}</span>
                      <span class="block truncate text-[11px] text-white/40">{doc.kicker}</span>
                    </span>
                  </button>
                  <Show when={openDoc() === doc.id}>
                    <div class="border-t border-[color:var(--vx-line)] px-3 py-2.5">
                      <p class="mb-2 text-[11.5px] text-[color:var(--vx-purple-bright)]">{doc.where}</p>
                      <p class="text-[12px] leading-relaxed text-white/70">{doc.body}</p>
                      <Show when={doc.tip}>
                        <p class="mt-2 text-[11.5px] italic text-white/45">{doc.tip}</p>
                      </Show>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        }
      >
        <div class="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <Show when={turns().length === 0}>
            <p class="mb-3 text-[12px] leading-relaxed text-white/50">
              Ask about anything in Vector — where a control lives, how a feature works, or what to do next.
            </p>
            <For each={SUGGESTIONS}>
              {(suggestion) => (
                <button
                  type="button"
                  class="mb-1.5 w-full rounded-[6px] border border-[color:var(--vx-line)] px-3 py-2 text-left text-[12px] text-white/65 transition hover:border-[color:var(--vx-purple)] hover:text-white"
                  onClick={() => void ask(suggestion)}
                >
                  {suggestion}
                </button>
              )}
            </For>
          </Show>

          <For each={turns()}>
            {(turn) => (
              <div
                class="mb-2.5 rounded-[6px] px-3 py-2 text-[12px] leading-relaxed"
                classList={{
                  "bg-[color:var(--vx-purple)]/18 text-white": turn.role === "user",
                  "bg-[color:var(--vx-surface)] text-white/78 whitespace-pre-wrap": turn.role === "assistant",
                }}
              >
                {turn.content}
              </div>
            )}
          </For>

          <Show when={busy()}>
            <div class="px-1 text-[12px] text-white/40">Thinking…</div>
          </Show>
          <Show when={error()}>
            <div class="px-1 text-[12px] text-rose-300">{error()}</div>
          </Show>
        </div>

        <div class="shrink-0 border-t border-[color:var(--vx-line)] p-3">
          <textarea
            rows={2}
            value={draft()}
            placeholder="Ask about Vector…"
            class="w-full resize-none rounded-[6px] border border-[color:var(--vx-line)] bg-[color:var(--vx-canvas)] p-2 text-[12px] text-white outline-none placeholder:text-white/28 focus:border-[color:var(--vx-purple)]"
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return
              event.preventDefault()
              void ask(draft())
            }}
          />
        </div>
      </Show>
    </aside>
  )
}
