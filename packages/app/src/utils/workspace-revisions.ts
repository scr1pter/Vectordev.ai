// Agent workspace lists are polled every second or so, and every poll returns new objects. The desktop bumps a
// workspace record's revision on each write, so a poll with the same records at the same revisions changed nothing:
// keeping the previous list stops everything built from it, sidebar rows and file tree markers included, from being
// rebuilt on every poll. A record without a revision is always treated as changed.
export function sameWorkspaceRevisions(
  previous: readonly { id: string; revision?: number }[],
  next: readonly { id: string; revision?: number }[],
) {
  return (
    previous.length === next.length &&
    previous.every(
      (record, index) =>
        record.revision !== undefined && record.id === next[index]?.id && record.revision === next[index]?.revision,
    )
  )
}
