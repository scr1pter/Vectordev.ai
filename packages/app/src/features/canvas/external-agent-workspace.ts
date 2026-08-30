import type { ExternalRuntime } from "@/features/agents/external-runtimes"

export type CanvasExternalWorkspaceRecord = {
  id: string
  name: string
  taskPrompt: string
  runtime: ExternalRuntime | "vector"
  status: string
  lastAction?: string
  lastActivityAt: string
  changedFilesCount: number
  mergeState: "none" | "merged" | "discarded"
}

export function canvasExternalWorkspaceDraft(runtime: ExternalRuntime, prompt: string) {
  const taskPrompt = prompt.trim()
  if (!taskPrompt) return undefined
  return {
    runtime,
    taskPrompt,
    name: taskPrompt.slice(0, 54),
  }
}

export function reopenableCanvasExternalWorkspaces(records: CanvasExternalWorkspaceRecord[], runtime: ExternalRuntime) {
  return records
    .filter((record) => record.runtime === runtime)
    .filter((record) => record.mergeState === "none")
    .filter((record) => !["merged", "discarded"].includes(record.status))
    .slice()
    .sort((left, right) => new Date(right.lastActivityAt).getTime() - new Date(left.lastActivityAt).getTime())
}
