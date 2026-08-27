export type PullRequestCreateInput = {
  cwd: string
  title: string
  body: string
  base?: string
  draft: boolean
}

export type PullRequestMergeInput = {
  cwd: string
  number: number
  strategy: "merge" | "squash" | "rebase"
}

export function buildPullRequestCreateInput(input: {
  cwd: string
  title: string
  body: string
  base: string
  draft: boolean
}): PullRequestCreateInput {
  const base = input.base.trim()
  return {
    cwd: input.cwd,
    title: input.title.trim(),
    body: input.body,
    ...(base ? { base } : {}),
    draft: input.draft,
  }
}

export function buildPullRequestMergeInput(input: PullRequestMergeInput): PullRequestMergeInput {
  return input
}

export function pullRequestProjectIsCurrent(
  request: { path?: string; revision: number },
  current: { path?: string; revision: number },
) {
  return request.path === current.path && request.revision === current.revision
}

export function pullRequestMergeAction(confirming: boolean) {
  return confirming ? ("merge" as const) : ("confirm" as const)
}

export function pullRequestErrorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}
