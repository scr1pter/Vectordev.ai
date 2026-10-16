// A swarm's workers belong to the swarm: the desktop gives each one the parent session `swarm:<run id>`, so the
// task's own workspace list leaves them out. A poll reads them under that scope, one list per swarm, the way it reads
// the task's list. Refreshing each worker instead re-diffed its checkout on every 0.5-1.5 s poll (three git commands,
// or hashing both whole trees for a copy), and a refresh of a finished worker with changes rewrites its status to
// "needs review", which can make a failed worker read as finished to the swarm waiting on it.
export async function listSwarmWorkers<T extends { id: string }>(input: {
  runs: readonly { id: string; tasks: readonly { workspaceId?: string }[] }[]
  // Workspaces the task's own list already returned.
  listed: readonly { id: string }[]
  list: (scope: { parentSessionId: string }) => Promise<T[]>
}) {
  const listed = new Set(input.listed.map((record) => record.id))
  const runs = input.runs
    .map((run) => ({
      scope: `swarm:${run.id}`,
      ids: run.tasks.flatMap((task) => (task.workspaceId && !listed.has(task.workspaceId) ? [task.workspaceId] : [])),
    }))
    .filter((run) => run.ids.length)
  const lists = await Promise.all(runs.map((run) => input.list({ parentSessionId: run.scope }).catch(() => [] as T[])))
  const found = new Map(lists.flat().map((record) => [record.id, record]))
  return [...new Set(runs.flatMap((run) => run.ids))].flatMap((id) => {
    const record = found.get(id)
    return record ? [record] : []
  })
}
