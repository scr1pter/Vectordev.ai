export function canAutoAcceptPermission(permission?: string) {
  if (permission === "browser_sensitive") return false
  return !permission?.startsWith("computer_")
}

export function canAlwaysAllowPermission(permission?: string, always?: readonly string[]) {
  if (permission?.startsWith("computer_")) return false
  return Boolean(always?.length)
}

export function computerPermissionDetails(input: {
  permission: string
  patterns: readonly string[]
  metadata: Record<string, unknown>
}) {
  if (!input.permission.startsWith("computer_")) return
  const action = typeof input.metadata.action === "string" ? input.metadata.action : ""
  return {
    action: computerActionLabel(action, input.metadata, input.permission),
    target: computerTargetLabel(input.metadata, input.patterns),
    proposedText: action === "type" && typeof input.metadata.text === "string" ? input.metadata.text : undefined,
  }
}

function computerActionLabel(action: string, metadata: Record<string, unknown>, permission: string) {
  const point = coordinate(metadata.x, metadata.y)
  if (action === "list_targets") return "View the list of open app windows"
  if (action === "select_target") return "Select and view this app window"
  if (action === "observe") return "Capture a fresh screenshot"
  if (action === "click") return point ? `Click once at ${point}` : "Click once in the selected app"
  if (action === "double_click") return point ? `Double-click at ${point}` : "Double-click in the selected app"
  if (action === "scroll") return "Scroll in the selected app"
  if (action === "drag") return "Drag the pointer in the selected app"
  if (action === "type") {
    const length = typeof metadata.text === "string" ? [...metadata.text].length : undefined
    return length === undefined ? "Type text in the selected app" : `Type ${length} character${length === 1 ? "" : "s"}`
  }
  if (action === "press") {
    const key = safeLabel(metadata.key, 48)
    return key ? `Press ${key}` : "Press a key in the selected app"
  }
  if (permission === "computer_observe") return "View the selected app"
  if (permission === "computer_interact") return "Use the pointer in the selected app"
  return "Use the keyboard in the selected app"
}

function computerTargetLabel(metadata: Record<string, unknown>, patterns: readonly string[]) {
  const target = record(metadata.target)
  const app = safeLabel(target?.appName, 100) || safeLabel(metadata.appName, 100) || safeLabel(metadata.targetApp, 100)
  const title =
    safeLabel(target?.name, 160) ||
    safeLabel(target?.title, 160) ||
    safeLabel(metadata.targetName, 160) ||
    safeLabel(metadata.targetTitle, 160) ||
    safeLabel(metadata.windowTitle, 160)
  if (app && title && app !== title) return `${app} · ${title}`
  if (title || app) return title || app
  return patterns.find((pattern) => pattern !== "*" && !/^window:\d+:\d+$/.test(pattern))
}

function coordinate(x: unknown, y: unknown) {
  if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) return
  return `${Math.round(x)}, ${Math.round(y)}`
}

function safeLabel(value: unknown, limit: number) {
  if (typeof value !== "string") return ""
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit)
}

function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}
