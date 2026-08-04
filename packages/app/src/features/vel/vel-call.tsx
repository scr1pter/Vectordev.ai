import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { startDictation, type DictationHandle, type DictationState } from "@/services/dictation"

type VelMessage = { id: string; role: "you" | "vel"; text: string }

type VelModel = { providerID: string; modelID: string }

function extractText(value: unknown, depth = 0): string {
  if (!value || depth > 6) return ""
  if (typeof value === "string") return value.trim()
  if (Array.isArray(value)) return value.map((item) => extractText(item, depth + 1)).filter(Boolean).join("\n")
  if (typeof value !== "object") return ""
  const record = value as Record<string, unknown>
  for (const key of ["text", "content", "message", "output", "data", "parts", "part"]) {
    const text = extractText(record[key], depth + 1)
    if (text) return text
  }
  return ""
}

function cleanForSpeech(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, "I completed the requested code work.")
    .replace(/[*_#`>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900)
}

export function VelCall(props: {
  open: boolean
  directory: () => Promise<string>
  sessionId: () => string | undefined
  model: () => VelModel | undefined
  contextLabel: () => string
  onClose: () => void
}) {
  const serverSDK = useServerSDK()
  const [minimized, setMinimized] = createSignal(false)
  const [muted, setMuted] = createSignal(false)
  const [state, setState] = createSignal<DictationState | "thinking" | "speaking">("idle")
  const [level, setLevel] = createSignal(0)
  const [interim, setInterim] = createSignal("")
  const [error, setError] = createSignal("")
  const [messages, setMessages] = createSignal<VelMessage[]>([])
  let dictation: DictationHandle | undefined
  let opening = false

  const statusLabel = () => {
    if (error()) return "Needs attention"
    if (muted()) return "Microphone muted"
    if (state() === "listening") return "Listening"
    if (state() === "transcribing") return "Transcribing"
    if (state() === "thinking") return "Working with Vector"
    if (state() === "speaking") return "Speaking"
    return "Ready"
  }

  const stopAudio = () => {
    dictation?.cancel()
    dictation = undefined
    globalThis.window?.speechSynthesis?.cancel()
    setLevel(0)
    setState("idle")
  }

  const speak = (text: string) => {
    const synth = globalThis.window?.speechSynthesis
    const spoken = cleanForSpeech(text)
    if (!synth || !spoken) {
      setState("idle")
      if (!muted() && props.open) setTimeout(() => void beginListening(), 350)
      return
    }
    synth.cancel()
    const utterance = new SpeechSynthesisUtterance(spoken)
    utterance.rate = 1.03
    utterance.pitch = 1.04
    const voices = synth.getVoices()
    utterance.voice = voices.find((voice) => /Samantha|Ava|Serena|Google US English/i.test(voice.name)) ?? voices[0]
    utterance.onend = () => {
      setState("idle")
      if (!muted() && props.open) setTimeout(() => void beginListening(), 450)
    }
    utterance.onerror = utterance.onend
    setState("speaking")
    synth.speak(utterance)
  }

  const answer = async (transcript: string) => {
    const request = transcript.trim()
    if (!request) {
      setState("idle")
      return
    }
    setMessages((items) => [...items, { id: crypto.randomUUID(), role: "you", text: request }])
    setInterim("")
    setError("")
    setState("thinking")
    const directory = await props.directory().catch(() => "")
    const model = props.model()
    const sessionID = props.sessionId()
    if (!directory || !model || !sessionID) {
      const text = !directory
        ? "Open a Code repository or a Work task so I can act on its context."
        : !sessionID
          ? "Start this session by sending its first message, then call me again."
          : "Connect a model provider, then call me again."
      setMessages((items) => [...items, { id: crypto.randomUUID(), role: "vel", text }])
      speak(text)
      return
    }
    try {
      const client = serverSDK().createClient({ directory, throwOnError: true })
      const result = await client.session.prompt({
        sessionID,
        directory,
        agent: "build",
        model,
        parts: [{ type: "text", text: request }],
      })
      const text = extractText(result.data) || "I finished that step. Check the active Vector session for the result."
      setMessages((items) => [...items, { id: crypto.randomUUID(), role: "vel", text }])
      speak(text)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Vel could not reach the active agent."
      setError(message)
      setMessages((items) => [...items, { id: crypto.randomUUID(), role: "vel", text: message }])
      setState("idle")
    }
  }

  async function beginListening() {
    if (!props.open || muted() || opening || ["listening", "transcribing", "thinking", "speaking"].includes(state())) return
    opening = true
    setError("")
    const started = await startDictation({
      onInterim: setInterim,
      onFinal: (text) => void answer(text),
      onError: (message) => {
        setError(message)
        setState("idle")
      },
      onState: setState,
      onLevel: setLevel,
    })
    dictation = started
    opening = false
  }

  createEffect(() => {
    if (!props.open) {
      stopAudio()
      setMinimized(false)
      setMuted(false)
      setInterim("")
      return
    }
    queueMicrotask(() => void beginListening())
  })

  onCleanup(stopAudio)

  const toggleMute = () => {
    const next = !muted()
    setMuted(next)
    if (next) stopAudio()
    else void beginListening()
  }

  const endCall = () => {
    stopAudio()
    props.onClose()
  }

  return (
    <Show when={props.open}>
      <Show
        when={!minimized()}
        fallback={
          <button type="button" class="vector-vel-mini" onClick={() => setMinimized(false)} aria-label="Return to Vel call">
            <span classList={{ active: state() === "listening" }}><img src="/vector-logo.png" alt="" /></span>
            <span><strong>Vel</strong><small>{statusLabel()}</small></span>
            <i />
          </button>
        }
      >
        <section class="vector-vel-call" role="dialog" aria-modal="true" aria-label="Call Vel">
          <div class="vector-vel-call__backdrop" aria-hidden="true" />
          <header>
            <button type="button" onClick={() => setMinimized(true)} aria-label="Minimize Vel"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" /></svg></button>
            <div><img src="/vector-logo.png" alt="" /><span>Vel</span></div>
            <button type="button" onClick={endCall} aria-label="End call"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" /></svg></button>
          </header>

          <div class="vector-vel-call__stage">
            <div class="vector-vel-call__mark" classList={{ listening: state() === "listening", thinking: state() === "thinking", speaking: state() === "speaking" }}>
              <img src="/vector-logo.png" alt="" />
              <span aria-hidden="true" />
              <i aria-hidden="true" />
            </div>
            <p>{statusLabel()}</p>
            <small>{props.contextLabel()}</small>
            <div class="vector-vel-call__wave" aria-hidden="true">
              <For each={Array.from({ length: 26 })}>{(_, index) => <i style={{ height: `${Math.max(4, 6 + level() * (8 + (index() % 7) * 3))}px` }} />}</For>
            </div>
            <Show when={interim()}><div class="vector-vel-call__interim">{interim()}</div></Show>
            <Show when={error()}><div class="vector-vel-call__error">{error()}</div></Show>
          </div>

          <div class="vector-vel-call__transcript">
            <For each={messages().slice(-4)}>{(message) => <p data-role={message.role}><span>{message.role === "you" ? "You" : "Vel"}</span>{message.text}</p>}</For>
          </div>

          <footer>
            <button type="button" classList={{ active: muted() }} onClick={toggleMute}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 12.2a3.1 3.1 0 0 0 3.1-3.1V5.5a3.1 3.1 0 0 0-6.2 0v3.6a3.1 3.1 0 0 0 3.1 3.1Zm-5-3a5 5 0 0 0 10 0M10 14.2v3M7.5 17.2h5" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" /></svg>
              <span>{muted() ? "Unmute" : "Mute"}</span>
            </button>
            <button type="button" class="end" onClick={endCall}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.2 12.7c3.5-2.5 8.1-2.5 11.6 0l1.3-2.1C13 7.4 7 7.4 2.9 10.6l1.3 2.1Zm1.2-.8-.4 3m9.6-3 .4 3" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" /></svg>
              <span>End</span>
            </button>
          </footer>
        </section>
      </Show>
    </Show>
  )
}
