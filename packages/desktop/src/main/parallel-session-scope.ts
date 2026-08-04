export type ParallelSessionScopeInput = {
  workspaceId: string
  workspaceName: string
  isolatedPath: string
  sourcePath: string
  parentSessionId?: string
  engineParentSessionId?: string
  provider?: string
  model?: string
  agent?: string
}

function validSessionParent(value?: string) {
  return value?.startsWith("ses") ? value : undefined
}

export function parallelSessionCreateRequest(input: ParallelSessionScopeInput) {
  const parentID = validSessionParent(input.engineParentSessionId) ?? validSessionParent(input.parentSessionId)
  const query = new URLSearchParams({ directory: input.isolatedPath })
  return {
    path: `/session?${query.toString()}`,
    body: {
      parentID,
      title: `${input.workspaceName} · isolated agent`,
      model:
        input.provider && input.model && !input.provider.startsWith("Current ")
          ? { providerID: input.provider, id: input.model }
          : undefined,
      agent: input.agent,
      metadata: {
        vector: {
          kind: "parallel-agent",
          workspaceId: input.workspaceId,
          sourcePath: input.sourcePath,
          parentSessionId: parentID,
        },
      },
    },
  }
}
