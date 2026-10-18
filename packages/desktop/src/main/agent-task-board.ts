import type { Task } from "@vectordevai/schema/task"
import {
  listParallelWorkspaces,
  messageParallelWorkspace,
  parallelWorkspaceCanMessage,
  stopParallelWorkspace,
} from "./parallel-workspaces"
import { listSwarmRuns, stopSwarmRun, stopSwarmTask } from "./swarm-orchestrator"
import { swarmTasks, workspaceTask, workspaceTaskID } from "./agent-task-model"

export type TaskScope = { parentSessionID: string; sourcePath: string }

function scope(input: TaskScope) {
  if (!input.parentSessionID?.trim() || !input.sourcePath?.trim())
    throw new Error("A task session and repository are required.")
  return { parentSessionId: input.parentSessionID, sourcePath: input.sourcePath }
}

export function listAgentTasks(input: TaskScope): Task.ListResult {
  const filter = scope(input)
  const swarms = listSwarmRuns(filter)
  const workspaces = listTaskWorkspaces(input)
  return {
    tasks: [
      ...new Map(
        [
          ...swarms.flatMap((run) => swarmTasks(run, Date.now())),
          ...workspaces.map((record) =>
            workspaceTask(record, {
              now: Date.now(),
              swarm: swarms.find((run) => run.id === record.swarmRunId),
              canMessage: parallelWorkspaceCanMessage(record.id),
            }),
          ),
        ].map((task) => [task.id, task] as const),
      ).values(),
    ].sort(
      (a, b) =>
        Number(["queued", "running", "waiting_on_user"].includes(b.status)) -
          Number(["queued", "running", "waiting_on_user"].includes(a.status)) || b.startedAt - a.startedAt,
    ),
    truncated: false,
  }
}

// Swarm workers live under a staging directory and a synthetic parent. Join only
// workspace IDs recorded by runs owned by this real parent and project.
export function listTaskWorkspaces(input: TaskScope) {
  const filter = scope(input)
  const swarms = listSwarmRuns(filter)
  return listParallelWorkspaces().filter((record) => {
    if (!record.swarmRunId)
      return record.sourcePath === filter.sourcePath && record.parentSessionId === filter.parentSessionId
    return swarms.some(
      (run) =>
        run.id === record.swarmRunId &&
        run.tasks.some((task) => task.workspaceId === record.id && task.id === record.swarmTaskId),
    )
  })
}

export function inspectAgentTask(input: TaskScope & { taskID: string }): Task.InspectResult {
  const task = listAgentTasks(input).tasks.find((task) => task.id === input.taskID)
  if (!task) throw new Error("The task does not belong to this session and repository.")
  const workspace = listTaskWorkspaces(input).find((record) => workspaceTaskID(record) === input.taskID)
  const swarm = listSwarmRuns(scope(input)).find((run) => run.id === task.groupID)
  const child = swarm?.tasks.find((entry) => `swarm:${swarm.id}:${entry.id}` === task.id)
  const output = workspace?.finalSummary || child?.summary || swarm?.summary || ""
  const steps =
    workspace?.turns?.flatMap(
      (turn) =>
        turn.activity?.map((activity) => ({
          tool: activity.kind,
          status: activity.state,
          text: activity.label.slice(0, 500),
        })) ?? [],
    ) ?? (workspace?.logs ?? swarm?.logs ?? []).slice(0, 8).map((text) => ({ text: text.slice(0, 500) }))
  return {
    task,
    steps: steps.slice(-8),
    output: output.slice(0, 6000),
    truncated: steps.length > 8 || output.length > 6000,
  }
}

export async function stopAgentTask(input: TaskScope & { taskID: string; reason?: string }): Promise<Task.StopResult> {
  const task = listAgentTasks(input).tasks.find((task) => task.id === input.taskID)
  if (!task) throw new Error("The task does not belong to this session and repository.")
  if (!task.controls.stop) return { tasks: [task] }
  const workspace = listTaskWorkspaces(input).find((record) => workspaceTaskID(record) === input.taskID)
  const swarm = listSwarmRuns(scope(input)).find((run) => run.id === task.groupID)
  const child = swarm?.tasks.find((child) => `swarm:${swarm.id}:${child.id}` === task.id)
  if (swarm && child) await stopSwarmTask(swarm.id, child.id, undefined, input.reason)
  if (workspace && !child) await stopParallelWorkspace(workspace.id, input.reason)
  if (!workspace && !child && task.groupID && task.id === `swarm:${task.groupID}`)
    await stopSwarmRun(task.groupID, undefined, undefined, input.reason)
  return listAgentTasks(input)
}

export async function messageAgentTask(
  input: TaskScope & { taskID: string; text: string },
): Promise<Task.MessageResult> {
  const workspace = listTaskWorkspaces(input).find((record) => workspaceTaskID(record) === input.taskID)
  if (!workspace) throw new Error("The task does not belong to this session and repository.")
  const result = await messageParallelWorkspace(workspace.id, input.text)
  return { taskID: input.taskID, messageID: result.messageID, delivery: "steer", accepted: true }
}
