import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import { SDKProvider, useSDK } from "@/context/sdk"
import { FileProvider } from "@/context/file"
import { LocalProvider } from "@/context/local"
import { Terminal } from "@/components/terminal"
import type { LocalPTY } from "@/context/terminal"
import { showToast } from "@/utils/toast"
import { DictationIndicator } from "@/components/dictation-indicator"
import { INTERNAL_SESSION_TITLE_PREFIX } from "@/utils/internal-sessions"
import { CodespaceWorkbench } from "@/pages/session/session-side-panel"
import {
  CANVAS_WINDOWS,
  canvasWindowSpec,
  type CanvasAction,
  type CanvasModelOption,
  type CanvasWindow,
  type CanvasWindowKind,
} from "./canvas-types"
import {
  createCanvasAssistant,
  localIntent,
  speak,
  speechRecognitionAvailable,
  startDictation,
  stopSpeaking,
  type Dictation,
} from "./voice-assistant"
import { hasElectronStore, readCanvasLayout, readCanvasLayoutSync, writeCanvasLayout } from "./canvas-persist"
import "./canvas.css"

// A compact stroke icon for each surface, matching the shell's sidebar set.
function WindowGlyph(props: { kind: CanvasWindowKind }) {
  const paths: Record<CanvasWindowKind, string> = {
    "vector-agent": "M8 2.4l1.35 3.1 3.35.3-2.55 2.2.76 3.3L8 9.6l-2.91 1.7.76-3.3-2.55-2.2 3.35-.3L8 2.4Z",
    preview:
      "M2.5 4.25A1.25 1.25 0 0 1 3.75 3h8.5A1.25 1.25 0 0 1 13.5 4.25v6.5A1.25 1.25 0 0 1 12.25 12h-8.5A1.25 1.25 0 0 1 2.5 10.75v-6.5ZM2.75 5.5h10.5",
    notes:
      "M4 2.75h6.5L13 5.25v8A0.75.75 0 0 1 12.25 14h-8.5A0.75.75 0 0 1 3 13.25v-9.75A0.75.75 0 0 1 3.75 2.75ZM5.5 7h5M5.5 9.5h5",
    "browser-agent":
      "M8 2.6a5.4 5.4 0 1 0 0 10.8 5.4 5.4 0 0 0 0-10.8ZM2.8 8h10.4M8 2.6c-3.2 3.4-3.2 7.4 0 10.8 3.2-3.4 3.2-7.4 0-10.8Z",
    parallel: "M4 3.5h3v3H4zM9 3.5h3v3H9zM4 9.5h3v3H4zM9 9.5h3v3H9z",
    cloud: "M4.4 12.2a2.9 2.9 0 0 1-.3-5.78 3.6 3.6 0 0 1 6.96-1.2 2.7 2.7 0 0 1 .54 5.34",
    codespace: "M5.25 5 2.75 8l2.5 3M10.75 5l2.5 3-2.5 3M9.15 3.75l-2.3 8.5",
    terminal: "m4 5 3 3-3 3m4.5 0H12",
    review: "M4 3.25h8M4 8h8M4 12.75h8M2.4 3.25l.45.45.8-.9",
    scheduled: "M8 2.6a5.4 5.4 0 1 0 0 10.8 5.4 5.4 0 0 0 0-10.8ZM8 5.4v2.9l2 1.4",
    mcp: "M8 2.5v3M8 10.5v3M3.5 8h3M9.5 8h3M8 8.5a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Z",
    "claude-code":
      "M3.2 4.7A1.5 1.5 0 0 1 4.7 3.2h6.6A1.5 1.5 0 0 1 12.8 4.7v3.6A1.5 1.5 0 0 1 11.3 9.8H7.4L4.8 12.3V9.8h-.1A1.5 1.5 0 0 1 3.2 8.3V4.7Z M8 4.9l.45 1.15L9.6 6.5l-1.15.45L8 8.1l-.45-1.15L6.4 6.5l1.15-.45L8 4.9Z",
    codex: "M8 2.6 12.6 5.2v5.6L8 13.4 3.4 10.8V5.2L8 2.6Z M8 6.4v3.2",
    cursor: "M2 2 6.72 13.98 8.39 9.06 13.31 7.38 2 2Z",
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d={paths[props.kind]}
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  )
}

const DEFAULT_SIZE: Record<CanvasWindowKind, { w: number; h: number }> = {
  "vector-agent": { w: 420, h: 480 },
  preview: { w: 560, h: 420 },
  notes: { w: 300, h: 260 },
  "browser-agent": { w: 560, h: 420 },
  parallel: { w: 680, h: 520 },
  cloud: { w: 920, h: 620 },
  codespace: { w: 980, h: 640 },
  terminal: { w: 640, h: 380 },
  review: { w: 680, h: 500 },
  scheduled: { w: 540, h: 460 },
  mcp: { w: 540, h: 460 },
  "claude-code": { w: 560, h: 420 },
  codex: { w: 560, h: 420 },
  cursor: { w: 560, h: 420 },
}

let windowCounter = 0

export function CanvasWorkspace(props: {
  onClose: () => void
  macPad: boolean
  models: CanvasModelOption[]
  resolveProjectPath: () => Promise<string>
  onManageProviders: () => void
  taskId?: () => string | undefined
  /** Scopes the persisted layout to a project. Defaults to a shared "global" layout. */
  projectId?: () => string
}) {
  const serverSDK = useServerSDK()
  const projectId = () => props.projectId?.() ?? "global"

  let zTop = 10
  // Restored windows can carry ids/z-indexes from a previous session — fold
  // them into the running counters so freshly opened windows never collide.
  const adoptCounters = (list: CanvasWindow[]) => {
    for (const w of list) {
      const n = Number(w.id.replace(/^win-/, ""))
      if (Number.isFinite(n)) windowCounter = Math.max(windowCounter, n)
      zTop = Math.max(zTop, w.z)
    }
  }
  const initialWindows = readCanvasLayoutSync(projectId()) ?? []
  adoptCounters(initialWindows)

  // A store (not a signal) so per-window updates — drag, resize, focus, and the
  // assistant writing into a window — mutate in place without remounting the
  // window and wiping its live content (e.g. an in-progress agent chat).
  const [windows, setWindows] = createStore<CanvasWindow[]>(initialWindows)
  const mutateWindow = (id: string, fn: (win: CanvasWindow) => void) =>
    setWindows(
      produce((list) => {
        const w = list.find((x) => x.id === id)
        if (w) fn(w)
      }),
    )
  const [pan, setPan] = createSignal({ x: 0, y: 0 })
  const [zoom, setZoom] = createSignal(1)
  const [tool, setTool] = createSignal<"select" | "pan">("select")
  const [launcherOpen, setLauncherOpen] = createSignal(false)
  const [pointer, setPointer] = createSignal({ x: 0.5, y: 0.4 })
  let surfaceRef: HTMLDivElement | undefined

  // ---- Persisted layout ---------------------------------------------------
  // Electron's store is IPC (async), so it can't win the race against first
  // paint — layoutReady stays false until the desktop restore lands, holding
  // off the save effect so an empty initial store never clobbers it.
  const [layoutReady, setLayoutReady] = createSignal(!hasElectronStore())
  let saveTimer: ReturnType<typeof setTimeout> | undefined

  onMount(() => {
    if (!hasElectronStore()) return
    void readCanvasLayout(projectId()).then((restored) => {
      if (restored?.length) {
        adoptCounters(restored)
        setWindows(restored)
      }
      setLayoutReady(true)
    })
  })

  createEffect(() => {
    if (!layoutReady()) return
    // Reading through every window (incl. nested state) is what makes this
    // effect re-fire on any drag/resize/rename/notes-edit, not just add/remove.
    const snapshot = JSON.parse(JSON.stringify(windows)) as CanvasWindow[]
    const pid = projectId()
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = globalThis.setTimeout(() => void writeCanvasLayout(pid, snapshot), 400)
  })

  onCleanup(() => {
    if (saveTimer) clearTimeout(saveTimer)
  })

  // ---- Voice assistant ----------------------------------------------------
  const [modelKey, setModelKey] = createSignal(globalThis.localStorage?.getItem("vector.canvas-model.v1") ?? "")
  const [modelPickerOpen, setModelPickerOpen] = createSignal(false)
  const [listening, setListening] = createSignal(false)
  const [transcribing, setTranscribing] = createSignal(false)
  const [recordingLevel, setRecordingLevel] = createSignal(0)
  const [transcript, setTranscript] = createSignal("")
  const [caption, setCaption] = createSignal("")
  const [thinking, setThinking] = createSignal(false)
  const [typed, setTyped] = createSignal("")
  const sttAvailable = speechRecognitionAvailable()
  let dictation: Dictation | undefined

  const selectedModel = createMemo(() => {
    const [providerID, modelID] = modelKey().split("::")
    const match = props.models.find((m) => m.providerID === providerID && m.modelID === modelID)
    return match ?? props.models[0]
  })

  // Group models by provider, like the opencode backend's model picker, so the
  // menu reads as "provider → its models" rather than one flat list.
  const modelsByProvider = createMemo(() => {
    const groups = new Map<string, { provider: string; models: CanvasModelOption[] }>()
    for (const m of props.models) {
      const group = groups.get(m.providerID) ?? { provider: m.providerName, models: [] }
      group.models.push(m)
      groups.set(m.providerID, group)
    }
    return [...groups.values()]
  })

  const assistant = createCanvasAssistant({
    createClient: (directory) => serverSDK().createClient({ directory, throwOnError: true }),
    resolveDirectory: props.resolveProjectPath,
    model: () => {
      const m = selectedModel()
      return m ? { providerID: m.providerID, modelID: m.modelID } : undefined
    },
  })

  // ---- Window management --------------------------------------------------
  const focusWindow = (id: string) =>
    mutateWindow(id, (w) => {
      w.z = ++zTop
    })

  // Place a new window so it faces the others rather than stacking on top of
  // them: flow left-to-right from the top-left of the current view, wrapping to
  // a new row when the row gets wide. Two windows end up side by side.
  const placeWindow = (size: { w: number; h: number }): { x: number; y: number } => {
    const gap = 28
    const viewW = (surfaceRef?.clientWidth ?? 1280) / zoom()
    const baseX = -pan().x / zoom() + 60 / zoom()
    const baseY = -pan().y / zoom() + 84 / zoom()
    const list = windows
    if (!list.length) return { x: baseX, y: baseY }
    // Walk the existing row(s) and drop into the first gap that fits.
    let x = baseX
    let y = baseY
    let rowH = 0
    for (const w of [...list].sort((a, b) => a.y - b.y || a.x - b.x)) {
      rowH = Math.max(rowH, w.height)
      x = Math.max(x, w.x + w.width + gap)
      y = Math.min(y, w.y)
      if (x + size.w > baseX + Math.max(viewW - 120 / zoom(), size.w * 2 + gap)) {
        x = baseX
        y = y + rowH + gap
        rowH = 0
      }
    }
    return { x, y }
  }

  const openWindow = (kind: CanvasWindowKind): CanvasWindow => {
    const existing = windows.find((w) => w.kind === kind)
    if (existing) {
      focusWindow(existing.id)
      return existing
    }
    const spec = canvasWindowSpec(kind)
    const size = DEFAULT_SIZE[kind]
    const at = placeWindow(size)
    const win: CanvasWindow = {
      id: `win-${++windowCounter}`,
      kind,
      title: spec.label,
      x: at.x,
      y: at.y,
      width: size.w,
      height: size.h,
      z: ++zTop,
    }
    setWindows(windows.length, win)
    return win
  }

  const closeWindow = (id: string) => setWindows((list) => list.filter((w) => w.id !== id))
  const closeKind = (kind: CanvasWindowKind) => setWindows((list) => list.filter((w) => w.kind !== kind))

  const arrange = (layout: "grid" | "focus" | "clear") => {
    if (layout === "clear") {
      setWindows([])
      return
    }
    const list = windows
    if (!list.length) return
    if (layout === "focus") {
      // Center the front-most window in the viewport.
      const front = [...list].sort((a, b) => b.z - a.z)[0]
      setPan({
        x: -(front.x * zoom()) + (surfaceRef?.clientWidth ?? 1200) / 2 - (front.width * zoom()) / 2,
        y: -(front.y * zoom()) + (surfaceRef?.clientHeight ?? 800) / 2 - (front.height * zoom()) / 2,
      })
      return
    }
    // grid: lay windows out on a tidy world-space grid and reset the view.
    const cols = Math.ceil(Math.sqrt(list.length))
    const gap = 32
    let x = 80
    let y = 80
    let col = 0
    let rowH = 0
    const positions = list.map((window) => {
      const position = { x, y }
      rowH = Math.max(rowH, window.height)
      col++
      if (col >= cols) {
        col = 0
        x = 80
        y += rowH + gap
        rowH = 0
        return position
      }
      x += window.width + gap
      return position
    })
    setWindows(
      produce((draft) => {
        draft.forEach((window, index) => {
          window.x = positions[index].x
          window.y = positions[index].y
        })
      }),
    )
    const right = Math.max(...list.map((window, index) => positions[index].x + window.width)) + 80
    const bottom = Math.max(...list.map((window, index) => positions[index].y + window.height)) + 80
    const viewWidth = surfaceRef?.clientWidth ?? 1200
    const viewHeight = surfaceRef?.clientHeight ?? 800
    const nextZoom =
      list.length === 1 ? 1 : Math.max(0.35, Math.min(1, (viewWidth - 48) / right, (viewHeight - 48) / bottom))
    setZoom(nextZoom)
    setPan({
      x: Math.max(0, (viewWidth - right * nextZoom) / 2),
      y: Math.max(0, (viewHeight - bottom * nextZoom) / 2),
    })
  }

  // ---- Executing assistant actions ---------------------------------------
  const runActions = (actions: CanvasAction[]) => {
    for (const action of actions) {
      if (action.type === "open_window") {
        openWindow(action.kind)
      } else if (action.type === "close_window") {
        closeKind(action.kind)
      } else if (action.type === "prompt_vector_agent") {
        const win = openWindow("vector-agent")
        mutateWindow(win.id, (w) => {
          w.state = { ...w.state, inject: action.text, submit: action.submit }
        })
      } else if (action.type === "navigate_preview") {
        const win = openWindow("preview")
        mutateWindow(win.id, (w) => {
          w.state = { ...w.state, navUrl: action.url }
        })
      } else if (action.type === "write_note") {
        const win = openWindow("notes")
        mutateWindow(win.id, (w) => {
          w.state = { ...w.state, setBody: action.text }
        })
      } else if (action.type === "delegate_parallel") {
        const win = openWindow("parallel")
        mutateWindow(win.id, (w) => {
          w.state = { ...w.state, taskPrompt: action.task }
        })
      } else if (action.type === "deploy") {
        const win = openWindow("vector-agent")
        mutateWindow(win.id, (w) => {
          w.state = {
            ...w.state,
            inject: "Publish this repository using its configured deployment provider.",
            submit: true,
          }
        })
      } else if (action.type === "arrange") {
        arrange(action.layout)
      }
    }
  }

  const handleCommand = async (text: string) => {
    const request = text.trim()
    if (!request) return
    setTranscript(request)
    setCaption("")

    // Clear structural commands (open/close/tidy/delegate/deploy) run instantly
    // from the local parser — no round-trip, so the canvas feels immediate. We
    // only consult the chosen model when the request is a build/chat intent
    // that localIntent could only answer by handing off to the agent.
    const local = localIntent(request)
    const handoff = local.actions.some((a) => a.type === "prompt_vector_agent")
    if (!handoff && local.actions.length) {
      runActions(local.actions)
      announce(local.say)
      return
    }

    setThinking(true)
    const openLabels = windows.map((w) => w.title)
    // Race the model against a timeout so a slow or unreachable backend can
    // never leave the mic hanging — we fall back to the local intent.
    let reply = local
    try {
      reply = await Promise.race([
        assistant.respond(request, openLabels),
        new Promise<typeof local>((resolve) => globalThis.setTimeout(() => resolve(local), 7000)),
      ])
    } catch {
      reply = local
    }
    setThinking(false)
    runActions(reply.actions)
    announce(reply.say)
  }

  const announce = (say: string) => {
    setTranscript("")
    setCaption(say)
    speak(say)
    globalThis.setTimeout(() => setCaption((c) => (c === say ? "" : c)), 7000)
  }

  const toggleMic = () => {
    if (transcribing()) return
    if (listening()) {
      dictation?.stop()
      return
    }
    if (!sttAvailable) {
      showToast({
        title: "Voice input unavailable here",
        description:
          "This browser has no speech recognition. Type a command in the bar instead — the assistant works the same way.",
      })
      return
    }
    stopSpeaking()
    setTranscript("")
    setCaption("")
    setListening(true)
    dictation = startDictation({
      onInterim: (t) => setTranscript(t),
      onState: (state) => {
        setListening(state === "listening")
        setTranscribing(state === "transcribing")
        if (state !== "listening") setRecordingLevel(0)
      },
      onLevel: setRecordingLevel,
      onFinal: (t) => {
        setListening(false)
        setTranscribing(false)
        setRecordingLevel(0)
        setTranscript("")
        dictation = undefined
        const addition = t.trim()
        if (addition) setTyped((current) => (current.trimEnd() ? `${current.trimEnd()} ${addition}` : addition))
      },
      onError: (message) => {
        setListening(false)
        setTranscribing(false)
        setRecordingLevel(0)
        setTranscript("")
        dictation = undefined
        showToast({ title: "Microphone", description: message })
      },
    })
    if (!dictation) {
      setListening(false)
      showToast({
        title: "Microphone blocked",
        description: "Vector couldn't start the microphone. Check the browser's mic permission.",
      })
    }
  }

  const submitTyped = (event: SubmitEvent) => {
    event.preventDefault()
    const text = typed().trim()
    if (!text) return
    setTyped("")
    void handleCommand(text)
  }

  // ---- Pan / zoom / drag interactions ------------------------------------
  onMount(() => {
    // Capture phase so closing a canvas overlay CONSUMES the Escape — without
    // this, the shell's global Escape handler also fires and closes the whole
    // canvas the moment you dismiss the launcher or model picker.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (modelPickerOpen()) {
          event.preventDefault()
          event.stopPropagation()
          return setModelPickerOpen(false)
        }
        if (launcherOpen()) {
          event.preventDefault()
          event.stopPropagation()
          return setLauncherOpen(false)
        }
      }
    }
    globalThis.window?.addEventListener("keydown", onKey, { capture: true })
    onCleanup(() => {
      globalThis.window?.removeEventListener("keydown", onKey, { capture: true })
      dictation?.cancel()
      stopSpeaking()
    })
  })

  const onWheel = (event: WheelEvent) => {
    if (!surfaceRef) return
    // Wheel only zooms over the open canvas. Over any UI (launcher, windows,
    // menus, voice bar) the browser keeps the event so lists scroll normally.
    const target = event.target as HTMLElement
    if (target.closest("[data-canvas-ui]") || target.closest("[data-canvas-window]")) return
    event.preventDefault()
    const rect = surfaceRef.getBoundingClientRect()
    const mx = event.clientX - rect.left
    const my = event.clientY - rect.top
    const prev = zoom()
    const factor = event.deltaY < 0 ? 1.08 : 0.925
    const nextZoom = Math.min(1.8, Math.max(0.35, prev * factor))
    // Zoom toward the cursor: keep the world point under the pointer fixed.
    const worldX = (mx - pan().x) / prev
    const worldY = (my - pan().y) / prev
    setPan({ x: mx - worldX * nextZoom, y: my - worldY * nextZoom })
    setZoom(nextZoom)
  }

  // Panning by dragging empty canvas (or with the pan tool).
  const startPan = (event: PointerEvent) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest("[data-canvas-window]") || target.closest("[data-canvas-ui]")) return
    setLauncherOpen(false)
    setModelPickerOpen(false)
    const start = { x: event.clientX, y: event.clientY }
    const origin = { ...pan() }
    const move = (e: PointerEvent) =>
      setPan({ x: origin.x + (e.clientX - start.x), y: origin.y + (e.clientY - start.y) })
    const up = () => {
      globalThis.window?.removeEventListener("pointermove", move)
      globalThis.window?.removeEventListener("pointerup", up)
    }
    globalThis.window?.addEventListener("pointermove", move)
    globalThis.window?.addEventListener("pointerup", up)
  }

  const startWindowDrag = (event: PointerEvent, win: CanvasWindow) => {
    if (event.button !== 0) return
    event.stopPropagation()
    focusWindow(win.id)
    const start = { x: event.clientX, y: event.clientY }
    const origin = { x: win.x, y: win.y }
    const z = zoom()
    const move = (e: PointerEvent) =>
      mutateWindow(win.id, (w) => {
        w.x = origin.x + (e.clientX - start.x) / z
        w.y = origin.y + (e.clientY - start.y) / z
      })
    const up = () => {
      globalThis.window?.removeEventListener("pointermove", move)
      globalThis.window?.removeEventListener("pointerup", up)
    }
    globalThis.window?.addEventListener("pointermove", move)
    globalThis.window?.addEventListener("pointerup", up)
  }

  const startResize = (event: PointerEvent, win: CanvasWindow) => {
    event.stopPropagation()
    event.preventDefault()
    const start = { x: event.clientX, y: event.clientY }
    const origin = { w: win.width, h: win.height }
    const z = zoom()
    const move = (e: PointerEvent) =>
      mutateWindow(win.id, (w) => {
        w.width = Math.max(240, origin.w + (e.clientX - start.x) / z)
        w.height = Math.max(160, origin.h + (e.clientY - start.y) / z)
      })
    const up = () => {
      globalThis.window?.removeEventListener("pointermove", move)
      globalThis.window?.removeEventListener("pointerup", up)
    }
    globalThis.window?.addEventListener("pointermove", move)
    globalThis.window?.addEventListener("pointerup", up)
  }

  const trackPointer = (event: PointerEvent) => {
    if (!surfaceRef) return
    const rect = surfaceRef.getBoundingClientRect()
    setPointer({ x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height })
  }

  return (
    <section
      ref={surfaceRef}
      data-vector-workspace="canvas"
      class="vcanvas"
      classList={{ "vcanvas-pan": tool() === "pan" }}
      onPointerDown={startPan}
      onPointerMove={trackPointer}
      onWheel={onWheel}
    >
      {/* Ambient space: drifting aurora, starfield, and a pointer glow. */}
      <div class="vcanvas-sky" aria-hidden="true">
        <div class="vcanvas-aurora" />
        <div class="vcanvas-stars" />
        <div class="vcanvas-stars vcanvas-stars-2" />
        <div class="vcanvas-pointer" style={{ "--px": `${pointer().x * 100}%`, "--py": `${pointer().y * 100}%` }} />
      </div>

      {/* World layer — everything here lives in pannable / zoomable space. */}
      <div class="vcanvas-world" style={{ transform: `translate(${pan().x}px, ${pan().y}px) scale(${zoom()})` }}>
        <For each={windows}>
          {(win) => (
            <div
              data-canvas-window
              class="vcanvas-window"
              style={{
                left: `${win.x}px`,
                top: `${win.y}px`,
                width: `${win.width}px`,
                height: `${win.height}px`,
                "z-index": win.z,
              }}
              onPointerDown={() => focusWindow(win.id)}
            >
              <div class="vcanvas-window-bar" onPointerDown={(e) => startWindowDrag(e, win)}>
                <span class="vcanvas-window-glyph">
                  <WindowGlyph kind={win.kind} />
                </span>
                <span class="vcanvas-window-title">{win.title}</span>
                <button
                  type="button"
                  class="vcanvas-window-close"
                  aria-label={`Close ${win.title}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => closeWindow(win.id)}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path
                      d="m4.5 4.5 7 7M11.5 4.5l-7 7"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.4"
                      stroke-linecap="round"
                    />
                  </svg>
                </button>
              </div>
              <div class="vcanvas-window-body">
                <CanvasWindowContent
                  win={win}
                  models={props.models}
                  selectedModel={selectedModel}
                  serverSDK={serverSDK}
                  resolveProjectPath={props.resolveProjectPath}
                  taskId={props.taskId}
                  onClose={() => closeWindow(win.id)}
                  onOpenWindow={openWindow}
                  patchState={(patch) =>
                    mutateWindow(win.id, (w) => {
                      w.state = { ...w.state, ...patch }
                    })
                  }
                />
              </div>
              <span class="vcanvas-window-resize" onPointerDown={(e) => startResize(e, win)} aria-hidden="true" />
            </div>
          )}
        </For>
      </div>

      {/* Empty-state hint */}
      <Show when={windows.length === 0}>
        <div class="vcanvas-empty" data-canvas-ui>
          <div class="vcanvas-empty-eyebrow">
            <span />
            Vector Canvas
          </div>
          <h1>
            Your whole workspace, <em>on one canvas.</em>
          </h1>
          <p>
            Pull any tool onto the canvas and multitask. Or just hold the mic and tell Vector what to open, build, or
            ship.
          </p>
          <button type="button" class="vcanvas-empty-cta" onClick={() => setLauncherOpen(true)}>
            Add a window
          </button>
        </div>
      </Show>

      {/* Left tool rail */}
      <div class="vcanvas-tools" data-canvas-ui>
        <button
          type="button"
          class="vcanvas-tool"
          data-active={tool() === "select"}
          aria-label="Select"
          title="Select"
          onClick={() => setTool("select")}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M3.5 2.5l9 4.2-3.7 1.2-1.2 3.7-4.1-9Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          class="vcanvas-tool"
          data-active={tool() === "pan"}
          aria-label="Pan"
          title="Pan"
          onClick={() => setTool("pan")}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 2.5v6M5.5 4.5v4M10.5 4.5v4M3.5 7v2.5a4.5 4.5 0 0 0 9 0V6"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <div class="vcanvas-tool-sep" />
        <button
          type="button"
          class="vcanvas-tool"
          aria-label="Add window"
          title="Add window"
          onClick={() => setLauncherOpen((v) => !v)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      {/* Top toolbar */}
      <div class="vcanvas-topbar" data-canvas-ui style={{ "padding-left": props.macPad ? "76px" : undefined }}>
        <div class="vcanvas-brand">
          <span class="vcanvas-brand-dot" />
          Vector Canvas
        </div>
        <div class="vcanvas-topbar-actions">
          <button type="button" class="vcanvas-chip" onClick={() => arrange("grid")} title="Tidy windows into a grid">
            Tidy
          </button>
          <button
            type="button"
            class="vcanvas-chip"
            onClick={() => {
              setPan({ x: 0, y: 0 })
              setZoom(1)
            }}
            title="Reset view"
          >
            Reset view
          </button>
        </div>
      </div>

      {/* Back to chat (top-right) */}
      <button type="button" class="vcanvas-back" data-canvas-ui onClick={props.onClose} title="Back to Vector">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M9.5 3.5 5.5 8l4 4.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        Back to chat
      </button>

      {/* Zoom controls (bottom-left) */}
      <div class="vcanvas-zoom" data-canvas-ui>
        <button type="button" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.35, z * 0.9))}>
          −
        </button>
        <span>{Math.round(zoom() * 100)}%</span>
        <button type="button" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(1.8, z * 1.1))}>
          +
        </button>
      </div>

      {/* Add-to-canvas launcher — a centered palette so the voice bar and
          windows never cover it, showing every Vector surface at once. */}
      <Show when={launcherOpen()}>
        <div class="vcanvas-launcher-backdrop" data-canvas-ui onClick={() => setLauncherOpen(false)}>
          <div class="vcanvas-launcher" onClick={(e) => e.stopPropagation()}>
            <div class="vcanvas-launcher-head">
              Add to canvas
              <button
                type="button"
                class="vcanvas-launcher-close"
                aria-label="Close"
                onClick={() => setLauncherOpen(false)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="m4.5 4.5 7 7M11.5 4.5l-7 7"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
            </div>
            <div class="vcanvas-launcher-grid">
              <For each={CANVAS_WINDOWS}>
                {(spec) => (
                  <button
                    type="button"
                    class="vcanvas-launcher-item"
                    onClick={() => {
                      setLauncherOpen(false)
                      openWindow(spec.kind)
                    }}
                  >
                    <span class="vcanvas-launcher-glyph">
                      <WindowGlyph kind={spec.kind} />
                    </span>
                    <span class="vcanvas-launcher-copy">
                      <strong>{spec.label}</strong>
                      <small>{spec.detail}</small>
                    </span>
                  </button>
                )}
              </For>
            </div>
          </div>
        </div>
      </Show>

      {/* Voice command bar (bottom-center) */}
      <div class="vcanvas-voice" data-canvas-ui>
        <Show when={caption() || transcript() || thinking()}>
          <div class="vcanvas-voice-caption" classList={{ "is-user": Boolean(transcript()) && !caption() }}>
            <Show when={thinking()} fallback={caption() || transcript()}>
              <span class="vcanvas-voice-dots">
                <i />
                <i />
                <i />
              </span>
            </Show>
          </div>
        </Show>
        <div class="vcanvas-voice-bar">
          <Show when={!listening() && !transcribing()}>
            <button type="button" class="vcanvas-mic" aria-label="Dictate a Canvas command" onClick={toggleMic}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <rect
                  x="6"
                  y="2.2"
                  width="4"
                  height="7.2"
                  rx="2"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.3"
                />
                <path
                  d="M3.75 7.4a4.25 4.25 0 0 0 8.5 0M8 11.6v2.2"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </Show>
          <Show when={listening() || transcribing()}>
            <DictationIndicator
              state={transcribing() ? "transcribing" : "listening"}
              level={recordingLevel()}
              onStop={() => dictation?.stop()}
            />
          </Show>
          <form class="vcanvas-voice-input" onSubmit={submitTyped}>
            <input
              value={typed()}
              onInput={(e) => setTyped(e.currentTarget.value)}
              placeholder={
                transcribing()
                  ? "Transcribing locally…"
                  : listening()
                    ? "Listening…"
                    : sttAvailable
                      ? "Tap the mic, or type a command…"
                      : "Type a Canvas command…"
              }
            />
          </form>
          <div class="vcanvas-model" data-canvas-ui>
            <button type="button" class="vcanvas-model-btn" onClick={() => setModelPickerOpen((v) => !v)}>
              <span class="vcanvas-model-dot" />
              {selectedModel()?.modelName ?? "Choose a model"}
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M4 6l4 4 4-4"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
            <Show when={modelPickerOpen()}>
              <div class="vcanvas-model-menu">
                <For
                  each={modelsByProvider()}
                  fallback={<div class="vcanvas-model-empty">No providers connected yet.</div>}
                >
                  {(group) => (
                    <div class="vcanvas-model-group">
                      <div class="vcanvas-model-provider">{group.provider}</div>
                      <For each={group.models}>
                        {(m) => (
                          <button
                            type="button"
                            data-active={
                              selectedModel()?.providerID === m.providerID && selectedModel()?.modelID === m.modelID
                            }
                            onClick={() => {
                              const key = `${m.providerID}::${m.modelID}`
                              setModelKey(key)
                              globalThis.localStorage?.setItem("vector.canvas-model.v1", key)
                              setModelPickerOpen(false)
                            }}
                          >
                            <span>{m.modelName}</span>
                          </button>
                        )}
                      </For>
                    </div>
                  )}
                </For>
                <button
                  type="button"
                  class="vcanvas-model-manage"
                  onClick={() => {
                    setModelPickerOpen(false)
                    props.onManageProviders()
                  }}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path
                      d="M8 3.5v9M3.5 8h9"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.3"
                      stroke-linecap="round"
                    />
                  </svg>
                  Add or manage providers
                </button>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </section>
  )
}

// ---- Window content -------------------------------------------------------

function CanvasWindowContent(props: {
  win: CanvasWindow
  models: CanvasModelOption[]
  selectedModel: () => CanvasModelOption | undefined
  serverSDK: ReturnType<typeof useServerSDK>
  resolveProjectPath: () => Promise<string>
  taskId?: () => string | undefined
  onClose: () => void
  onOpenWindow: (kind: CanvasWindowKind) => CanvasWindow
  patchState: (patch: Record<string, unknown>) => void
}) {
  const kind = props.win.kind
  if (kind === "vector-agent") return <AgentWindow {...props} />
  if (kind === "preview" || kind === "browser-agent") return <PreviewWindow {...props} />
  if (kind === "notes") return <NotesWindow {...props} />
  if (kind === "cloud") return <p class="vcanvas-surface-state">Cloud Services is available from Home.</p>
  if (kind === "codespace") return <CodespaceWindow {...props} />
  if (kind === "terminal") return <CanvasTerminalWindow {...props} />
  if (kind === "review") return <ReviewWindow {...props} />
  if (kind === "scheduled") return <ScheduledAgentsWindow {...props} />
  if (kind === "mcp") return <McpWindow {...props} />
  if (kind === "parallel") return <ParallelAgentsWindow {...props} />
  if (kind === "claude-code" || kind === "codex" || kind === "cursor")
    return (
      <ExternalAgentWindow
        kind={kind}
        resolveProjectPath={props.resolveProjectPath}
        onOpenWindow={props.onOpenWindow}
      />
    )
  return null
}

function AgentWindow(props: {
  win: CanvasWindow
  selectedModel: () => CanvasModelOption | undefined
  serverSDK: ReturnType<typeof useServerSDK>
  resolveProjectPath: () => Promise<string>
  patchState: (patch: Record<string, unknown>) => void
}) {
  const [messages, setMessages] = createSignal<{ role: "you" | "vector"; text: string }[]>([])
  const [draft, setDraft] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  let sessionID: string | undefined
  let sessionDir: string | undefined
  let scroller: HTMLDivElement | undefined

  const push = (role: "you" | "vector", text: string) => {
    setMessages((m) => [...m, { role, text }])
    queueMicrotask(() => scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" }))
  }

  const send = async (text: string) => {
    const request = text.trim()
    if (!request || busy()) return
    const model = props.selectedModel()
    push("you", request)
    setDraft("")
    if (!model) {
      push("vector", "Connect a model first — pick one in the voice bar's model menu.")
      return
    }
    setBusy(true)
    try {
      const directory = await props.resolveProjectPath()
      if (!directory) {
        push("vector", "Open a project so I can work against your code.")
        return
      }
      const client = props.serverSDK().createClient({ directory, throwOnError: true })
      if (!sessionID || sessionDir !== directory) {
        const session = await client.session.create({
          directory,
          title: `${INTERNAL_SESSION_TITLE_PREFIX}Canvas Agent`,
          agent: "build",
          model: { providerID: model.providerID, id: model.modelID },
          metadata: { source: "vector-canvas-agent" },
        })
        sessionID = session.data?.id
        sessionDir = directory
      }
      if (!sessionID) throw new Error("no session")
      const result = await client.session.prompt({
        sessionID,
        directory,
        agent: "build",
        model: { providerID: model.providerID, modelID: model.modelID },
        parts: [{ type: "text", text: request }],
      })
      push("vector", extractAgentText(result.data) || "Done.")
    } catch (error) {
      push("vector", error instanceof Error ? error.message : "Something went wrong reaching the model.")
    } finally {
      setBusy(false)
    }
  }

  // The voice assistant injects prompts by writing to window.state.inject.
  // A reactive effect (not onMount) so repeated voice prompts to an already-open
  // agent window keep landing without remounting it.
  createEffect(() => {
    const inject = props.win.state?.inject
    if (typeof inject === "string" && inject) {
      const submit = props.win.state?.submit
      props.patchState({ inject: undefined, submit: undefined })
      if (submit) void send(inject)
      else setDraft(inject)
    }
  })

  const onSubmit = (event: SubmitEvent) => {
    event.preventDefault()
    void send(draft())
  }

  return (
    <div class="vcanvas-agent">
      <div class="vcanvas-agent-log" ref={scroller}>
        <Show
          when={messages().length}
          fallback={<p class="vcanvas-agent-hint">Ask Vector to build, fix, or explain something in your project.</p>}
        >
          <For each={messages()}>
            {(m) => (
              <div class="vcanvas-agent-msg" data-role={m.role}>
                <span class="vcanvas-agent-role">{m.role === "you" ? "You" : "Vector"}</span>
                <div class="vcanvas-agent-text">{m.text}</div>
              </div>
            )}
          </For>
        </Show>
        <Show when={busy()}>
          <div class="vcanvas-agent-thinking">
            <i />
            <i />
            <i />
          </div>
        </Show>
      </div>
      <form class="vcanvas-agent-form" onSubmit={onSubmit}>
        <textarea
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              void send(draft())
            }
          }}
          placeholder="Message the Vector agent…"
          rows={2}
        />
        <button type="submit" disabled={busy() || !draft().trim()} aria-label="Send">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M2.5 8h10M8 3.5 12.5 8 8 12.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </form>
    </div>
  )
}

function extractAgentText(value: unknown, depth = 0): string {
  if (!value || depth > 6) return ""
  if (typeof value === "string") return value.trim()
  if (Array.isArray(value))
    return value
      .map((v) => extractAgentText(v, depth + 1))
      .filter(Boolean)
      .join("\n")
  if (typeof value !== "object") return ""
  const record = value as Record<string, unknown>
  for (const key of ["text", "content", "message", "output", "data", "parts", "part"]) {
    const text = extractAgentText(record[key], depth + 1)
    if (text) return text
  }
  return ""
}

function normalizePreviewUrl(value: string) {
  const next = value.trim()
  if (!next) return next
  return /^https?:\/\//.test(next) ? next : `http://${next}`
}

function PreviewWindow(props: { win: CanvasWindow; patchState: (patch: Record<string, unknown>) => void }) {
  const initial = typeof props.win.state?.url === "string" ? (props.win.state.url as string) : "http://localhost:5173"
  const [url, setUrl] = createSignal(initial)
  const [committed, setCommitted] = createSignal(initial)
  const go = (event: SubmitEvent) => {
    event.preventDefault()
    const next = normalizePreviewUrl(url())
    setCommitted(next)
    props.patchState({ url: next })
  }
  // The assistant navigates the preview by writing state.navUrl.
  createEffect(() => {
    const nav = props.win.state?.navUrl
    if (typeof nav === "string" && nav) {
      const next = normalizePreviewUrl(nav)
      setUrl(next)
      setCommitted(next)
      props.patchState({ navUrl: undefined, url: next })
    }
  })
  return (
    <div class="vcanvas-preview">
      <form class="vcanvas-preview-bar" onSubmit={go}>
        <input
          value={url()}
          onInput={(e) => setUrl(e.currentTarget.value)}
          placeholder="localhost:5173"
          spellcheck={false}
        />
        <button type="submit" aria-label="Load">
          Go
        </button>
      </form>
      <div class="vcanvas-preview-frame">
        <iframe
          title="Canvas preview"
          src={committed()}
          sandbox="allow-forms allow-modals allow-pointer-lock allow-popups allow-scripts allow-same-origin"
        />
      </div>
    </div>
  )
}

function NotesWindow(props: { win: CanvasWindow; patchState: (patch: Record<string, unknown>) => void }) {
  const [text, setText] = createSignal(
    typeof props.win.state?.body === "string" ? (props.win.state.body as string) : "",
  )
  // The assistant writes into a note via state.setBody (appends to any existing).
  createEffect(() => {
    const add = props.win.state?.setBody
    if (typeof add === "string" && add) {
      const next = text() ? `${text()}\n${add}` : add
      setText(next)
      props.patchState({ setBody: undefined, body: next })
    }
  })
  return (
    <textarea
      class="vcanvas-notes"
      value={text()}
      onInput={(e) => {
        setText(e.currentTarget.value)
        props.patchState({ body: e.currentTarget.value })
      }}
      placeholder="Jot something…"
    />
  )
}

function CodespaceWindow(props: {
  resolveProjectPath: () => Promise<string>
  taskId?: () => string | undefined
  onClose: () => void
}) {
  const [directory] = createResource(props.resolveProjectPath)
  const [mount, setMount] = createSignal<HTMLDivElement>()
  return (
    <div class="vcanvas-embedded-host" ref={setMount}>
      <Show
        when={directory() && mount() ? { directory: directory()!, mount: mount()! } : undefined}
        keyed
        fallback={
          <p class="vcanvas-surface-state">
            {directory.loading ? "Opening the code editor…" : "Open a project to edit its files."}
          </p>
        }
      >
        {(ready) => (
          <SDKProvider directory={ready.directory}>
            <LocalProvider>
              <FileProvider>
                <CodespaceWorkbench
                  modified={() => []}
                  kinds={() => new Map()}
                  empty={() => <div />}
                  diffs={() => []}
                  focusReviewDiff={() => undefined}
                  sessionId={props.taskId}
                  onClose={props.onClose}
                  embedded
                  portalMount={ready.mount}
                />
              </FileProvider>
            </LocalProvider>
          </SDKProvider>
        )}
      </Show>
    </div>
  )
}

function CanvasTerminalRun() {
  const sdk = useSDK()
  const [pty, setPty] = createSignal<LocalPTY>()
  const [error, setError] = createSignal("")
  let ptyID: string | undefined

  onMount(() => {
    void sdk()
      .client.pty.create({ title: "Canvas Terminal" })
      .then((result) => {
        const id = result.data?.id
        if (!id) {
          setError("Vector could not start the project terminal.")
          return
        }
        ptyID = id
        setPty({ id, title: result.data?.title ?? "Canvas Terminal", titleNumber: 0 })
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "Vector could not start the project terminal."),
      )
  })

  onCleanup(() => {
    if (ptyID)
      void sdk()
        .client.pty.remove({ ptyID })
        .catch(() => undefined)
  })

  return (
    <Show when={pty()} keyed fallback={<p class="vcanvas-surface-state">{error() || "Starting terminal…"}</p>}>
      {(active) => <Terminal pty={active} autoFocus={false} />}
    </Show>
  )
}

function CanvasTerminalWindow(props: { resolveProjectPath: () => Promise<string> }) {
  const [directory] = createResource(props.resolveProjectPath)
  return (
    <div class="vcanvas-terminal">
      <Show
        when={directory()}
        keyed
        fallback={
          <p class="vcanvas-surface-state">
            {directory.loading ? "Connecting terminal…" : "Open a project to start a terminal."}
          </p>
        }
      >
        {(projectPath) => (
          <SDKProvider directory={projectPath}>
            <CanvasTerminalRun />
          </SDKProvider>
        )}
      </Show>
    </div>
  )
}

type CanvasReviewDiff = {
  file: string
  status?: string
  additions?: number
  deletions?: number
  before?: string
  after?: string
}

function ReviewWindow(props: {
  serverSDK: ReturnType<typeof useServerSDK>
  resolveProjectPath: () => Promise<string>
  taskId?: () => string | undefined
}) {
  const [selected, setSelected] = createSignal<string>()
  const [diffs, controls] = createResource(async () => {
    const sessionID = props.taskId?.()
    const directory = await props.resolveProjectPath()
    if (!sessionID || !directory) return [] as CanvasReviewDiff[]
    const result = await props.serverSDK().createClient({ directory, throwOnError: true }).session.diff({ sessionID })
    return (result.data ?? []) as CanvasReviewDiff[]
  })
  const active = createMemo(() => diffs()?.find((diff) => diff.file === selected()) ?? diffs()?.[0])

  return (
    <div class="vcanvas-review">
      <div class="vcanvas-pane-toolbar">
        <div>
          <strong>Task changes</strong>
          <small>{diffs()?.length ?? 0} files</small>
        </div>
        <button type="button" onClick={() => void controls.refetch()}>
          Refresh
        </button>
      </div>
      <Show
        when={!diffs.loading && (diffs()?.length ?? 0) > 0}
        fallback={
          <p class="vcanvas-surface-state">
            {diffs.loading ? "Loading this task's changes…" : "No reviewable changes exist for this task yet."}
          </p>
        }
      >
        <div class="vcanvas-review-layout">
          <div class="vcanvas-review-files">
            <For each={diffs()}>
              {(diff) => (
                <button type="button" data-active={active()?.file === diff.file} onClick={() => setSelected(diff.file)}>
                  <span>{diff.file}</span>
                  <small>
                    <b>+{diff.additions ?? 0}</b>
                    <i>-{diff.deletions ?? 0}</i>
                  </small>
                </button>
              )}
            </For>
          </div>
          <Show when={active()} keyed>
            {(diff) => (
              <div class="vcanvas-review-code">
                <div>
                  <span>{diff.status ?? "modified"}</span>
                  <strong>{diff.file}</strong>
                </div>
                <pre>{diff.after ?? diff.before ?? "The engine reported this file as changed."}</pre>
              </div>
            )}
          </Show>
        </div>
      </Show>
    </div>
  )
}

type CanvasScheduledAgent = {
  id: string
  prompt: string
  runAt: string
  status: "scheduled" | "running" | "completed" | "failed" | "canceled"
  error?: string
}

type CanvasScheduledApi = {
  list: (scope?: { directory?: string; parentSessionId?: string }) => Promise<CanvasScheduledAgent[]>
  create: (input: {
    prompt: string
    directory: string
    parentSessionId?: string
    runAt: string
  }) => Promise<CanvasScheduledAgent>
  cancel: (id: string) => Promise<CanvasScheduledAgent | undefined>
}

function ScheduledAgentsWindow(props: {
  resolveProjectPath: () => Promise<string>
  taskId?: () => string | undefined
}) {
  const [prompt, setPrompt] = createSignal("")
  const [runAt, setRunAt] = createSignal("")
  const [records, setRecords] = createSignal<CanvasScheduledAgent[]>([])
  const [busy, setBusy] = createSignal(false)
  const api = () =>
    (globalThis.window?.api as (Record<string, unknown> & { scheduledAgents?: CanvasScheduledApi }) | undefined)
      ?.scheduledAgents

  const refresh = async () => {
    const directory = await props.resolveProjectPath().catch(() => "")
    if (!directory || !api()) return
    setRecords(await api()!.list({ directory, parentSessionId: props.taskId?.() }))
  }

  onMount(() => {
    void refresh()
    const timer = globalThis.setInterval(() => void refresh(), 10_000)
    onCleanup(() => globalThis.clearInterval(timer))
  })

  const schedule = async (event: SubmitEvent) => {
    event.preventDefault()
    const directory = await props.resolveProjectPath().catch(() => "")
    if (!api() || !directory || !prompt().trim() || !runAt()) return
    setBusy(true)
    await api()!
      .create({
        prompt: prompt().trim(),
        directory,
        parentSessionId: props.taskId?.(),
        runAt: new Date(runAt()).toISOString(),
      })
      .then(() => {
        setPrompt("")
        setRunAt("")
        return refresh()
      })
      .catch((reason) =>
        showToast({ variant: "error", title: "Could not schedule agent", description: String(reason) }),
      )
      .finally(() => setBusy(false))
  }

  return (
    <div class="vcanvas-manager">
      <form class="vcanvas-manager-form" onSubmit={schedule}>
        <textarea
          value={prompt()}
          onInput={(event) => setPrompt(event.currentTarget.value)}
          placeholder="What should Vector do later?"
          rows={2}
        />
        <div>
          <input type="datetime-local" value={runAt()} onInput={(event) => setRunAt(event.currentTarget.value)} />
          <button type="submit" disabled={busy() || !prompt().trim() || !runAt()}>
            {busy() ? "Scheduling…" : "Schedule"}
          </button>
        </div>
      </form>
      <Show
        when={api()}
        fallback={<p class="vcanvas-surface-state">Scheduled agents are available in the Vector desktop app.</p>}
      >
        <div class="vcanvas-manager-list">
          <For each={records()} fallback={<p class="vcanvas-surface-state">No agents are scheduled for this task.</p>}>
            {(record) => (
              <article>
                <div>
                  <strong>{record.prompt}</strong>
                  <small>{new Date(record.runAt).toLocaleString()}</small>
                </div>
                <span data-status={record.status}>{record.status}</span>
                <Show when={record.status === "scheduled"}>
                  <button type="button" onClick={() => void api()?.cancel(record.id).then(refresh)}>
                    Cancel
                  </button>
                </Show>
              </article>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

type CanvasMcpStatus = {
  status: "connected" | "failed" | "needs_auth" | "needs_client_registration" | "disabled"
  error?: string
}

function McpWindow(props: { serverSDK: ReturnType<typeof useServerSDK>; resolveProjectPath: () => Promise<string> }) {
  const [items, setItems] = createSignal<Array<{ name: string; value: CanvasMcpStatus }>>([])
  const [busy, setBusy] = createSignal("")

  const client = async () => {
    const directory = await props.resolveProjectPath()
    return props.serverSDK().createClient({ directory, throwOnError: true })
  }
  const refresh = async () => {
    const result = await (await client()).mcp.status()
    setItems(
      Object.entries(result.data ?? {})
        .map(([name, value]) => ({ name, value: value as CanvasMcpStatus }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    )
  }
  onMount(() => void refresh().catch(() => undefined))

  const toggle = async (item: { name: string; value: CanvasMcpStatus }) => {
    setBusy(item.name)
    const sdk = await client()
    await (
      item.value.status === "disabled" ? sdk.mcp.connect({ name: item.name }) : sdk.mcp.disconnect({ name: item.name })
    )
      .then(refresh)
      .catch((reason) => showToast({ variant: "error", title: "MCP connection failed", description: String(reason) }))
      .finally(() => setBusy(""))
  }

  return (
    <div class="vcanvas-manager">
      <div class="vcanvas-pane-toolbar">
        <div>
          <strong>MCP servers</strong>
          <small>{items().filter((item) => item.value.status === "connected").length} connected</small>
        </div>
        <button type="button" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      <div class="vcanvas-manager-list">
        <For
          each={items()}
          fallback={<p class="vcanvas-surface-state">No MCP servers are configured for this project.</p>}
        >
          {(item) => (
            <article>
              <div>
                <strong>{item.name}</strong>
                <small>{item.value.error || item.value.status.replaceAll("_", " ")}</small>
              </div>
              <span data-status={item.value.status}>{item.value.status.replaceAll("_", " ")}</span>
              <button type="button" disabled={busy() === item.name} onClick={() => void toggle(item)}>
                {item.value.status === "disabled" ? "Enable" : "Disable"}
              </button>
            </article>
          )}
        </For>
      </div>
    </div>
  )
}

type CanvasParallelRecord = {
  id: string
  name: string
  taskPrompt: string
  status: string
  changedFilesCount: number
  mergeState: "none" | "merged" | "discarded"
  lastAction?: string
}

type CanvasParallelApi = {
  list: (scope?: { sourcePath?: string; parentSessionId?: string }) => Promise<CanvasParallelRecord[]>
  create: (input: {
    sourcePath: string
    parentSessionId?: string
    name?: string
    taskPrompt: string
    provider?: string
    model?: string
  }) => Promise<CanvasParallelRecord>
  run: (id: string) => Promise<CanvasParallelRecord>
  stop: (id: string) => Promise<CanvasParallelRecord>
  merge: (id: string) => Promise<CanvasParallelRecord>
  discard: (id: string) => Promise<CanvasParallelRecord>
}

function ParallelAgentsWindow(props: {
  win: CanvasWindow
  selectedModel: () => CanvasModelOption | undefined
  resolveProjectPath: () => Promise<string>
  taskId?: () => string | undefined
  patchState: (patch: Record<string, unknown>) => void
}) {
  const [prompt, setPrompt] = createSignal(
    typeof props.win.state?.taskPrompt === "string" ? (props.win.state.taskPrompt as string) : "",
  )
  const [records, setRecords] = createSignal<CanvasParallelRecord[]>([])
  const [busy, setBusy] = createSignal("")
  const api = () => globalThis.window?.api?.parallelWorkspaces as CanvasParallelApi | undefined

  createEffect(() => {
    const injected = props.win.state?.taskPrompt
    if (typeof injected !== "string" || !injected) return
    setPrompt(injected)
    props.patchState({ taskPrompt: undefined })
  })

  const refresh = async () => {
    const sourcePath = await props.resolveProjectPath().catch(() => "")
    if (!sourcePath || !api()) return
    setRecords(await api()!.list({ sourcePath, parentSessionId: props.taskId?.() }))
  }
  onMount(() => {
    void refresh()
    const timer = globalThis.setInterval(() => void refresh(), 6_000)
    onCleanup(() => globalThis.clearInterval(timer))
  })

  const launch = async (event: SubmitEvent) => {
    event.preventDefault()
    const taskPrompt = prompt().trim()
    const sourcePath = await props.resolveProjectPath().catch(() => "")
    if (!api() || !sourcePath || !taskPrompt) return
    setBusy("create")
    const model = props.selectedModel()
    await api()!
      .create({
        sourcePath,
        parentSessionId: props.taskId?.(),
        taskPrompt,
        name: taskPrompt.slice(0, 54),
        provider: model?.providerID,
        model: model?.modelID,
      })
      .then((record) => api()!.run(record.id))
      .then(() => {
        setPrompt("")
        return refresh()
      })
      .catch((reason) => showToast({ variant: "error", title: "Agent launch failed", description: String(reason) }))
      .finally(() => setBusy(""))
  }

  const act = async (id: string, action: "stop" | "merge" | "discard") => {
    if (!api()) return
    setBusy(id)
    await api()!
      [action](id)
      .then(refresh)
      .catch((reason) =>
        showToast({ variant: "error", title: `Could not ${action} agent`, description: String(reason) }),
      )
      .finally(() => setBusy(""))
  }

  return (
    <div class="vcanvas-manager">
      <form class="vcanvas-manager-form" onSubmit={launch}>
        <textarea
          value={prompt()}
          onInput={(event) => setPrompt(event.currentTarget.value)}
          placeholder="Give an isolated Vector agent a mission…"
          rows={2}
        />
        <div>
          <span>{props.selectedModel()?.modelName ?? "Choose a model below"}</span>
          <button type="submit" disabled={busy() === "create" || !prompt().trim()}>
            {busy() === "create" ? "Launching…" : "Launch agent"}
          </button>
        </div>
      </form>
      <Show
        when={api()}
        fallback={<p class="vcanvas-surface-state">Isolated agents are available in the Vector desktop app.</p>}
      >
        <div class="vcanvas-manager-list">
          <For
            each={records()}
            fallback={<p class="vcanvas-surface-state">No isolated agents are running for this task.</p>}
          >
            {(record) => (
              <article>
                <div>
                  <strong>{record.name}</strong>
                  <small>{record.lastAction || record.taskPrompt}</small>
                </div>
                <span data-status={record.status}>{record.status}</span>
                <div class="vcanvas-manager-actions">
                  <Show when={["planning", "editing", "running commands", "testing"].includes(record.status)}>
                    <button type="button" disabled={busy() === record.id} onClick={() => void act(record.id, "stop")}>
                      Stop
                    </button>
                  </Show>
                  <Show when={record.mergeState === "none" && record.changedFilesCount > 0}>
                    <button type="button" disabled={busy() === record.id} onClick={() => void act(record.id, "merge")}>
                      Merge
                    </button>
                    <button
                      type="button"
                      disabled={busy() === record.id}
                      onClick={() => void act(record.id, "discard")}
                    >
                      Discard
                    </button>
                  </Show>
                </div>
              </article>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

// ---- External agent panes --------------------------------------------------
// Real detection AND real execution: each pane spawns the installed coding
// agent headless in an isolated workspace via the opencode-server PTY and mounts
// the streaming <Terminal> on the returned pty id, so output lands live in-pane.

type ExternalAgentKind = "claude-code" | "codex" | "cursor"

type ExternalAgentInfo = { id: string; name: string; installed: boolean; version?: string; cli: string; path?: string }

type ExternalAgentsApi = {
  detect?: () => Promise<ExternalAgentInfo[]>
  openInEditor?: (input: { app: string; path: string }) => Promise<{ ok: boolean; error?: string }>
  prepareWorkspace?: (projectPath: string) => Promise<{ path: string; isolation: "git-worktree" | "copy" }>
}

// A prepared, isolated run: the headless command to spawn, the isolated cwd it
// runs in, and the project directory (used to scope the SDK/PTY context).
type AgentRun = { command: string; args: string[]; cwd: string; directory: string; title: string }

function externalAgentsApi(): ExternalAgentsApi | undefined {
  return (globalThis.window?.api as { externalAgents?: ExternalAgentsApi } | undefined)?.externalAgents
}

const AGENT_CLI: Record<ExternalAgentKind, string> = {
  "claude-code": "claude",
  codex: "codex",
  cursor: "cursor-agent",
}

const AGENT_RUN: Record<ExternalAgentKind, (prompt: string) => { command: string; args: string[] }> = {
  "claude-code": (prompt) => ({
    command: "claude",
    args: ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"],
  }),
  codex: (prompt) => ({
    command: "codex",
    args: ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", prompt],
  }),
  cursor: (prompt) => ({
    command: "cursor-agent",
    args: ["-p", "--force", "--output-format", "stream-json", prompt],
  }),
}

const AGENT_INSTALL_HINT: Record<ExternalAgentKind, string> = {
  "claude-code": "Install with `npm install -g @anthropic-ai/claude-code`, then sign in by running `claude`.",
  codex: "Install with `npm install -g @openai/codex`, then sign in by running `codex`.",
  cursor: "Install Cursor Agent, sign in, and make sure `cursor-agent` is available to Vector.",
}

function displayCommand(kind: ExternalAgentKind, prompt: string) {
  const invoke = AGENT_RUN[kind](prompt || "<task>")
  return [invoke.command, ...invoke.args].map((part) => JSON.stringify(part)).join(" ")
}

// Creates the pty for a prepared run and streams it through <Terminal>. Rendered
// inside an <SDKProvider> scoped to the project directory so both the pty
// creation and the Terminal's attach use the same directory-scoped SDK context.
function AgentTerminalRun(props: { run: AgentRun; onExit: (code: number) => void }) {
  const sdk = useSDK()
  const [pty, setPty] = createSignal<LocalPTY | undefined>()
  const [error, setError] = createSignal("")

  onMount(() => {
    const client = sdk().client
    const events = sdk().event
    let ptyID: string | undefined
    let exited = false

    const off = events.on("pty.exited", (event) => {
      if (!ptyID || event.properties.id !== ptyID) return
      exited = true
      props.onExit(event.properties.exitCode)
    })
    onCleanup(off)
    // Abandoning or closing the pane must not orphan the headless process.
    onCleanup(() => {
      if (ptyID && !exited) void client.pty.remove({ ptyID }).catch(() => undefined)
    })

    void client.pty
      .create({ command: props.run.command, args: props.run.args, cwd: props.run.cwd, title: props.run.title })
      .then((result) => {
        const id = result.data?.id
        if (!id) {
          setError("The agent process could not be started.")
          return
        }
        ptyID = id
        setPty({ id, title: props.run.title, titleNumber: 0 })
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't start the agent."))
  })

  return (
    <Show when={pty()} keyed fallback={<p class="vcanvas-extagent-hint">{error() || "Starting the agent…"}</p>}>
      {(active) => <Terminal pty={active} autoFocus={false} />}
    </Show>
  )
}

function ExternalAgentWindow(props: {
  kind: ExternalAgentKind
  resolveProjectPath: () => Promise<string>
  onOpenWindow: (kind: CanvasWindowKind) => CanvasWindow
}) {
  const spec = canvasWindowSpec(props.kind)
  const [status, setStatus] = createSignal<"checking" | "no-api" | ExternalAgentInfo>("checking")
  const [copied, setCopied] = createSignal(false)
  const [openError, setOpenError] = createSignal("")
  const [prompt, setPrompt] = createSignal("")
  const [preparing, setPreparing] = createSignal(false)
  const [runError, setRunError] = createSignal("")
  const [run, setRun] = createSignal<AgentRun | undefined>()
  const [exitCode, setExitCode] = createSignal<number | undefined>()

  const runnable = () => true

  onMount(() => {
    const api = externalAgentsApi()
    if (!api?.detect) {
      setStatus("no-api")
      return
    }
    void api
      .detect()
      .then((list) => {
        const match = list.find((agent) => agent.id === props.kind)
        setStatus(match ?? { id: props.kind, name: spec.label, cli: AGENT_CLI[props.kind], installed: false })
      })
      .catch(() => setStatus("no-api"))
  })

  const info = createMemo(() => {
    const current = status()
    return typeof current === "object" ? current : undefined
  })

  const copyCommand = () => {
    if (!runnable()) return
    void globalThis.navigator?.clipboard
      ?.writeText(displayCommand(props.kind, prompt().trim()))
      .then(() => {
        setCopied(true)
        globalThis.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => undefined)
  }

  const startRun = async () => {
    const task = prompt().trim()
    if (!task || preparing() || !runnable()) return
    setRunError("")
    setExitCode(undefined)
    setRun(undefined)
    const directory = await props.resolveProjectPath().catch(() => "")
    if (!directory) {
      setRunError("Open a project first.")
      return
    }
    setPreparing(true)
    try {
      const workspace = await externalAgentsApi()?.prepareWorkspace?.(directory)
      const cwd = workspace?.path ?? directory
      const invoke = AGENT_RUN[props.kind](task)
      setRun({ command: info()?.path || invoke.command, args: invoke.args, cwd, directory, title: spec.label })
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "Couldn't prepare an isolated workspace.")
    } finally {
      setPreparing(false)
    }
  }

  const resetRun = () => {
    setRun(undefined)
    setExitCode(undefined)
    setRunError("")
  }

  const reimportChanges = () => props.onOpenWindow("review")

  const openInCursor = async () => {
    const api = externalAgentsApi()
    if (!api?.openInEditor) return
    setOpenError("")
    const directory = await props.resolveProjectPath().catch(() => "")
    if (!directory) {
      setOpenError("Open a project first.")
      return
    }
    const result = await api.openInEditor({ app: "cursor", path: directory })
    if (!result.ok) setOpenError(result.error ?? `Couldn't open ${spec.label}.`)
  }

  return (
    <div class="vcanvas-extagent">
      <Show when={status() === "checking"}>
        <p class="vcanvas-extagent-hint">Checking for {spec.label}…</p>
      </Show>
      <Show when={status() === "no-api"}>
        <p class="vcanvas-extagent-hint">Available in the Vector desktop app.</p>
      </Show>
      <Show when={info()} keyed>
        {(agent) => (
          <Show
            when={agent.installed}
            fallback={
              <>
                <p class="vcanvas-extagent-hint">Not detected — install the {spec.label} CLI.</p>
                <p class="vcanvas-extagent-install">{AGENT_INSTALL_HINT[props.kind]}</p>
              </>
            }
          >
            <Show
              when={run()}
              keyed
              fallback={
                <div class="vcanvas-extagent-card">
                  <span class="vcanvas-extagent-badge">{agent.version ? `v${agent.version}` : "Installed"}</span>
                  <Show
                    when={runnable()}
                    fallback={
                      <>
                        <p class="vcanvas-extagent-hint">
                          Open your project in {spec.label}, work there, then re-import the changes into Vector.
                        </p>
                        <div class="vcanvas-extagent-actions">
                          <Show when={externalAgentsApi()?.openInEditor}>
                            <button type="button" onClick={() => void openInCursor()}>
                              Open project in Cursor
                            </button>
                          </Show>
                          <button type="button" onClick={reimportChanges}>
                            Re-import changes
                          </button>
                        </div>
                      </>
                    }
                  >
                    <textarea
                      class="vcanvas-extagent-prompt"
                      value={prompt()}
                      onInput={(e) => setPrompt(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault()
                          void startRun()
                        }
                      }}
                      placeholder={`Describe the task for ${spec.label}…`}
                      rows={3}
                    />
                    <div class="vcanvas-extagent-actions">
                      <button type="button" disabled={preparing() || !prompt().trim()} onClick={() => void startRun()}>
                        {preparing() ? "Preparing…" : "Run"}
                      </button>
                      <button type="button" disabled={!prompt().trim()} onClick={copyCommand}>
                        {copied() ? "Copied" : "Copy command"}
                      </button>
                    </div>
                    <p class="vcanvas-extagent-install">
                      Runs headless in an isolated workspace — your project files stay untouched until you re-import.
                    </p>
                  </Show>
                </div>
              }
            >
              {(active) => (
                <div class="vcanvas-extagent-run">
                  <div class="vcanvas-extagent-terminal">
                    <SDKProvider directory={active.directory}>
                      <AgentTerminalRun run={active} onExit={(code) => setExitCode(code)} />
                    </SDKProvider>
                  </div>
                  <div class="vcanvas-extagent-runbar">
                    <span class="vcanvas-extagent-runstatus">
                      <Show
                        when={exitCode() !== undefined}
                        fallback={`Running ${spec.label} in an isolated workspace…`}
                      >
                        Finished (exit {exitCode()})
                      </Show>
                    </span>
                    <div class="vcanvas-extagent-actions">
                      <Show when={exitCode() !== undefined}>
                        <button type="button" onClick={reimportChanges}>
                          Re-import changes
                        </button>
                      </Show>
                      <button type="button" onClick={resetRun}>
                        {exitCode() !== undefined ? "Run again" : "Stop"}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </Show>
          </Show>
        )}
      </Show>
      <Show when={runError()}>
        <p class="vcanvas-extagent-error">{runError()}</p>
      </Show>
      <Show when={openError()}>
        <p class="vcanvas-extagent-error">{openError()}</p>
      </Show>
    </div>
  )
}
