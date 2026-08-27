export function parallelWorkspaceComposerAvailable(input: {
  projectPath: string
  taskOpen: boolean
  draftOpen: boolean
  returnTaskOpen: boolean
}) {
  if (!input.projectPath) return false
  return input.taskOpen || input.draftOpen || input.returnTaskOpen
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
