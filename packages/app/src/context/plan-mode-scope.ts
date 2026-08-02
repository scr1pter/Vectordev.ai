export type PlanModeRouteScope = {
  project: string
  task?: string
}

export function planModeRouteScope(pathname: string, search: string): PlanModeRouteScope {
  const query = new URLSearchParams(search)
  const task = query.get("parentSession") || /\/session\/([^/?#]+)/.exec(pathname)?.[1]
  const project = query.get("project") || pathname.split("/").filter(Boolean)[0] || "home"
  return { project, task: task ? decodeURIComponent(task) : undefined }
}

export function shouldResetPlanMode(previous: PlanModeRouteScope, next: PlanModeRouteScope) {
  if (previous.task && next.task) return previous.task !== next.task
  if (previous.task && !next.task) return true
  if (!previous.task && !next.task) return previous.project !== next.project
  return false
}
