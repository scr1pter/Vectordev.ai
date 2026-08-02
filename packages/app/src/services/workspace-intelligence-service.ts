import type { ActivityItem } from "@/services/activity-service"
import type { AiSuggestion } from "@/services/suggestion-service"

export type WorkspaceIntelligenceInput = {
  projectName: string
  branch?: string
  rootFiles: string[]
  recentSessionTitles: string[]
  activities: ActivityItem[]
  suggestions: AiSuggestion[]
  runningTerminalTasks: number
  latestCheckpointAt?: number
  pendingReviews: number
  browserChecked: boolean
}

export type WorkspaceIntelligenceSummary = {
  projectName: string
  stack: string[]
  branch: string
  health: "steady" | "watch" | "risk"
  healthLabel: string
  greeting: string
  openRisks: string[]
  recentActivity: string[]
  latestCheckpoint: string
  runningTerminalTasks: number
  browserStatus: string
  pendingReviews: number
  nextAction: string
}

function includes(files: string[], name: string) {
  return files.some((file) => file === name || file.endsWith(`/${name}`))
}

export function detectStack(rootFiles: string[]) {
  const stack = new Set<string>()
  if (includes(rootFiles, "package.json")) stack.add("Node")
  if (includes(rootFiles, "bun.lock") || includes(rootFiles, "bun.lockb")) stack.add("Bun")
  if (includes(rootFiles, "vite.config.ts") || includes(rootFiles, "vite.config.js")) stack.add("Vite")
  if (includes(rootFiles, "astro.config.mjs") || includes(rootFiles, "astro.config.ts")) stack.add("Astro")
  if (includes(rootFiles, "next.config.js") || includes(rootFiles, "next.config.mjs") || includes(rootFiles, "next.config.ts")) stack.add("Next.js")
  if (includes(rootFiles, "solid.config.ts") || includes(rootFiles, "app.config.ts")) stack.add("Solid")
  if (includes(rootFiles, "tsconfig.json")) stack.add("TypeScript")
  if (includes(rootFiles, "wrangler.toml")) stack.add("Cloudflare")
  if (includes(rootFiles, "vercel.json")) stack.add("Vercel")
  if (includes(rootFiles, "Dockerfile")) stack.add("Docker")
  if (includes(rootFiles, "Cargo.toml")) stack.add("Rust")
  if (includes(rootFiles, "pyproject.toml") || includes(rootFiles, "requirements.txt")) stack.add("Python")
  return [...stack]
}

function relativeTime(value?: number) {
  if (!value) return "No checkpoint found"
  const diff = Date.now() - value
  const minutes = Math.max(1, Math.round(diff / 60000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function summarizeWorkspace(input: WorkspaceIntelligenceInput): WorkspaceIntelligenceSummary {
  const stack = detectStack(input.rootFiles)
  const failed = input.activities.some((event) => event.status === "failed")
  const warnings = input.activities.filter((event) => event.status === "warning").length + input.suggestions.filter((item) => item.risk === "high").length
  const health = failed || warnings > 1 ? "risk" : warnings > 0 || input.pendingReviews > 0 ? "watch" : "steady"
  const healthLabel = health === "risk" ? "Needs attention" : health === "watch" ? "Watch list" : "Healthy"
  const workedOn = input.recentSessionTitles.slice(0, 2).filter(Boolean).join(" and ")
  const topSuggestion = input.suggestions[0]
  const nextAction =
    topSuggestion?.action === "Ask Vector"
      ? topSuggestion.askPrompt
      : topSuggestion
        ? topSuggestion.title
        : input.browserChecked
          ? "Continue with a focused task, then create a checkpoint when the diff is ready."
          : "Open Browser and let Vector test the main local flow before the next broad change."

  return {
    projectName: input.projectName || "Workspace",
    stack,
    branch: input.branch || "No branch detected",
    health,
    healthLabel,
    greeting: workedOn
      ? `Welcome back. Recently you worked on ${workedOn}. Today, I recommend ${nextAction.toLowerCase()}`
      : `Welcome back. Vector is watching project signals and recommends: ${nextAction}`,
    openRisks: input.suggestions.filter((item) => item.risk !== "low").map((item) => item.title).slice(0, 4),
    recentActivity: input.activities.slice(0, 4).map((event) => event.title),
    latestCheckpoint: relativeTime(input.latestCheckpointAt),
    runningTerminalTasks: input.runningTerminalTasks,
    browserStatus: input.browserChecked ? "Recently checked" : "Not tested yet",
    pendingReviews: input.pendingReviews,
    nextAction,
  }
}

export const workspaceIntelligenceService = {
  detectStack,
  summarizeWorkspace,
}
