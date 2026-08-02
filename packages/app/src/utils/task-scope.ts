import { checksum } from "@opencode-ai/core/util/encode"
import { pathKey } from "@/utils/path-key"

export type TaskScope = {
  projectPath: string
  taskId?: string
}

export function normalizeTaskScope(scope: TaskScope): TaskScope {
  return {
    projectPath: pathKey(scope.projectPath.trim()),
    taskId: scope.taskId?.trim() || undefined,
  }
}

export function taskScopeId(scope: TaskScope) {
  const normalized = normalizeTaskScope(scope)
  const identity = `${normalized.projectPath || "no-project"}\n${normalized.taskId || "project"}`
  return `task:${checksum(identity) ?? "0"}`
}

export function taskScopeSearch(scope: TaskScope) {
  const normalized = normalizeTaskScope(scope)
  const params = new URLSearchParams()
  if (normalized.projectPath) params.set("project", normalized.projectPath)
  if (normalized.taskId) params.set("parentSession", normalized.taskId)
  const search = params.toString()
  return search ? `?${search}` : ""
}

export function taskScopeFromSearch(search: string): TaskScope {
  const params = new URLSearchParams(search)
  return normalizeTaskScope({
    projectPath: params.get("project") ?? "",
    taskId: params.get("parentSession") ?? undefined,
  })
}
