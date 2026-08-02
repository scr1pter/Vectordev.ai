import { Effect, Schema } from "effect"

import { Tool } from "./tool"

const Action = Schema.Literals([
  "observe",
  "open_url",
  "click",
  "type",
  "press",
  "scroll",
  "wait",
  "wait_for_selector",
  "wait_for_text",
  "screenshot",
  "reload",
  "back",
  "forward",
  "read_console",
  "read_network",
  "read_html",
  "inspect_styles",
  "current_url",
  "close",
])

export const Parameters = Schema.Struct({
  action: Action.annotate({ description: "The browser action to perform" }),
  url: Schema.optional(Schema.String).annotate({ description: "URL for open_url" }),
  selector: Schema.optional(Schema.String).annotate({ description: "CSS selector for click, type, or wait_for_selector" }),
  text: Schema.optional(Schema.String).annotate({ description: "Text for type or wait_for_text" }),
  key: Schema.optional(Schema.String).annotate({ description: "Keyboard key for press" }),
  milliseconds: Schema.optional(Schema.Number).annotate({ description: "Wait duration, capped at 15 seconds" }),
  deltaY: Schema.optional(Schema.Number).annotate({ description: "Vertical scroll amount" }),
})

type BrowserReport = {
  ok: boolean
  error?: string
  finalUrl: string
  title: string
  description: string
  screenshotDataUrl: string
  console: { level: string; message: string; location?: string }[]
  pageErrors: string[]
  networkErrors?: { url: string; status?: number; error?: string; method?: string }[]
  domSummary?: {
    textSample: string
    interactives: { tag: string; text: string; selector: string; role?: string; type?: string }[]
    inputs: { tag: string; selector: string; placeholder?: string; type?: string; name?: string }[]
  }
  diagnostics?: {
    consoleCount: number
    runtimeErrorCount: number
    networkErrorCount: number
    interactiveCount: number
    inputCount: number
  }
  computedStyles?: {
    tag: string
    selector: string
    text: string
    display: string
    visibility: string
    color: string
    backgroundColor: string
    fontSize: string
  }[]
  pageHtml?: string
}

type Metadata = {
  url: string
  action: Schema.Schema.Type<typeof Action>
  diagnostics?: BrowserReport["diagnostics"]
}

const COMMANDS: Record<Schema.Schema.Type<typeof Action>, string> = {
  observe: "inspectDom",
  open_url: "openUrl",
  click: "click",
  type: "type",
  press: "press",
  scroll: "scroll",
  wait: "wait",
  wait_for_selector: "waitForSelector",
  wait_for_text: "waitForText",
  screenshot: "takeScreenshot",
  reload: "reload",
  back: "goBack",
  forward: "goForward",
  read_console: "inspectDom",
  read_network: "inspectDom",
  read_html: "inspectPageHtml",
  inspect_styles: "inspectComputedStyles",
  current_url: "inspectDom",
  close: "closeBrowser",
}

function isLocalUrl(rawUrl: string) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase()
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]" ||
      host.endsWith(".localhost") ||
      host.startsWith("192.168.") ||
      host.startsWith("10.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    )
  } catch {
    return false
  }
}

function bridgeRequest(input: Record<string, unknown>, signal: AbortSignal) {
  const url = process.env.VECTOR_BROWSER_BRIDGE_URL
  const token = process.env.VECTOR_BROWSER_BRIDGE_TOKEN
  if (!url || !token) throw new Error("The controlled browser is available in the Vector desktop app only.")
  return fetch(`${url}/command`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input),
    signal,
  }).then(async (response) => {
    const report = (await response.json()) as BrowserReport & { error?: string }
    if (!response.ok || !report.ok) throw new Error(report.error || `Browser command failed (${response.status})`)
    return report
  })
}

function formatReport(report: BrowserReport) {
  const consoleErrors = report.console.filter((entry) => entry.level === "error").slice(-8)
  const networkErrors = report.networkErrors?.slice(-8) ?? []
  return [
    `Page: ${report.title || "Untitled"}`,
    `URL: ${safeReportUrl(report.finalUrl) || "No page open"}`,
    report.description ? `Description: ${report.description}` : undefined,
    report.domSummary?.textSample ? `Visible page text:\n${report.domSummary.textSample.slice(0, 2_400)}` : undefined,
    report.domSummary?.interactives.length
      ? `Interactive elements:\n${report.domSummary.interactives
          .slice(0, 20)
          .map((item) => `- ${item.selector} — ${item.text || item.role || item.tag}`)
          .join("\n")}`
      : undefined,
    report.domSummary?.inputs.length
      ? `Inputs:\n${report.domSummary.inputs
          .slice(0, 16)
          .map((item) => `- ${item.selector} — ${item.type || item.placeholder || item.name || item.tag}`)
          .join("\n")}`
      : undefined,
    report.computedStyles?.length
      ? `Computed styles:\n${report.computedStyles
          .slice(0, 20)
          .map((item) => `- ${item.selector}: display=${item.display}; color=${item.color}; background=${item.backgroundColor}; font-size=${item.fontSize}`)
          .join("\n")}`
      : undefined,
    report.pageHtml ? `Page HTML excerpt:\n${report.pageHtml.slice(0, 8_000)}` : undefined,
    report.pageErrors.length ? `Runtime errors:\n${report.pageErrors.slice(-8).map((item) => `- ${item}`).join("\n")}` : undefined,
    consoleErrors.length
      ? `Console errors:\n${consoleErrors.map((item) => `- ${item.message}${item.location ? ` (${item.location})` : ""}`).join("\n")}`
      : undefined,
    networkErrors.length
      ? `Failed requests:\n${networkErrors.map((item) => `- ${item.method ?? "GET"} ${safeReportUrl(item.url)}: ${item.status ?? item.error ?? "failed"}`).join("\n")}`
      : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n\n")
}

function safeReportUrl(value: string) {
  if (!URL.canParse(value)) return value
  const url = new URL(value)
  for (const key of Array.from(url.searchParams.keys())) {
    if (/^(access_token|api[-_]?key|auth|authorization|code|key|password|refresh_token|secret|signature|sig|token)$/i.test(key)) {
      url.searchParams.set(key, "[REDACTED]")
    }
  }
  if (url.username) url.username = "[REDACTED]"
  if (url.password) url.password = "[REDACTED]"
  return url.toString()
}

const SENSITIVE_ACTION =
  /\b(approve|authorize|book|buy|checkout|confirm|create|delete|deploy|discard|merge|message|pay|publish|purchase|remove|reserve|send|submit|transfer|upgrade)\b/i

export function describeSensitiveBrowserAction(
  params: Pick<Schema.Schema.Type<typeof Parameters>, "action" | "key" | "selector">,
  report: BrowserReport | undefined,
) {
  if (params.action === "press" && params.key?.toLowerCase() === "enter") {
    return "Press Enter on an external page, which may submit the active form"
  }
  if (params.action !== "click" || !params.selector) return
  const target = report?.domSummary?.interactives.find(
    (item) => item.selector === params.selector || item.selector.includes(params.selector!),
  )
  const label = [target?.text, target?.role, target?.type, params.selector].filter(Boolean).join(" ")
  if (!SENSITIVE_ACTION.test(label)) return
  return `Click ${target?.text?.trim() || params.selector} on an external page`
}

export const BrowserTool = Tool.define<typeof Parameters, Metadata, never>(
  "browser",
  Effect.succeed({
    description:
      "Launches and controls Vector's task-specific browser directly from the main agent. Use it to inspect and test apps, read DOM/HTML/styles/console/runtime/network evidence, click, type, navigate, repair code, and retest. The user can open Preview at any time to watch the exact browser you are controlling or take over manually. Prefer localhost. External navigation and interaction require user approval. Never enter passwords, one-time codes, card data, make purchases, send messages, or delete remote resources.",
    parameters: Parameters,
    execute: (params, ctx) =>
      Effect.gen(function* () {
        const current =
          params.action === "open_url" || params.action === "close"
            ? undefined
            : yield* Effect.promise(() =>
                bridgeRequest({ contextId: ctx.sessionID, command: "inspectDom" }, ctx.abort),
              )
        const targetUrl = params.action === "open_url" ? params.url : current?.finalUrl
        const external = Boolean(targetUrl && !isLocalUrl(targetUrl))
        if (external) {
          const origin = new URL(targetUrl!).origin
          yield* ctx.ask({
            permission: params.action === "open_url" ? "browser_external" : "browser_interact",
            patterns: [origin],
            always: [origin],
            metadata: { action: params.action, url: targetUrl },
          })
          const sensitive = describeSensitiveBrowserAction(params, current)
          if (sensitive) {
            yield* ctx.ask({
              permission: "browser_sensitive",
              patterns: [`${origin}:${params.action}:${params.selector ?? params.key ?? ""}`],
              always: [],
              metadata: { action: params.action, url: targetUrl, description: sensitive },
            })
          }
        }

        const report = yield* Effect.promise(() =>
          bridgeRequest(
            {
              contextId: ctx.sessionID,
              command: COMMANDS[params.action],
              url: params.url,
              allowExternal: external,
              selector: params.selector,
              text: params.text,
              key: params.key,
              milliseconds: params.milliseconds,
              deltaY: params.deltaY,
            },
            ctx.abort,
          ),
        )
        return {
          title: `${params.action.replaceAll("_", " ")} — ${report.title || report.finalUrl || "browser"}`,
          output: formatReport(report),
          attachments:
            params.action === "screenshot" && report.screenshotDataUrl
              ? [{ type: "file" as const, mime: "image/png", url: report.screenshotDataUrl, filename: "vector-browser.png" }]
              : undefined,
          metadata: { url: safeReportUrl(report.finalUrl), action: params.action, diagnostics: report.diagnostics },
        }
      }),
  }),
)
