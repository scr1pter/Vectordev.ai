export type ExternalAgentFollowUpDrafts = Record<string, string>

export function externalAgentFollowUpSubmission(input: { draft: string; running: boolean; sending: boolean }) {
  if (input.running || input.sending) return undefined
  return input.draft.trim() || undefined
}

export function restoreExternalAgentFollowUpDraft(
  drafts: ExternalAgentFollowUpDrafts,
  workspaceID: string,
  submitted: string,
): ExternalAgentFollowUpDrafts {
  const current = externalAgentFollowUpDraft(drafts, workspaceID)
  return withExternalAgentFollowUpDraft(drafts, workspaceID, current ? `${submitted}\n\n${current}` : submitted)
}

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
