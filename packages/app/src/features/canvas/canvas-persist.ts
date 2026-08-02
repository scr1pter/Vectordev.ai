// Canvas window layout persistence — a per-project snapshot of window
// position/size/z plus the few durable per-window fields (notes body, the
// committed preview url). Uses the app's standard store: electron-store IPC
// via window.api when the desktop shell provides it, else a localStorage
// fallback — keyed by an FNV-1a hash of the project id so every project gets
// its own layout without leaking paths into the storage key.

import { checksum } from "@opencode-ai/core/util/encode"
import type { CanvasWindow } from "./canvas-types"

const STORE_NAME = "vector.canvas.dat"
const KEY_PREFIX = "vector.canvas-layout.v1"
const LAYOUT_VERSION = 1

// Voice-assistant/agent scratch fields that only make sense mid-session —
// never worth restoring (or persisting) across app launches.
const TRANSIENT_STATE_KEYS = ["inject", "submit", "navUrl", "setBody"]

type StoreApi = {
  storeGet?: (name: string, key: string) => Promise<string | null>
  storeSet?: (name: string, key: string, value: string) => Promise<void>
}

function storeApi(): StoreApi | undefined {
  return globalThis.window?.api as StoreApi | undefined
}

export function hasElectronStore(): boolean {
  return typeof storeApi()?.storeGet === "function"
}

function layoutKey(projectId: string) {
  return `${KEY_PREFIX}.${checksum(projectId) ?? "0"}`
}

function isCanvasWindow(value: unknown): value is CanvasWindow {
  if (!value || typeof value !== "object") return false
  const w = value as Record<string, unknown>
  return (
    typeof w.id === "string" &&
    typeof w.kind === "string" &&
    typeof w.title === "string" &&
    typeof w.x === "number" &&
    typeof w.y === "number" &&
    typeof w.width === "number" &&
    typeof w.height === "number" &&
    typeof w.z === "number"
  )
}

function parseLayout(raw: string): CanvasWindow[] | undefined {
  const parsed = (() => {
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return undefined
    }
  })()
  if (!parsed || typeof parsed !== "object") return undefined
  const { v, windows } = parsed as { v?: unknown; windows?: unknown }
  if (v !== LAYOUT_VERSION || !Array.isArray(windows)) return undefined
  return windows.filter(isCanvasWindow)
}

function sanitize(win: CanvasWindow): CanvasWindow {
  if (!win.state) return win
  const state = { ...win.state }
  for (const key of TRANSIENT_STATE_KEYS) delete state[key]
  return { ...win, state }
}

// Synchronous best-effort restore. Only meaningful when there's no Electron
// store (a plain browser build) so the very first paint can already show last
// session's layout; in desktop the durable read is the async one below.
export function readCanvasLayoutSync(projectId: string): CanvasWindow[] | undefined {
  if (hasElectronStore()) return undefined
  const raw = (() => {
    try {
      return globalThis.localStorage?.getItem(layoutKey(projectId)) ?? null
    } catch {
      return null
    }
  })()
  return raw ? parseLayout(raw) : undefined
}

export async function readCanvasLayout(projectId: string): Promise<CanvasWindow[] | undefined> {
  const key = layoutKey(projectId)
  const api = storeApi()
  if (api?.storeGet) {
    const raw = await api.storeGet(STORE_NAME, key).catch(() => null)
    return raw ? parseLayout(raw) : undefined
  }
  return readCanvasLayoutSync(projectId)
}

export async function writeCanvasLayout(projectId: string, windows: CanvasWindow[]) {
  const key = layoutKey(projectId)
  const payload = JSON.stringify({ v: LAYOUT_VERSION, windows: windows.map(sanitize) })
  const api = storeApi()
  if (api?.storeSet) {
    await api.storeSet(STORE_NAME, key, payload).catch(() => undefined)
    return
  }
  try {
    globalThis.localStorage?.setItem(key, payload)
  } catch {
    // Best-effort cache only — losing a layout snapshot isn't worth surfacing.
  }
}
