import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { startDictation, type DictationHandle, type DictationState } from "@/services/dictation"
import type { Session } from "@opencode-ai/sdk/v2"
import { VEL_VOICE_SYSTEM } from "./vel-message"

type VelMessage = { id: string; role: "you" | "vel"; text: string }

type VelModel = { providerID: string; modelID: string }

export function extractVelReply(value: unknown, depth = 0): string {
  if (!value || depth > 6) return ""
  if (typeof value === "string") return value.trim()
  if (Array.isArray(value)) {
    return value
      .map((item) => extractVelReply(item, depth + 1))
      .filter(Boolean)
      .join("\n")
      .trim()
  }
  if (typeof value !== "object") return ""
  const record = value as Record<string, unknown>
  if (record.type === "text" && typeof record.text === "string") return record.text.trim()
  if (Array.isArray(record.parts)) {
    const text = record.parts
      .filter((part) => typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "text")
      .map((part) => extractVelReply(part, depth + 1))
      .filter(Boolean)
      .join("\n")
      .trim()
    if (text) return text
  }
  for (const key of ["text", "content", "message", "data", "response"]) {
    const text = extractVelReply(record[key], depth + 1)
    if (text) return text
  }
  return ""
}

export function extractLatestVelReply(value: unknown) {
  if (!Array.isArray(value)) return extractVelReply(value)
  for (const item of [...value].reverse()) {
    if (!item || typeof item !== "object") continue
    const record = item as Record<string, unknown>
    const info = record.info
    if (!info || typeof info !== "object" || (info as Record<string, unknown>).role !== "assistant") continue
    const text = extractVelReply(record.parts)
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
  agent: () => string
  contextLabel: () => string
  onSessionCreated?: (session: Session, directory: string) => void
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
  let wasOpen = false
  let speechRun = 0
  let requestRun = 0

  const statusLabel = () => {
    if (state() === "listening") return "Listening"
    if (state() === "transcribing") return "Transcribing"
    if (state() === "thinking") return "Working with Vector"
    if (state() === "speaking") return "Speaking"
    if (error()) return "Needs attention"
    if (muted()) return "Microphone muted"
    return "Ready"
  }

  const stopListening = () => {
    dictation?.cancel()
    dictation = undefined
    setLevel(0)
  }

  const stopSpeech = () => {
    speechRun += 1
    void globalThis.window?.api?.voice?.stop().catch(() => undefined)
    globalThis.window?.speechSynthesis?.cancel()
  }

  const stopAudio = (cancelRequest = false) => {
    stopListening()
    stopSpeech()
    if (cancelRequest) requestRun += 1
    setLevel(0)
    setState("idle")
  }

  const browserSpeak = (text: string) => {
    const synth = globalThis.window?.speechSynthesis
    if (!synth || typeof SpeechSynthesisUtterance === "undefined") return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      synth.cancel()
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.rate = 1.03
      utterance.pitch = 1.04
      const voices = synth.getVoices()
      utterance.voice = voices.find((voice) => /Samantha|Ava|Serena|Google US English/i.test(voice.name)) ?? voices[0]
      let settled = false
      const finish = (spoken: boolean) => {
        if (settled) return
        settled = true
        globalThis.clearTimeout(timeout)
        resolve(spoken)
      }
      const timeout = globalThis.setTimeout(
        () => {
          synth.cancel()
          finish(false)
        },
        Math.max(4_000, text.length * 95),
      )
      utterance.onend = () => finish(true)
      utterance.onerror = () => finish(false)
      synth.speak(utterance)
    })
  }

  const speak = async (
    text: string,
    options: { resumeListening?: boolean; afterState?: DictationState | "thinking" } = {},
  ) => {
    const spoken = cleanForSpeech(text)
    const run = ++speechRun
    if (!spoken) return false
    stopListening()
    globalThis.window?.speechSynthesis?.cancel()
    setState("speaking")

    let played = false
    const native = globalThis.window?.api?.voice
    if (native) {
      const result = await native.speak(spoken).catch(() => ({ status: "failed" as const }))
      if (run !== speechRun) return false
      played = result.status === "spoken"
      if (!played && result.status !== "stopped") played = await browserSpeak(spoken)
    } else {
      played = await browserSpeak(spoken)
    }

    if (run !== speechRun) return played
    setState(options.afterState ?? "idle")
    if (options.resumeListening && !muted() && props.open) {
      globalThis.setTimeout(() => void beginListening(), 420)
    }
    return played
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
    if (!directory || !model) {
      const text = !directory
        ? "Open a repository session so I can act on its context."
        : "Connect a model provider, then call me again."
      setMessages((items) => [...items, { id: crypto.randomUUID(), role: "vel", text }])
      await speak(text, { resumeListening: true })
      return
    }
    try {
      const client = serverSDK().createClient({ directory, throwOnError: true })
      let sessionID = props.sessionId()
      if (!sessionID) {
        const created = await client.session.create().then((result) => result.data ?? undefined)
        if (!created) throw new Error("Vector could not create a session for this voice request.")
        sessionID = created.id
        props.onSessionCreated?.(created, directory)
      }
      const acknowledgement = "Got it. I'm handing that to the Vector agent in this session now."
      setMessages((items) => [...items, { id: crypto.randomUUID(), role: "vel", text: acknowledgement }])
      const run = ++requestRun
      const acknowledgementSpeech = speak(acknowledgement, { afterState: "thinking" })
      const requestPromise = client.session
        .prompt({
          sessionID,
          directory,
          agent: props.agent(),
          model,
          system: VEL_VOICE_SYSTEM,
          parts: [{ type: "text", text: request }],
        })
        .then(
          (result) => ({ result }),
          (cause: unknown) => ({ cause }),
        )
      await acknowledgementSpeech
      const outcome = await requestPromise
      if ("cause" in outcome) throw outcome.cause
      const result = outcome.result
      if (run !== requestRun || !props.open) return
      let text = extractVelReply(result.data)
      if (!text) {
        const history = await client.session.messages({ sessionID, limit: 12 }).catch(() => undefined)
        text = extractLatestVelReply(history?.data)
      }
      text ||= "I finished that step. The completed result is visible in this Vector session."
      setMessages((items) => [...items, { id: crypto.randomUUID(), role: "vel", text }])
      await speak(text, { resumeListening: true })
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "Vel could not reach the active agent."
      const message = "I couldn't complete that request. The active session shows what needs attention."
      setError(detail)
      setMessages((items) => [...items, { id: crypto.randomUUID(), role: "vel", text: message }])
      await speak(message, { resumeListening: true })
    }
  }

  async function beginListening() {
    if (!props.open || muted() || opening || ["listening", "transcribing", "thinking", "speaking"].includes(state()))
      return
    opening = true
    setError("")
    const started = await startDictation({
      onInterim: setInterim,
      onFinal: (text) => void answer(text),
      onError: (message) => {
        if (/no speech|didn't catch/i.test(message) && props.open && !muted()) {
          setError("")
          setState("idle")
          globalThis.setTimeout(() => void beginListening(), 320)
          return
        }
        setError(message)
        setState("idle")
      },
      onState: setState,
      onLevel: setLevel,
      onSpeechStart: () => setError(""),
      endpointing: {
        silenceMs: 1_250,
        minimumVoiceMs: 160,
        minimumSpeechMs: 320,
        maximumRecordingMs: 60_000,
      },
    })
    dictation = started
    opening = false
  }

  createEffect(() => {
    if (!props.open) {
      stopAudio(true)
      wasOpen = false
      setMinimized(false)
      setMuted(false)
      setInterim("")
      return
    }
    if (wasOpen) return
    wasOpen = true
    setMessages([])
    const greeting = "Hi, I'm Vel. Tell me what you'd like me to build, change, or do in this session."
    setMessages([{ id: crypto.randomUUID(), role: "vel", text: greeting }])
    queueMicrotask(() => void speak(greeting, { resumeListening: true }))
  })

  onCleanup(() => stopAudio(true))

  const interruptSpeech = () => {
    stopSpeech()
    setMuted(false)
    setState("idle")
    globalThis.setTimeout(() => void beginListening(), 80)
  }

  const toggleMute = () => {
    if (state() === "speaking") {
      interruptSpeech()
      return
    }
    const next = !muted()
    setMuted(next)
    if (next) {
      stopListening()
      if (state() === "listening" || state() === "transcribing") setState("idle")
    } else void beginListening()
  }

  const endCall = () => {
    stopAudio(true)
    props.onClose()
  }

  return (
    <Show when={props.open}>
      <Show
        when={!minimized()}
        fallback={
          <button
            type="button"
            class="vector-vel-mini"
            onClick={() => setMinimized(false)}
            aria-label="Return to Vel call"
          >
            <span classList={{ active: state() === "listening" }}>
              <img src="/vector-logo.png" alt="" />
            </span>
            <span>
              <strong>Vel</strong>
              <small>{statusLabel()}</small>
            </span>
            <i />
          </button>
        }
      >
        <section class="vector-vel-call" role="dialog" aria-modal="true" aria-label="Call Vel">
          <div class="vector-vel-call__backdrop" aria-hidden="true" />
          <header>
            <button type="button" onClick={() => setMinimized(true)} aria-label="Minimize Vel">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 8h10" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
              </svg>
            </button>
            <div>
              <img src="/vector-logo.png" alt="" />
              <span>Vel</span>
            </div>
            <button type="button" onClick={endCall} aria-label="End call">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="m4.5 4.5 7 7m0-7-7 7"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.25"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </header>

          <div class="vector-vel-call__stage">
            <div
              class="vector-vel-call__mark"
              classList={{
                listening: state() === "listening",
                thinking: state() === "thinking",
                speaking: state() === "speaking",
              }}
            >
              <img src="/vector-logo.png" alt="" />
              <span aria-hidden="true" />
              <i aria-hidden="true" />
            </div>
            <p>{statusLabel()}</p>
            <small>{props.contextLabel()}</small>
            <div class="vector-vel-call__wave" aria-hidden="true">
              <For each={Array.from({ length: 26 })}>
                {(_, index) => <i style={{ height: `${Math.max(4, 6 + level() * (8 + (index() % 7) * 3))}px` }} />}
              </For>
            </div>
            <Show when={interim()}>
              <div class="vector-vel-call__interim">{interim()}</div>
            </Show>
            <Show when={error()}>
              <div class="vector-vel-call__error">{error()}</div>
            </Show>
          </div>

          <div class="vector-vel-call__transcript">
            <For each={messages().slice(-6)}>
              {(message) => (
                <p data-role={message.role}>
                  <span>{message.role === "you" ? "You" : "Vel"}</span>
                  {message.text}
                </p>
              )}
            </For>
          </div>

          <footer>
            <button type="button" classList={{ active: muted() }} onClick={toggleMute}>
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path
                  d="M10 12.2a3.1 3.1 0 0 0 3.1-3.1V5.5a3.1 3.1 0 0 0-6.2 0v3.6a3.1 3.1 0 0 0 3.1 3.1Zm-5-3a5 5 0 0 0 10 0M10 14.2v3M7.5 17.2h5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.35"
                  stroke-linecap="round"
                />
              </svg>
              <span>{state() === "speaking" ? "Interrupt" : muted() ? "Unmute mic" : "Mute mic"}</span>
            </button>
            <button type="button" class="end" onClick={endCall}>
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path
                  d="M4.2 12.7c3.5-2.5 8.1-2.5 11.6 0l1.3-2.1C13 7.4 7 7.4 2.9 10.6l1.3 2.1Zm1.2-.8-.4 3m9.6-3 .4 3"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.45"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <span>End</span>
            </button>
          </footer>
        </section>
      </Show>
    </Show>
  )
}
