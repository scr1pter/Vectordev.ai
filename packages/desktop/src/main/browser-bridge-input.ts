import type { BrowserAgentInput } from "../preload/types"

const COMMANDS = new Set<NonNullable<BrowserAgentInput["command"]>>([
  "attach",
  "setBounds",
  "detach",
  "closeBrowser",
  "openUrl",
  "click",
  "type",
  "press",
  "wait",
  "waitForSelector",
  "waitForText",
  "takeScreenshot",
  "inspectDom",
  "inspectComputedStyles",
  "inspectPageHtml",
  "reload",
  "goBack",
  "goForward",
  "scroll",
  "clearLogs",
  "setVisible",
])

export function parseBrowserAgentInput(value: unknown): BrowserAgentInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid browser command.")
  const input = value as Record<string, unknown>
  const contextId = boundedString(input.contextId, "contextId", 256)
  const command = input.command === undefined ? undefined : boundedString(input.command, "command", 64)
  if (command && !COMMANDS.has(command as NonNullable<BrowserAgentInput["command"]>)) {
    throw new Error("Unknown browser command.")
  }
  return {
    contextId,
    command: command as BrowserAgentInput["command"],
    url: optionalString(input.url, "url", 8192),
    selector: optionalString(input.selector, "selector", 4096),
    text: optionalString(input.text, "text", 64 * 1024),
    key: optionalString(input.key, "key", 64),
    allowExternal: optionalBoolean(input.allowExternal, "allowExternal"),
    visible: optionalBoolean(input.visible, "visible"),
    milliseconds: optionalNumber(input.milliseconds, "milliseconds"),
    deltaY: optionalNumber(input.deltaY, "deltaY"),
  }
}

function boundedString(value: unknown, name: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`Invalid browser ${name}.`)
  }
  return value
}

function optionalString(value: unknown, name: string, max: number) {
  if (value === undefined) return
  if (typeof value !== "string" || value.length > max) throw new Error(`Invalid browser ${name}.`)
  return value
}

function optionalBoolean(value: unknown, name: string) {
  if (value === undefined) return
  if (typeof value !== "boolean") throw new Error(`Invalid browser ${name}.`)
  return value
}

function optionalNumber(value: unknown, name: string) {
  if (value === undefined) return
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid browser ${name}.`)
  return value
}
