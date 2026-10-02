export type BranchOption = {
  readonly name: string
  readonly current: boolean
  readonly checkedOutElsewhere?: string
}

export const createRowKey = "\0create"

export const managedWorkspaceHint =
  "This agent workspace is managed by Vector. Create a new branch here instead of switching to an existing one."

/** Desktop parallel workspaces run agents on `vector-parallel/...` branches and merge them back by
    diffing from the workspace's base commit, so the engine only allows creating a branch there. */
export function isManagedWorkspaceBranch(branch: string) {
  return branch.startsWith("vector-parallel/")
}

/** Rows for the branch picker: matching branches (current first, then the engine's most-recent
    order), plus a create row when the typed name is not an existing branch. Whitespace in a typed
    name becomes "-" because git refuses spaces in branch names. */
export function branchPickerRows(branches: readonly BranchOption[], search: string) {
  const term = search.trim()
  const needle = term.toLowerCase()
  const name = term.replace(/\s+/g, "-")
  return {
    branches: branches
      .filter((branch) => branch.name.toLowerCase().includes(needle))
      .toSorted((a, b) => Number(b.current) - Number(a.current)),
    create: name && !branches.some((branch) => branch.name === name) ? name : undefined,
  }
}

/** Keyboard order: selectable branches, then the create row. The current branch and branches
    checked out in another worktree can't be switched to, so the arrows skip them. Nothing is
    selectable while an agent runs, and a managed agent workspace only offers the create row. */
export function branchPickerKeys(
  rows: ReturnType<typeof branchPickerRows>,
  state: { readonly busy: boolean; readonly managed: boolean },
) {
  if (state.busy) return []
  return [
    ...(state.managed ? [] : rows.branches)
      .filter((branch) => !branch.current && !branch.checkedOutElsewhere)
      .map((branch) => branch.name),
    ...(rows.create ? [createRowKey] : []),
  ]
}
