// Vector Canvas — a spatial surface where every Vector tool becomes a floating
// window you arrange and multitask across, driven by voice. Types shared by the
// canvas surface, its windows, and the voice assistant's action layer.

export type CanvasModelOption = {
  providerID: string
  providerName: string
  modelID: string
  modelName: string
}

// Every surface you can pull onto the canvas. Canvas is a multitasking
// workspace, so every kind renders live inside a resizable window.
export type CanvasWindowKind =
  | "vector-agent"
  | "preview"
  | "notes"
  | "browser-agent"
  | "parallel"
  | "cloud"
  | "codespace"
  | "terminal"
  | "review"
  | "scheduled"
  | "mcp"
  | "claude-code"
  | "codex"
  | "cursor"

export type CanvasWindowSpec = {
  kind: CanvasWindowKind
  label: string
  detail: string
}

// One catalogue, used by both the launcher dock and the voice assistant so the
// two always agree on what "open the preview" can mean.
export const CANVAS_WINDOWS: CanvasWindowSpec[] = [
  { kind: "vector-agent", label: "Vector Agent", detail: "Talk to the agent that builds your code." },
  { kind: "preview", label: "Browser", detail: "Browse and test your running app beside everything else." },
  { kind: "notes", label: "Notes", detail: "A sticky note for the canvas." },
  { kind: "parallel", label: "New Agent", detail: "Launch and review an isolated agent." },
  { kind: "cloud", label: "Vector Cloud", detail: "Publish and manage deployments." },
  { kind: "codespace", label: "Code editor", detail: "Edit project files with Vector's editor agent." },
  { kind: "terminal", label: "Terminal", detail: "Use a live project shell." },
  { kind: "review", label: "Review changes", detail: "Inspect this task's diff." },
  { kind: "scheduled", label: "Scheduled Agents", detail: "Run agents at a time you pick." },
  { kind: "mcp", label: "MCP Servers", detail: "Monitor and control connected tools." },
  { kind: "claude-code", label: "Claude Code", detail: "Run Anthropic's agent headless in an isolated workspace." },
  { kind: "codex", label: "Codex", detail: "Run OpenAI's agent headless in an isolated workspace." },
  { kind: "cursor", label: "Cursor Agent", detail: "Open your project in Cursor, then re-import changes." },
]

export function canvasWindowSpec(kind: CanvasWindowKind): CanvasWindowSpec {
  if (kind === "browser-agent") return CANVAS_WINDOWS.find((entry) => entry.kind === "preview") ?? CANVAS_WINDOWS[0]
  return CANVAS_WINDOWS.find((entry) => entry.kind === kind) ?? CANVAS_WINDOWS[0]
}

export type CanvasWindow = {
  id: string
  kind: CanvasWindowKind
  title: string
  x: number
  y: number
  width: number
  height: number
  z: number
  // Per-window scratch state (agent prompt text, notes body, preview url…).
  state?: Record<string, unknown>
}

// The structured actions the voice assistant may take. Kept small and explicit
// so the model can only drive the canvas in ways the surface actually supports.
export type CanvasAction =
  | { type: "open_window"; kind: CanvasWindowKind }
  | { type: "close_window"; kind: CanvasWindowKind }
  | { type: "prompt_vector_agent"; text: string; submit?: boolean }
  | { type: "navigate_preview"; url: string }
  | { type: "write_note"; text: string }
  | { type: "delegate_parallel"; task: string }
  | { type: "deploy" }
  | { type: "arrange"; layout: "grid" | "focus" | "clear" }

export type CanvasAssistantReply = {
  // What the assistant says back (spoken aloud + shown as a caption).
  say: string
  actions: CanvasAction[]
}
