export type BrowserAgentBounds = { x: number; y: number; width: number; height: number }

export type BrowserAgentPageEvent = {
  contextId: string
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

export type BrowserAgentCommand =
  | "attach"
  | "setBounds"
  | "detach"
  | "closeBrowser"
  | "openUrl"
  | "click"
  | "type"
  | "press"
  | "wait"
  | "waitForSelector"
  | "waitForText"
  | "takeScreenshot"
  | "inspectDom"
  | "inspectComputedStyles"
  | "inspectPageHtml"
  | "reload"
  | "goBack"
  | "goForward"
  | "scroll"
  | "clearLogs"
  | "setVisible"

export type BrowserAgentInput = {
  contextId: string
  command?: BrowserAgentCommand
  url?: string
  allowExternal?: boolean
  selector?: string
  text?: string
  key?: string
  milliseconds?: number
  deltaY?: number
  bounds?: BrowserAgentBounds
  visible?: boolean
}

export type BrowserAgentDomSummary = {
  title: string
  description: string
  textSample: string
  links: number
  scripts: number
  stylesheets: number
  htmlBytes: number
  interactives: { tag: string; text: string; selector: string; role?: string; type?: string }[]
  inputs: { tag: string; selector: string; placeholder?: string; type?: string; name?: string }[]
}

export type BrowserAutomationRun = {
  url: string
  finalUrl: string
  status: number
  ok: boolean
  title: string
  description: string
  htmlBytes: number
  links: number
  scripts: number
  stylesheets: number
  checkedAt: string
  error?: string
  viewport: BrowserAgentBounds
  screenshotDataUrl: string
  console: { level: string; message: string; location?: string }[]
  pageErrors: string[]
  networkErrors?: { url: string; status?: number; error?: string; method?: string }[]
  domSummary?: BrowserAgentDomSummary
  computedStyles?: {
    tag: string
    selector: string
    text: string
    display: string
    visibility: string
    color: string
    backgroundColor: string
    fontSize: string
    rect: { x: number; y: number; width: number; height: number }
  }[]
  pageHtml?: string
  diagnostics?: {
    consoleCount: number
    runtimeErrorCount: number
    networkErrorCount: number
    interactiveCount: number
    inputCount: number
    htmlBytes: number
  }
  actions: { label: string; ok: boolean; error?: string; result?: unknown; at?: string }[]
  interactives: BrowserAgentDomSummary["interactives"]
  inputs: BrowserAgentDomSummary["inputs"]
  browserStatus?: "stopped" | "launching" | "running"
  currentPage?: string
}

export type BrowserAgentApi = {
  runBrowserAgent: (input: BrowserAgentInput) => Promise<BrowserAutomationRun>
  onBrowserAgentPageEvent?: (cb: (event: BrowserAgentPageEvent) => void) => () => void
}

export function browserAgentApi(): BrowserAgentApi | undefined {
  const api = globalThis.window?.api as (BrowserAgentApi & Record<string, unknown>) | undefined
  if (!api?.runBrowserAgent) return undefined
  return api
}

export function normalizeBrowserUrl(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ""
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed
  return `http://${trimmed}`
}

export function isLocalBrowserUrl(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    const host = url.hostname.toLowerCase()
    return (
      host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host.endsWith(".localhost")
    )
  } catch {
    return false
  }
}
