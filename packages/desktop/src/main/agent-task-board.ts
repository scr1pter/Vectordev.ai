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
    throw new Error("A task session and project are required.")
  return { parentSessionId: input.parentSessionID, sourcePath: input.sourcePath }
}

export function listAgentTasks(input: TaskScope): Task.ListResult {
  const filter = scope(input)
  const swarms = listSwarmRuns(filter)
  const workspaces = listParallelWorkspaces(filter)
  return {
    tasks: [
      ...swarms.flatMap((run) => swarmTasks(run, Date.now())),
      ...workspaces.map((record) =>
        workspaceTask(record, {
          now: Date.now(),
          swarm: swarms.find((run) => run.id === record.swarmRunId),
          canMessage: parallelWorkspaceCanMessage(record.id),
        }),
      ),
    ],
    truncated: false,
  }
}

export function inspectAgentTask(input: TaskScope & { taskID: string }): Task.InspectResult {
  const task = listAgentTasks(input).tasks.find((task) => task.id === input.taskID)
  if (!task) throw new Error("The task does not belong to this session and project.")
  const workspace = listParallelWorkspaces(scope(input)).find((record) => workspaceTaskID(record) === input.taskID)
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

export async function stopAgentTask(input: TaskScope & { taskID: string }): Promise<Task.StopResult> {
  const task = listAgentTasks(input).tasks.find((task) => task.id === input.taskID)
  if (!task) throw new Error("The task does not belong to this session and project.")
  if (!task.controls.stop) return { tasks: [task] }
  const workspace = listParallelWorkspaces(scope(input)).find((record) => workspaceTaskID(record) === input.taskID)
  const swarm = listSwarmRuns(scope(input)).find((run) => run.id === task.groupID)
  const child = swarm?.tasks.find((child) => `swarm:${swarm.id}:${child.id}` === task.id)
  if (swarm && child) await stopSwarmTask(swarm.id, child.id)
  if (workspace && !child) await stopParallelWorkspace(workspace.id)
  if (!workspace && !child && task.groupID && task.id === `swarm:${task.groupID}`) await stopSwarmRun(task.groupID)
  return listAgentTasks(input)
}

export async function messageAgentTask(
  input: TaskScope & { taskID: string; text: string },
): Promise<Task.MessageResult> {
  const workspace = listParallelWorkspaces(scope(input)).find((record) => workspaceTaskID(record) === input.taskID)
  if (!workspace) throw new Error("The task does not belong to this session and project.")
  const result = await messageParallelWorkspace(workspace.id, input.text)
  return { taskID: input.taskID, messageID: result.messageID, delivery: "steer", accepted: true }
}
