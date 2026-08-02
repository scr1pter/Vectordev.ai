import type { ActivityItem } from "@/services/activity-service"

export type SuggestionRisk = "low" | "medium" | "high"

export type AiSuggestion = {
  id: string
  title: string
  reason: string
  confidence: number
  risk: SuggestionRisk
  action: string
  askPrompt: string
}

export type SuggestionSignals = {
  projectId: string
  projectName: string
  stack: string[]
  changedFiles: string[]
  activities: ActivityItem[]
  latestCheckpointAt?: number
  runningTerminalTasks: number
  browserChecked: boolean
  pendingReviews: number
}

const DISMISSED_KEY = "vector.ai-suggestions.dismissed.v1"

function readDismissed(): Record<string, number> {
  if (typeof localStorage === "undefined") return {}
  try {
    const parsed = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "{}")
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeDismissed(value: Record<string, number>) {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(DISMISSED_KEY, JSON.stringify(value))
}

function hasFile(files: string[], pattern: RegExp) {
  return files.some((file) => pattern.test(file))
}

function recent(events: ActivityItem[], type: ActivityItem["type"], status?: ActivityItem["status"]) {
  return events.find((event) => event.type === type && (!status || event.status === status))
}

function staleCheckpoint(latest?: number) {
  if (!latest) return true
  return Date.now() - latest > 1000 * 60 * 60 * 24
}

export function generateSuggestions(signals: SuggestionSignals) {
  const changed = signals.changedFiles
  const suggestions: AiSuggestion[] = []
  const add = (suggestion: AiSuggestion) => suggestions.push(suggestion)

  if (changed.length > 0) {
    add({
      id: `${signals.projectId}:review-ai-changes:${changed.slice(0, 8).join("|")}`,
      title: "You have unreviewed AI changes",
      reason: `${changed.length} changed file${changed.length === 1 ? "" : "s"} should be reviewed before the next broad task.`,
      confidence: 0.92,
      risk: changed.length > 8 ? "high" : "medium",
      action: "Open Review Changes",
      askPrompt: "Review the current changed files. Summarize risks and tell me what to verify before accepting.",
    })
  }

  if (hasFile(changed, /(^|\/)(auth|middleware|session|login|jwt|oauth|billing|checkout)[^/]*\.(ts|tsx|js|jsx)$/i)) {
    add({
      id: `${signals.projectId}:auth-billing-crosscheck`,
      title: "Security-sensitive files changed",
      reason: "Auth, middleware, checkout, or billing edits often need route guards, error handling, and regression tests checked together.",
      confidence: 0.78,
      risk: "high",
      action: "Ask Vector",
      askPrompt: "Inspect the security-sensitive changes and check whether middleware, route guards, tests, and error states need updates.",
    })
  }

  const terminalFailure = recent(signals.activities, "terminal", "failed") || recent(signals.activities, "error")
  if (terminalFailure) {
    add({
      id: `${signals.projectId}:terminal-failure:${terminalFailure.id}`,
      title: "The last terminal run needs inspection",
      reason: terminalFailure.description || "Vector detected a failed command or terminal error in the activity stream.",
      confidence: 0.86,
      risk: "medium",
      action: "Ask Vector",
      askPrompt: "Inspect the latest terminal failure, explain the root cause, and suggest the safest next command.",
    })
  }

  const browserFailure = recent(signals.activities, "browser", "failed") || recent(signals.activities, "browser", "warning")
  if (browserFailure) {
    add({
      id: `${signals.projectId}:browser-failure:${browserFailure.id}`,
      title: "The controlled browser found something to verify",
      reason: browserFailure.description || "A browser check reported console, runtime, or network issues.",
      confidence: 0.84,
      risk: "medium",
      action: "Open Browser",
      askPrompt: "Use the controlled Browser context to inspect the failing flow and propose a repair plan.",
    })
  }

  if (changed.length > 0 && !signals.browserChecked && signals.stack.some((item) => ["React", "Solid", "Astro", "Vite", "Next.js"].includes(item))) {
    add({
      id: `${signals.projectId}:browser-not-tested:${changed.slice(0, 6).join("|")}`,
      title: "The changed flow has not been browser-tested yet",
      reason: "Frontend files changed, but there is no recent controlled-browser success event for this project.",
      confidence: 0.74,
      risk: "medium",
      action: "Open Browser",
      askPrompt: "Open localhost, test the changed UI flow, and report console/runtime/network errors before any code changes.",
    })
  }

  if (staleCheckpoint(signals.latestCheckpointAt)) {
    add({
      id: `${signals.projectId}:checkpoint-stale`,
      title: "This project has no recent checkpoint",
      reason: "Create a restorable point before more edits so risky work can be backed out cleanly.",
      confidence: 0.7,
      risk: "low",
      action: "Open Checkpoints",
      askPrompt: "Create or inspect the latest checkpoint before continuing with risky edits.",
    })
  }

  if (signals.runningTerminalTasks > 0) {
    add({
      id: `${signals.projectId}:terminal-running`,
      title: "A terminal task is still running",
      reason: `${signals.runningTerminalTasks} terminal task${signals.runningTerminalTasks === 1 ? " is" : "s are"} active. Wait for results before judging the workspace health.`,
      confidence: 0.8,
      risk: "low",
      action: "Open Terminal",
      askPrompt: "Check the running terminal task and summarize whether it is healthy or stuck.",
    })
  }

  const dismissed = readDismissed()
  return suggestions
    .filter((suggestion) => !dismissed[suggestion.id])
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5)
}

export function dismissSuggestion(id: string) {
  writeDismissed({ ...readDismissed(), [id]: Date.now() })
}

export const suggestionService = {
  dismissSuggestion,
  generateSuggestions,
}
