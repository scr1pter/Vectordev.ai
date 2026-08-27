export type ExternalAgentFollowUpDrafts = Record<string, string>

export function externalAgentFollowUpDraft(drafts: ExternalAgentFollowUpDrafts, workspaceID: string) {
  return drafts[workspaceID] ?? ""
}

export function withExternalAgentFollowUpDraft(
  drafts: ExternalAgentFollowUpDrafts,
  workspaceID: string,
  value: string,
): ExternalAgentFollowUpDrafts {
  return { ...drafts, [workspaceID]: value }
}
