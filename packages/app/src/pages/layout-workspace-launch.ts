import { sessionHref } from "@/utils/session-route"
import { taskScopeSearch, type TaskScope } from "@/utils/task-scope"

export function parallelWorkspaceComposerAvailable(input: {
  projectPath: string
  taskOpen: boolean
  draftOpen: boolean
  returnTaskOpen: boolean
}) {
  if (!input.projectPath) return false
  return input.taskOpen || input.draftOpen || input.returnTaskOpen
}

export type ParallelWorkspaceRuntime = "vector" | "claude-code" | "codex" | "cursor"
export type ParallelWorkspaceView = "chat" | "files" | "changes" | "terminal" | "browser" | "activity"

export function parallelWorkspacePresentation(runtime: ParallelWorkspaceRuntime) {
  if (runtime === "vector") return "session" as const
  return "external-workspace" as const
}

export function parallelWorkspaceIDFromPath(pathname: string) {
  const [section, workspaceID, trailing] = pathname.split("/").filter(Boolean)
  if (section !== "parallel-workspaces" || !workspaceID || workspaceID === "swarm" || trailing) return undefined
  try {
    return decodeURIComponent(workspaceID)
  } catch {
    return undefined
  }
}

export function parallelWorkspaceView(value: string | null | undefined): ParallelWorkspaceView {
  if (["files", "changes", "terminal", "browser", "activity"].includes(value ?? "")) {
    return value as ParallelWorkspaceView
  }
  return "chat"
}

export function parallelWorkspaceHref(input: {
  workspaceID: string
  scopeSearch?: string
  view?: ParallelWorkspaceView
}) {
  const search = new URLSearchParams(input.scopeSearch?.replace(/^\?/, ""))
  if (input.view && input.view !== "chat") search.set("view", input.view)
  const query = search.toString()
  return `/parallel-workspaces/${encodeURIComponent(input.workspaceID)}${query ? `?${query}` : ""}`
}

export function parallelWorkspaceToolDirectory(input: { sourcePath: string; isolatedPath: string }) {
  return input.isolatedPath
}

export function parallelWorkspaceNavigation(input: {
  workspaceID: string
  runtime: ParallelWorkspaceRuntime
  agentSessionID?: string
  server: Parameters<typeof sessionHref>[0]
  scope: TaskScope
  view?: ParallelWorkspaceView
}) {
  if (parallelWorkspacePresentation(input.runtime) === "external-workspace") {
    return {
      mode: "external-workspace" as const,
      href: parallelWorkspaceHref({
        workspaceID: input.workspaceID,
        scopeSearch: taskScopeSearch(input.scope),
        view: input.view,
      }),
    }
  }
  if (!input.agentSessionID) return { mode: "pending" as const }
  return {
    mode: "session" as const,
    href: `${sessionHref(input.server, input.agentSessionID)}${taskScopeSearch(input.scope)}`,
  }
}

export async function materializeParallelWorkspaceParent<T extends { id: string }>(input: {
  scope: { sourcePath: string; parentSessionId?: string }
  draftID?: string
  createSession: (sourcePath: string) => Promise<T>
  rememberSession: (session: T) => void
  promoteDraft: (draftID: string, sessionID: string) => void
}) {
  if (input.scope.parentSessionId || !input.scope.sourcePath || !input.draftID) return input.scope
  const session = await input.createSession(input.scope.sourcePath)
  input.rememberSession(session)
  input.promoteDraft(input.draftID, session.id)
  return { ...input.scope, parentSessionId: session.id }
}
