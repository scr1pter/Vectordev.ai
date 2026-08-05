// The Canvas voice assistant: speech-to-text in, an LLM that decides which
// canvas actions to take, and speech-synthesis out — powered by whatever model
// the user picked. STT/TTS degrade gracefully so the assistant is still fully
// usable by typing when no dictation engine is available.

import { CANVAS_WINDOWS, type CanvasAction, type CanvasAssistantReply } from "./canvas-types"
import {
  dictationAvailable,
  startDictation as startSharedDictation,
  type DictationHandle,
  type DictationState,
} from "@/services/dictation"
import { INTERNAL_SESSION_TITLE_PREFIX } from "@/utils/internal-sessions"

// ---- Speech recognition (STT) -------------------------------------------
// Delegated to the shared dictation service: desktop records natively and
// transcribes on-device with Whisper (Electron's SpeechRecognition engine
// always fails with "network"); the web build uses browser SpeechRecognition.

export function speechRecognitionAvailable(): boolean {
  return dictationAvailable()
}

export type Dictation = {
  stop: () => void
  cancel: () => void
}

// Starts one dictation. onInterim streams the live partial transcript (the
// desktop engine has no interim text — it narrates "Transcribing…" instead);
// onFinal fires once with the settled utterance.
export function startDictation(handlers: {
  onInterim: (text: string) => void
  onFinal: (text: string) => void
  onError: (message: string) => void
  onState?: (state: DictationState) => void
  onLevel?: (level: number) => void
}): Dictation | undefined {
  if (!dictationAvailable()) return undefined

  // The shared engine starts asynchronously (permission prompt, recorder
  // setup). Hand back a proxy handle right away and forward stop/cancel once
  // the engine is live; failures surface through onError as usual.
  let handle: DictationHandle | undefined
  let queued: "stop" | "cancel" | undefined
  void startSharedDictation({
    onInterim: handlers.onInterim,
    onFinal: handlers.onFinal,
    onError: handlers.onError,
    onState: handlers.onState,
    onLevel: handlers.onLevel,
  }).then((started) => {
    handle = started
    if (!started) return
    if (queued === "cancel") started.cancel()
    else if (queued === "stop") started.stop()
  })
  return {
    stop: () => {
      if (handle) handle.stop()
      else queued = "stop"
    },
    cancel: () => {
      if (handle) handle.cancel()
      else queued = "cancel"
    },
  }
}

// ---- Speech synthesis (TTS) ---------------------------------------------

export function speak(text: string) {
  const synth = globalThis.window?.speechSynthesis
  if (!synth || !text.trim()) return
  synth.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.rate = 1.03
  utterance.pitch = 1
  // Prefer a crisp English voice when one is installed; fall back to default.
  const voice = synth.getVoices().find((v) => /Samantha|Google US English|Daniel|Alex/.test(v.name))
  if (voice) utterance.voice = voice
  synth.speak(utterance)
}

export function stopSpeaking() {
  globalThis.window?.speechSynthesis?.cancel()
}

// ---- The reasoning brain -------------------------------------------------

type AssistantSessionClient = {
  session: {
    create: (input: {
      directory: string
      title: string
      agent: string
      model: { providerID: string; id: string }
      metadata: Record<string, unknown>
    }) => Promise<{ data?: { id?: string } }>
    prompt: (input: {
      sessionID: string
      directory: string
      agent: string
      model: { providerID: string; modelID: string }
      system: string
      tools: Record<string, boolean>
      parts: { type: "text"; text: string }[]
    }) => Promise<{ data?: unknown }>
  }
}

function extractText(value: unknown, depth = 0): string {
  if (!value || depth > 6) return ""
  if (typeof value === "string") return value.trim()
  if (Array.isArray(value))
    return value
      .map((item) => extractText(item, depth + 1))
      .filter(Boolean)
      .join("\n")
  if (typeof value !== "object") return ""
  const record = value as Record<string, unknown>
  for (const key of ["text", "content", "message", "output", "data", "parts", "part"]) {
    const text = extractText(record[key], depth + 1)
    if (text) return text
  }
  return ""
}

const WINDOW_KINDS = CANVAS_WINDOWS.map((w) => w.kind)

function coerceReply(text: string): CanvasAssistantReply | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const source = (fenced || text).trim()
  const json = source.startsWith("{") ? source : source.match(/\{[\s\S]*\}/)?.[0]
  if (!json) return undefined
  const parsed = JSON.parse(json) as Partial<CanvasAssistantReply>
  const actions = Array.isArray(parsed.actions)
    ? parsed.actions.filter((action): action is CanvasAction => {
        if (!action || typeof action !== "object") return false
        const record = action as Record<string, unknown>
        const type = record.type
        if (type === "open_window" || type === "close_window")
          return typeof record.kind === "string" && (WINDOW_KINDS as string[]).includes(record.kind)
        if (type === "prompt_vector_agent") return typeof record.text === "string"
        if (type === "navigate_preview") return typeof record.url === "string"
        if (type === "write_note") return typeof record.text === "string"
        if (type === "delegate_parallel") return typeof record.task === "string"
        if (type === "deploy") return true
        if (type === "arrange")
          return typeof record.layout === "string" && ["grid", "focus", "clear"].includes(record.layout)
        return false
      })
    : []
  return {
    say: typeof parsed.say === "string" && parsed.say.trim() ? parsed.say.trim() : "Done.",
    actions: actions.slice(0, 6),
  }
}

// A local fallback so the assistant still does the obvious thing when the model
// returns prose instead of JSON, or when no model is connected at all.
export function localIntent(transcript: string): CanvasAssistantReply {
  const lower = transcript.toLowerCase()
  const actions: CanvasAction[] = []
  const openHits: string[] = []
  const OPEN_WORDS = /\b(open|show|pull up|bring up|add|launch|start)\b/
  const aliases: Record<string, string> = {
    "vector-agent": "vector agent|agent|chat|assistant",
    preview: "preview|running app|live app",
    notes: "note|notes|sticky",
    parallel: "parallel|workspaces|delegate",
    cloud: "cloud|deploy|publish",
    codespace: "code editor|codespace|editor",
    terminal: "terminal|shell|console",
    review: "review|diff|changes",
    scheduled: "schedule|scheduled|cron|later",
    mcp: "mcp|tools server|connector",
    "claude-code": "claude code|claude",
    codex: "codex",
    cursor: "cursor",
  }
  if (OPEN_WORDS.test(lower)) {
    for (const spec of CANVAS_WINDOWS) {
      const pattern = aliases[spec.kind]
      // Word-bound the whole alternation: without \b, "review" matches inside
      // "preview" and every "open preview" also launched the Review surface.
      if (!pattern || !new RegExp(`\\b(?:${pattern})\\b`).test(lower)) continue
      // "browser agent" contains the word "agent" — don't also open the
      // generic Vector Agent chat unless it was asked for by name.
      if (
        spec.kind === "vector-agent" &&
        /\bbrowser\s+agent\b/.test(lower) &&
        !/\b(?:vector agent|chat|assistant)\b/.test(lower)
      )
        continue
      actions.push({ type: "open_window", kind: spec.kind })
      openHits.push(spec.label)
    }
  }
  // "navigate to X" / "preview localhost:3000" / "open cnvs.dev" → drive preview.
  const navMatch =
    transcript.match(/\b(?:navigate|go|browse)\s+to\s+(\S+)/i) ||
    transcript.match(/\bpreview\s+(?:of\s+)?((?:https?:\/\/)?[\w.-]+\.[a-z]{2,}\S*|localhost:\d+\S*)/i) ||
    transcript.match(/\bopen\s+((?:https?:\/\/)?[\w.-]+\.[a-z]{2,}\S*|localhost:\d+\S*)/i)
  if (navMatch) {
    const url = navMatch[1].replace(/[.,!?]+$/, "")
    actions.push({ type: "navigate_preview", url })
    if (!openHits.includes("Browser")) openHits.push("Browser")
  }
  // "write a note …" / "note that …" / "jot down …" → drop text on a note.
  const noteMatch =
    transcript.match(/\b(?:write|make|add|leave)?\s*(?:a\s+)?note(?:\s+that|\s+saying|:)?\s+(.+)/i) ||
    transcript.match(/\bjot(?:\s+down)?\s+(.+)/i)
  if (noteMatch && noteMatch[1].trim().length > 1) {
    actions.push({ type: "write_note", text: noteMatch[1].trim() })
    if (!openHits.includes("Notes")) openHits.push("Notes")
  }
  // Delegation needs an explicit hand-off verb — not merely naming the surface,
  // which the open-window branch above already handles.
  if (
    !openHits.includes("New Agent") &&
    /\b(delegate|spin up|in parallel|in the background|isolated agent)\b/.test(lower)
  ) {
    actions.push({ type: "delegate_parallel", task: transcript })
  }
  if (/\b(deploy|publish|ship it)\b/.test(lower) && !openHits.includes("Cloud Services")) {
    actions.push({ type: "deploy" })
  }
  if (/\b(clear|clean up|close everything|reset)\b/.test(lower)) {
    actions.push({ type: "arrange", layout: "clear" })
  } else if (/\b(tidy|arrange|grid|organize|organise)\b/.test(lower)) {
    actions.push({ type: "arrange", layout: "grid" })
  }
  // Anything that isn't a canvas command is treated as a task for the agent.
  if (actions.length === 0 && transcript.trim()) {
    actions.push({ type: "open_window", kind: "vector-agent" })
    actions.push({ type: "prompt_vector_agent", text: transcript, submit: true })
    return { say: "I'll pass that to the Vector agent.", actions }
  }
  const say = openHits.length
    ? `Opening ${openHits.join(", ")}.`
    : actions.some((a) => a.type === "delegate_parallel")
      ? "Preparing that for an isolated agent."
      : actions.some((a) => a.type === "deploy")
        ? "Taking you to publish this."
        : "Done."
  return { say, actions }
}

const ASSISTANT_SYSTEM = [
  "You are Vector's Canvas assistant. The user speaks to you; you arrange their workspace and drive their agents by returning canvas actions.",
  "Return JSON ONLY: {say:string, actions:Array<object>}. `say` is a short spoken reply (one or two sentences, friendly, no markdown).",
  "Allowed actions:",
  '- {"type":"open_window","kind":K} where K is one of: vector-agent, preview, notes, parallel, cloud, codespace, terminal, review, scheduled, mcp, claude-code, codex, cursor.',
  '- {"type":"close_window","kind":K}.',
  '- {"type":"prompt_vector_agent","text":string,"submit":boolean} — write a prompt into the Vector agent window (opens it if needed). Use this when the user wants the agent to build, fix, or explain something.',
  '- {"type":"navigate_preview","url":string} — open the Browser window and load a URL the user named.',
  '- {"type":"write_note","text":string} — open a Notes window and write the given text into it.',
  '- {"type":"delegate_parallel","task":string} — hand an isolated task to a parallel workspace.',
  '- {"type":"deploy"} — take the user to publish/deploy their app.',
  '- {"type":"arrange","layout":"grid"|"focus"|"clear"} — tidy, focus, or clear the canvas.',
  "Prefer prompt_vector_agent for any coding/build request. Prefer delegate_parallel when the user says to delegate, parallelize, or run something in the background.",
  "Keep actions minimal and only what the user asked for. Never invent windows or actions outside the list. If the user is only chatting, return an empty actions array and answer in `say`.",
].join("\n")

export function createCanvasAssistant(deps: {
  createClient: (directory: string) => AssistantSessionClient
  resolveDirectory: () => Promise<string>
  model: () => { providerID: string; modelID: string } | undefined
}) {
  let sessionID: string | undefined
  let sessionDirectory: string | undefined

  const reset = () => {
    sessionID = undefined
    sessionDirectory = undefined
  }

  const respond = async (transcript: string, openWindows: string[]): Promise<CanvasAssistantReply> => {
    const model = deps.model()
    const directory = await deps.resolveDirectory().catch(() => "")
    // No model or no project → still useful via the local intent parser.
    if (!model || !directory) return localIntent(transcript)

    try {
      const client = deps.createClient(directory)
      if (!sessionID || sessionDirectory !== directory) {
        const session = await client.session.create({
          directory,
          title: `${INTERNAL_SESSION_TITLE_PREFIX}Canvas Assistant`,
          agent: "build",
          model: { providerID: model.providerID, id: model.modelID },
          metadata: { source: "vector-canvas-assistant", hidden: true },
        })
        sessionID = session.data?.id
        sessionDirectory = directory
      }
      if (!sessionID) return localIntent(transcript)

      const result = await client.session.prompt({
        sessionID,
        directory,
        agent: "build",
        model,
        system: ASSISTANT_SYSTEM,
        tools: { bash: false, edit: false, patch: false, write: false, read: false },
        parts: [{ type: "text", text: JSON.stringify({ request: transcript, openWindows }) }],
      })
      const text = extractText(result.data)
      const reply = text ? coerceReply(text) : undefined
      return reply ?? localIntent(transcript)
    } catch {
      // Model/transport failure must never leave the mic dead — fall back.
      return localIntent(transcript)
    }
  }

  return { respond, reset }
}
