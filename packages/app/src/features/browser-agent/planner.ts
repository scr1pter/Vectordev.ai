import type { BrowserAutomationRun } from "./types"
import { INTERNAL_SESSION_TITLE_PREFIX } from "@/utils/internal-sessions"

export type BrowserModelAction =
  | { type: "click"; selector: string }
  | { type: "type"; selector: string; text: string }
  | { type: "press"; key: string }
  | { type: "scroll"; deltaY: number }
  | { type: "wait"; milliseconds: number }
  | { type: "navigate"; url: string }
  // Human handoff: the run pauses, the user acts directly in the live browser
  // (log in, solve a captcha, approve a prompt), then resumes with a fresh
  // observation of the changed page.
  | { type: "wait_for_user"; reason: string }

export type BrowserModelPlan = {
  summary: string
  complete: boolean
  needsUser?: string
  actions: BrowserModelAction[]
}

type PlannerSessionClient = {
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

export function extractBrowserModelText(value: unknown, depth = 0): string {
  if (!value || depth > 6) return ""
  if (typeof value === "string") return value.trim()
  if (Array.isArray(value)) return value.map((item) => extractBrowserModelText(item, depth + 1)).filter(Boolean).join("\n")
  if (typeof value !== "object") return ""
  const record = value as Record<string, unknown>
  for (const key of ["text", "content", "message", "output", "data", "parts", "part"]) {
    const text = extractBrowserModelText(record[key], depth + 1)
    if (text) return text
  }
  return ""
}

export function parseBrowserModelPlan(text: string): BrowserModelPlan {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const source = (fenced || text).trim()
  const json = source.startsWith("{") ? source : source.match(/\{[\s\S]*\}/)?.[0] ?? source
  const parsed = JSON.parse(json) as Partial<BrowserModelPlan>
  const actions = Array.isArray(parsed.actions)
    ? parsed.actions
        .filter((action): action is BrowserModelAction => {
          if (!action || typeof action !== "object" || typeof (action as { type?: unknown }).type !== "string") return false
          const type = (action as { type: string }).type
          if (type === "click") return typeof (action as { selector?: unknown }).selector === "string"
          if (type === "type")
            return (
              typeof (action as { selector?: unknown }).selector === "string" &&
              typeof (action as { text?: unknown }).text === "string"
            )
          if (type === "press") return typeof (action as { key?: unknown }).key === "string"
          if (type === "scroll") return typeof (action as { deltaY?: unknown }).deltaY === "number"
          if (type === "wait") return typeof (action as { milliseconds?: unknown }).milliseconds === "number"
          if (type === "navigate") {
            const url = (action as { url?: unknown }).url
            return typeof url === "string" && url.trim() !== ""
          }
          if (type === "wait_for_user") {
            const reason = (action as { reason?: unknown }).reason
            return typeof reason === "string" && reason.trim() !== ""
          }
          return false
        })
        .slice(0, 8)
    : []
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "Vector planned the next browser step.",
    complete: parsed.complete === true,
    needsUser: typeof parsed.needsUser === "string" ? parsed.needsUser : undefined,
    actions,
  }
}

export function fallbackBrowserModelPlan(
  prompt: string,
  report: BrowserAutomationRun,
  completed: string[],
): BrowserModelPlan {
  const lower = prompt.toLowerCase()
  const words = lower.match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []
  const ignored = new Set(["the", "this", "that", "with", "from", "into", "page", "website", "please", "browser", "agent"])
  const terms = [...new Set(words.filter((word) => !ignored.has(word)))]
  const inputs = report.domSummary?.inputs ?? report.inputs ?? []
  const controls = report.domSummary?.interactives ?? report.interactives ?? []
  const already = new Set(completed)
  const quoted = prompt.match(/["“]([^"”]{1,180})["”]/)?.[1]
  const typed = quoted || prompt.match(/\b(?:type|enter|search(?:\s+for)?)\s+(.{1,160})/i)?.[1]?.replace(/[.!?]\s*$/, "").trim()

  if (typed) {
    const preferred = inputs
      .filter((input) => !/password|secret|token/i.test(`${input.type ?? ""} ${input.name ?? ""} ${input.placeholder ?? ""}`))
      .map((input) => {
        const haystack = `${input.name ?? ""} ${input.placeholder ?? ""} ${input.type ?? ""} ${input.selector}`.toLowerCase()
        const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 2 : 0), 0)
        return { input, score }
      })
      .sort((a, b) => b.score - a.score)[0]?.input
    if (preferred && !already.has(`type ${preferred.selector}`)) {
      return {
        summary: "Vector found a matching input and will enter the requested text.",
        complete: false,
        actions: [{ type: "type", selector: preferred.selector, text: typed }],
      }
    }
  }

  const ranked = controls
    .filter((control) => !already.has(`click ${control.selector}`))
    .map((control) => {
      const haystack = `${control.text} ${control.role ?? ""} ${control.type ?? ""} ${control.selector}`.toLowerCase()
      let score = terms.reduce((total, term) => total + (haystack.includes(term) ? 3 : 0), 0)
      if (
        /test|open|launch|start|continue|submit|login|sign in|next|save/.test(lower) &&
        /button|submit|link/.test(`${control.tag} ${control.role ?? ""} ${control.type ?? ""}`)
      )
        score += 1
      return { control, score }
    })
    .sort((a, b) => b.score - a.score)
  // A generic button bonus is enough to break ties for a strongly matched
  // request, but it must never make an unrelated button actionable by itself.
  const target = ranked.find((item) => item.score >= 3)?.control
  if (target) {
    return {
      summary: `Vector matched the request to “${target.text || target.selector}”.`,
      complete: false,
      actions: [{ type: "click", selector: target.selector }],
    }
  }

  if (/scroll|below|further|continue reading/.test(lower) && !already.has("scroll 680")) {
    return {
      summary: "Vector needs more page context and will scroll once.",
      complete: false,
      actions: [{ type: "scroll", deltaY: 680 }],
    }
  }

  const errors = (report.pageErrors?.length ?? 0) + (report.networkErrors?.length ?? 0)
  if (errors > 0) {
    return {
      summary: `The browser run found ${errors} runtime or network issue${errors === 1 ? "" : "s"}.`,
      complete: true,
      actions: [],
    }
  }
  if (completed.length > 0) {
    return {
      summary: `Browser Agent completed ${completed.length} grounded action${completed.length === 1 ? "" : "s"} and found no further control that clearly matches the request.`,
      complete: true,
      actions: [],
    }
  }
  return {
    summary: "Vector could not ground another safe action in the current page.",
    complete: false,
    needsUser: "No matching visible control was found. Take over the browser directly or make the request more specific.",
    actions: [],
  }
}

const PLANNER_SYSTEM = [
  "You are Vector Browser Agent's planning brain, driving a real browser that the user watches live and can use directly at any time.",
  "Return JSON only: {summary:string, complete:boolean, needsUser?:string, actions:Array<object>}.",
  "Allowed actions: click {selector}, type {selector,text}, press {key}, scroll {deltaY}, wait {milliseconds}, navigate {url}, wait_for_user {reason}.",
  "click and type selectors must come from the supplied live DOM inventory. Never invent selectors or claim an action already happened.",
  "navigate opens any http(s) URL, including a different website mid-task. Multi-site tasks are normal: navigate wherever the requested data lives.",
  "NEVER type into credential fields (passwords, one-time codes, card numbers) and never attempt logins, 2FA, or captchas yourself — the executor refuses credential typing.",
  "Whenever login, 2FA, a captcha, or any other human-only step blocks progress, emit a single wait_for_user action whose reason is a short instruction, for example \"Log in to your account, then continue\". The run pauses, the user acts directly in the live browser, and your next observation reflects the changed page.",
  "Generic pattern for fetching data behind an account: navigate to the site, observe, emit wait_for_user if blocked by authentication, then after the user continues, navigate and read to find the requested data, and finish with complete=true and the extracted value stated plainly in summary. The summary is the user-facing answer, so include the value itself.",
  "Use needsUser only when the request itself is unclear or impossible; use wait_for_user whenever the user just needs to act in the browser before you continue.",
  "Never perform a purchase, booking confirmation, external communication, or destructive action — hand those steps to the user with wait_for_user.",
  "Localhost test forms may use clearly fake test data.",
  "Use at most four actions per step. If the request is complete or cannot be grounded in the current page, return complete=true or needsUser with no actions.",
].join("\n")

// One hidden planner session per conversation. Reusing the session keeps the
// model's context across steps and stops the old per-step session leak.
export function createBrowserPlanner(deps: {
  createClient: (directory: string) => PlannerSessionClient
  resolveDirectory: () => Promise<string>
  model: () => { providerID: string; modelID: string } | undefined
}) {
  let sessionID: string | undefined
  let sessionDirectory: string | undefined

  const reset = () => {
    sessionID = undefined
    sessionDirectory = undefined
  }

  const plan = async (
    prompt: string,
    report: BrowserAutomationRun,
    completed: string[],
  ): Promise<BrowserModelPlan> => {
    const directory = await deps.resolveDirectory()
    if (!directory) throw new Error("Open a project before running Browser Agent so Vector can use the selected project model safely.")
    const model = deps.model()
    if (!model) throw new Error("Connect and select a model before running Browser Agent.")

    const client = deps.createClient(directory)
    if (!sessionID || sessionDirectory !== directory) {
      const session = await client.session.create({
        directory,
        title: `${INTERNAL_SESSION_TITLE_PREFIX}Browser Agent Planner`,
        agent: "build",
        model: { providerID: model.providerID, id: model.modelID },
        metadata: {
          source: "vector-browser-agent",
          engine: "opencode-compatible",
          hidden: true,
        },
      })
      sessionID = session.data?.id
      sessionDirectory = directory
      if (!sessionID) throw new Error("Vector could not start the Browser Agent planner.")
    }

    const dom = report.domSummary
    const result = await client.session.prompt({
      sessionID,
      directory,
      agent: "build",
      model,
      system: PLANNER_SYSTEM,
      tools: { bash: false, edit: false, patch: false, write: false },
      parts: [
        {
          type: "text",
          text: JSON.stringify({
            request: prompt,
            currentUrl: report.finalUrl || report.url,
            pageTitle: report.currentPage || report.title,
            pageText: dom?.textSample?.slice(0, 5000) ?? "",
            interactives: (dom?.interactives ?? report.interactives ?? []).slice(0, 40),
            inputs: (dom?.inputs ?? report.inputs ?? []).slice(0, 40),
            runtimeErrors: (report.pageErrors ?? []).slice(-8),
            networkErrors: (report.networkErrors ?? []).slice(-8),
            consoleErrors: (report.console ?? [])
              .filter((line) => line.level === "error")
              .slice(-6)
              .map((line) => line.message.slice(0, 240)),
            completedActions: completed.slice(-12),
          }),
        },
      ],
    })
    const text = extractBrowserModelText(result.data)
    if (!text) return fallbackBrowserModelPlan(prompt, report, completed)
    try {
      const parsed = parseBrowserModelPlan(text)
      if (parsed.complete || parsed.needsUser || parsed.actions.length) return parsed
    } catch {
      // Some models wrap JSON in prose or return malformed output. Browser
      // Agent remains useful by deriving one conservative action from the live
      // DOM instead of silently ending the run.
    }
    return fallbackBrowserModelPlan(prompt, report, completed)
  }

  return { plan, reset }
}
