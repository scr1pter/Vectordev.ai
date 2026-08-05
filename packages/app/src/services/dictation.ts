// Shared dictation engine for every mic surface (chat prompt, canvas voice bar).
//
// Engine choice is fixed per runtime:
// - Desktop (window.api present): ALWAYS the native recorder + on-device Whisper
//   transcription. Electron's Chromium exposes the SpeechRecognition constructor
//   but the engine needs Google's speech backend and always fails with "network",
//   so it must never be used there.
// - Web: the browser's SpeechRecognition engine, which also streams interim text.

import { getSpeechRecognitionCtor } from "@/utils/runtime-adapters"

export type DictationState = "listening" | "transcribing" | "idle"

export type DictationEndpointing = {
  silenceMs?: number
  minimumVoiceMs?: number
  minimumSpeechMs?: number
  maximumRecordingMs?: number
  minimumRms?: number
}

export type DictationHandlers = {
  onInterim?: (text: string) => void
  onFinal: (text: string) => void
  onError: (message: string) => void
  onState?: (state: DictationState) => void
  onLevel?: (level: number) => void
  onSpeechStart?: () => void
  endpointing?: DictationEndpointing
}

export type DictationHandle = {
  stop: () => void
  cancel: () => void
}

export type VoiceTurnState = "waiting" | "speaking" | "complete"

export function createVoiceTurnDetector(options: DictationEndpointing = {}) {
  const silenceMs = Math.max(500, options.silenceMs ?? 1_200)
  const minimumVoiceMs = Math.max(80, options.minimumVoiceMs ?? 160)
  const minimumSpeechMs = Math.max(minimumVoiceMs, options.minimumSpeechMs ?? 320)
  const minimumRms = Math.max(0.004, options.minimumRms ?? 0.012)
  let noiseFloor = 0.003
  let candidateAt: number | undefined
  let speechStartedAt: number | undefined
  let lastVoiceAt: number | undefined
  let state: VoiceTurnState = "waiting"

  return {
    sample(rms: number, now: number): VoiceTurnState {
      if (state === "complete") return state
      const amplitude = Number.isFinite(rms) ? Math.max(0, rms) : 0
      const threshold = Math.max(minimumRms, Math.min(0.08, noiseFloor * 3.2 + 0.003))
      const voiced = amplitude >= threshold

      if (!speechStartedAt && !voiced) noiseFloor = noiseFloor * 0.94 + amplitude * 0.06

      if (voiced) {
        candidateAt ??= now
        lastVoiceAt = now
        if (speechStartedAt === undefined && now - candidateAt >= minimumVoiceMs) {
          speechStartedAt = candidateAt
          state = "speaking"
        }
        return state
      }

      if (speechStartedAt === undefined) {
        candidateAt = undefined
        return state
      }

      if (
        lastVoiceAt !== undefined &&
        now - lastVoiceAt >= silenceMs &&
        now - speechStartedAt >= minimumSpeechMs
      ) {
        state = "complete"
      }
      return state
    },
  }
}

export function dictationAvailable(): boolean {
  return Boolean(globalThis.window?.api || getSpeechRecognitionCtor(globalThis))
}

// Starts one dictation. Resolves once the microphone is live (or undefined after
// reporting the failure through onError). stop() ends the utterance and delivers
// onFinal; cancel() tears everything down without delivering a transcript.
export function startDictation(handlers: DictationHandlers): Promise<DictationHandle | undefined> {
  if (globalThis.window?.api) return startDesktopDictation(handlers)
  return startBrowserDictation(handlers)
}

// ---- Desktop: native recorder + local Whisper -----------------------------

const MAX_RECORDING_MS = 30_000

async function startDesktopDictation(handlers: DictationHandlers): Promise<DictationHandle | undefined> {
  const api = globalThis.window?.api
  try {
    const permission = api?.requestMicrophonePermission
      ? await api.requestMicrophonePermission()
      : await api?.getMicrophonePermission?.()
    if (permission === "denied" || permission === "restricted") {
      handlers.onError(
        "Microphone access is blocked. Allow Vector under System Settings > Privacy & Security > Microphone, then restart Vector once.",
      )
      return undefined
    }
  } catch {
    // getUserMedia below remains the source of truth if the native bridge
    // cannot report a permission state on this platform.
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
  } catch (error) {
    const name = error instanceof DOMException ? error.name : ""
    handlers.onError(
      name === "NotFoundError"
        ? "No microphone found. Connect a microphone and try again."
        : "Microphone permission denied. Allow microphone access for Vector in system settings, then try again.",
    )
    return undefined
  }

  const AudioContextCtor = globalThis.AudioContext
  if (!AudioContextCtor) {
    stream.getTracks().forEach((track) => track.stop())
    handlers.onError("Audio recording is unavailable in this desktop runtime.")
    return undefined
  }

  let context: AudioContext
  let source: MediaStreamAudioSourceNode
  let processor: ScriptProcessorNode
  let sink: GainNode
  const chunks: Float32Array[] = []
  const turnDetector = handlers.endpointing ? createVoiceTurnDetector(handlers.endpointing) : undefined
  let turnState: VoiceTurnState = "waiting"
  let recordedSamples = 0
  let speechStartSample: number | undefined
  let speechEndSample: number | undefined
  let requestFinalize: (() => void) | undefined
  try {
    context = new AudioContextCtor()
    await context.resume()
    source = context.createMediaStreamSource(stream)
    processor = context.createScriptProcessor(4096, 1, 1)
    sink = context.createGain()
    sink.gain.value = 0
    processor.onaudioprocess = (event) => {
      const chunk = event.inputBuffer.getChannelData(0).slice()
      chunks.push(chunk)
      recordedSamples += chunk.length
      let energy = 0
      for (let index = 0; index < chunk.length; index += 8) energy += chunk[index] * chunk[index]
      const rms = Math.sqrt(energy / Math.ceil(chunk.length / 8))
      handlers.onLevel?.(Math.min(1, rms * 9))
      const nextTurnState = turnDetector?.sample(rms, performance.now())
      if (nextTurnState === "speaking" && turnState === "waiting") {
        speechStartSample = Math.max(0, recordedSamples - Math.round(context.sampleRate * 0.55))
        handlers.onSpeechStart?.()
      }
      if (nextTurnState === "complete" && turnState !== "complete") {
        speechEndSample = recordedSamples
        requestFinalize?.()
      }
      if (nextTurnState) turnState = nextTurnState
    }
    source.connect(processor)
    processor.connect(sink)
    sink.connect(context.destination)
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop())
    handlers.onError(error instanceof Error ? error.message : "Vector could not start the local recorder.")
    return undefined
  }

  let finished = false
  let timeout: ReturnType<typeof setTimeout> | undefined

  const teardown = async () => {
    if (timeout) clearTimeout(timeout)
    processor.onaudioprocess = null
    source.disconnect()
    processor.disconnect()
    sink.disconnect()
    stream.getTracks().forEach((track) => track.stop())
    await context.close().catch(() => undefined)
    handlers.onLevel?.(0)
  }

  const finalize = async () => {
    if (finished) return
    finished = true
    await teardown()
    if (turnDetector && speechStartSample === undefined) {
      handlers.onState?.("idle")
      handlers.onError("Didn't catch that. No speech was detected, so I'm still listening.")
      return
    }
    handlers.onState?.("transcribing")
    try {
      const { mergeAudioChunks, transcribeLocalAudio } = await import("@/services/local-transcription")
      const merged = mergeAudioChunks(chunks)
      const audio =
        speechStartSample === undefined
          ? merged
          : merged.slice(speechStartSample, Math.min(merged.length, speechEndSample ?? merged.length))
      if (audio.length < context.sampleRate / 5) {
        handlers.onState?.("idle")
        handlers.onError("Didn't catch that. Record a little longer, then tap the mic again.")
        return
      }
      const transcript = await transcribeLocalAudio(audio, context.sampleRate)
      handlers.onState?.("idle")
      if (!transcript) {
        handlers.onError("Didn't catch that. No speech was detected in the recording.")
        return
      }
      handlers.onFinal(transcript)
    } catch (error) {
      handlers.onState?.("idle")
      const message = error instanceof Error ? error.message : ""
      // Engine-startup failures arrive self-described from the worker ("Speech
      // model download failed (network): …" / "Speech engine failed to start:
      // …") — surface those as-is instead of re-prefixing them.
      handlers.onError(
        message
          ? message.startsWith("Speech ")
            ? message
            : `Transcription failed: ${message}`
          : "Vector could not transcribe this recording.",
      )
    }
  }

  // Cap recordings so a forgotten mic never records forever.
  requestFinalize = () => void finalize()
  timeout = setTimeout(() => void finalize(), handlers.endpointing?.maximumRecordingMs ?? MAX_RECORDING_MS)
  handlers.onState?.("listening")
  return {
    stop: () => void finalize(),
    cancel: () => {
      if (finished) return
      finished = true
      void teardown()
      handlers.onState?.("idle")
    },
  }
}

// ---- Web: browser SpeechRecognition ---------------------------------------

type SpeechRecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  abort: () => void
  onresult:
    | ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }> }) => void)
    | null
  onerror: ((event: { error?: string }) => void) | null
  onend: (() => void) | null
}

function browserErrorMessage(code: string) {
  if (code === "no-speech") return "Didn't catch that. No speech was detected — tap the mic and try again."
  if (code === "not-allowed" || code === "service-not-allowed")
    return "Microphone blocked. Check microphone permissions for Vector."
  if (code === "network") return "The speech service is unreachable. Check your network connection and try again."
  if (code === "audio-capture") return "No usable microphone. Check your audio input, then try again."
  return "Could not hear audio. Check microphone permission, then try again."
}

async function startBrowserDictation(handlers: DictationHandlers): Promise<DictationHandle | undefined> {
  const Ctor = getSpeechRecognitionCtor<SpeechRecognitionLike>(globalThis)
  if (!Ctor) {
    handlers.onError("Dictation is not available here. Use Vector in a Chromium browser or the desktop app.")
    return undefined
  }

  // Ask for the microphone up front so the user gets a real permission prompt
  // and we can distinguish denied from could-not-hear.
  try {
    const stream = await navigator.mediaDevices?.getUserMedia?.({ audio: true })
    stream?.getTracks().forEach((track) => track.stop())
  } catch (error) {
    const name = error instanceof DOMException ? error.name : ""
    handlers.onError(
      name === "NotFoundError"
        ? "No microphone found. Connect a microphone and try again."
        : "Microphone permission denied. Allow microphone access for Vector in your browser settings, then try again.",
    )
    return undefined
  }

  const recognition = new Ctor()
  recognition.lang = globalThis.navigator?.language || "en-US"
  recognition.continuous = false
  recognition.interimResults = true
  let finished = false
  let best = ""
  let speechStarted = false

  recognition.onresult = (event) => {
    let interim = ""
    let final = ""
    for (let i = 0; i < event.results.length; i++) {
      const alt = event.results[i]?.[0]?.transcript ?? ""
      // A settled result is marked isFinal; interimResults gives us the rest.
      if (event.results[i]?.isFinal) final += alt
      else interim += alt
    }
    if (final || interim) best = (final || interim).trim()
    if (!speechStarted && best) {
      speechStarted = true
      handlers.onSpeechStart?.()
    }
    handlers.onInterim?.((final || interim).trim())
  }
  recognition.onerror = (event) => {
    const code = event?.error ?? ""
    if (code === "aborted" || finished) return
    finished = true
    handlers.onState?.("idle")
    handlers.onError(browserErrorMessage(code))
  }
  recognition.onend = () => {
    if (finished) return
    finished = true
    handlers.onState?.("idle")
    handlers.onFinal(best.trim())
  }

  try {
    recognition.start()
  } catch {
    handlers.onError("Dictation failed to start. Another recording may be in progress — try again.")
    return undefined
  }
  handlers.onState?.("listening")
  return {
    stop: () => recognition.stop(),
    cancel: () => {
      finished = true
      handlers.onState?.("idle")
      recognition.abort()
    },
  }
}
