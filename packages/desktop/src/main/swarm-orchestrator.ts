import { randomUUID } from "node:crypto"
import { stat } from "node:fs/promises"

import type { SessionMessage } from "@vectordevai/schema/session-message"

import { getStore } from "./store"
import { createStoreCache } from "./store-cache"
import { taskBoardChanged } from "./task-board-events"
import {
  createParallelWorkspace,
  discardParallelWorkspace,
  getParallelWorkspace,
  interruptEngineSession,
  mergeParallelWorkspace,
  mergeParallelWorkspaceSelection,
  refreshParallelWorkspace,
  rollBackUnfinishedMerge,
  runParallelWorkspace,
  stopParallelWorkspace,
  type ParallelWorkspaceEngine,
  type ParallelWorkspaceRecord,
} from "./parallel-workspaces"
import {
  fallbackSwarmPlan,
  findSwarmPlan,
  routeSwarmModels,
  selectSwarmPlannerModel,
  swarmModelPool,
  type SwarmAgentRole,
  type SwarmModelCandidate,
  type SwarmStrategy,
} from "./swarm-plan"
import type { UnifiedDiffSelection } from "./unified-diff"

const STORE_NAME = "swarm-orchestrator-state"
const STORE_KEY = "runs"
const activeRuns = new Map<string, { controller: AbortController; completion: Promise<void> }>()
const stoppingRuns = new Map<string, Promise<SwarmRunRecord>>()
const taskExecutions = new Map<string, Map<string, Promise<void>>>()
// Task statuses only a live worker holds. Without a scheduler or a Stop owning the run, no worker is left.
const IN_FLIGHT = ["creating", "queued", "running", "merging"]
// Resume and Discard of one run take turns. Resume reads the run, waits on cleanup and the disk, and then starts a
// scheduler: a Discard in between would neither see that scheduler to stop it nor the workers it creates, and the
// scheduler would overwrite the discarded run when it finished.
const runTurns = new Map<string, Promise<unknown>>()

function inTurn<T>(id: string, work: () => Promise<T>) {
  const turn = (runTurns.get(id) ?? Promise.resolve()).catch(() => undefined).then(work)
  runTurns.set(id, turn)
  return turn.finally(() => {
    if (runTurns.get(id) === turn) runTurns.delete(id)
  })
}

export type SwarmRunStatus =
  | "planning"
  | "running"
  | "needs review"
  | "complete"
  | "failed"
  | "canceled"
  | "interrupted"
  | "merged"
  | "discarded"

export type SwarmTaskStatus =
  | "planned"
  | "blocked"
  | "creating"
  | "queued"
  | "running"
  | "merging"
  | "complete"
  | "failed"
  | "canceled"
  | "interrupted"

export type SwarmTaskRecord = {
  id: string
  title: string
  prompt: string
  role: SwarmAgentRole
  dependsOn: string[]
  fileHints: string[]
  provider: string
  model: string
  status: SwarmTaskStatus
  workspaceId?: string
  startedAt?: string
  completedAt?: string
  lastAction: string
  changedFilesCount: number
  riskLevel: "low" | "medium" | "high"
  summary: string
  error?: string
  cancelRequested?: boolean
}

export type SwarmRunRecord = {
  id: string
  name: string
  objective: string
  sourcePath: string
  parentSessionId?: string
  strategy: SwarmStrategy
  maxAgents: number
  maxConcurrency: number
  modelPool: SwarmModelCandidate[]
  plannerProvider: string
  plannerModel: string
  plannerSessionId?: string
  coordinatorWorkspaceId?: string
  status: SwarmRunStatus
  currentStep: string
  progress: number
  planSummary: string
  tasks: SwarmTaskRecord[]
  createdAt: string
  updatedAt: string
  completedAt?: string
  changedFiles: string[]
  diff: string
  riskLevel: "low" | "medium" | "high"
  summary: string
  logs: string[]
  error?: string
}

export type CreateSwarmRunInput = {
  sourcePath: string
  parentSessionId?: string
  name?: string
  objective: string
  primaryProvider: string
  primaryModel: string
  modelPool?: SwarmModelCandidate[]
  strategy?: SwarmStrategy
  maxAgents?: number
  maxConcurrency?: number
}

const now = () => new Date().toISOString()

const cache = createStoreCache<SwarmRunRecord>()

function readRuns(): SwarmRunRecord[] {
  const store = getStore(STORE_NAME)
  return cache.read(store, () => {
    const raw = store.get(STORE_KEY)
    if (!Array.isArray(raw)) return []
    return raw.filter((item): item is SwarmRunRecord => typeof item?.id === "string")
  })
}

function writeRuns(runs: SwarmRunRecord[]) {
  const store = getStore(STORE_NAME)
  store.set(STORE_KEY, runs)
  cache.wrote(store, runs)
  taskBoardChanged()
}

function deriveProgress(tasks: SwarmTaskRecord[]) {
  if (!tasks.length) return 0
  return Math.round((tasks.filter((task) => task.status === "complete").length / tasks.length) * 100)
}

function updateRun(id: string, update: (run: SwarmRunRecord) => SwarmRunRecord) {
  const runs = readRuns()
  const index = runs.findIndex((run) => run.id === id)
  if (index === -1) throw new Error("Swarm run was not found.")
  const next = update(runs[index])
  runs[index] = { ...next, progress: deriveProgress(next.tasks), updatedAt: now() }
  writeRuns(runs)
  return runs[index]
}

function updateTask(id: string, taskID: string, update: (task: SwarmTaskRecord) => SwarmTaskRecord) {
  return updateRun(id, (run) => ({
    ...run,
    tasks: run.tasks.map((task) => (task.id === taskID ? update(task) : task)),
  }))
}

function appendLog(id: string, message: string) {
  return updateRun(id, (run) => ({ ...run, logs: [...run.logs, `${now()}  ${message}`].slice(-240) }))
}

export function listSwarmRuns(scope?: { sourcePath?: string; parentSessionId?: string }) {
  const runs = readRuns()
  let changed = false
  const recovered = runs.map((run) => {
    if (activeRuns.has(run.id) || stoppingRuns.has(run.id)) return run
    const unfinished = ["planning", "running"].includes(run.status)
    // A run can also be stranded after its status settled: Stop gives up waiting after 10 seconds and records the run
    // canceled while its workers wind down. If Vector closed before they did, their tasks would stay in flight for
    // good, and Resume could neither retry nor finish them.
    if (!unfinished && !run.tasks.some((task) => IN_FLIGHT.includes(task.status))) return run
    changed = true
    return {
      ...run,
      status: unfinished ? ("interrupted" as const) : run.status,
      currentStep: unfinished
        ? "Interrupted when Vector closed"
        : run.status === "canceled"
          ? "Swarm stopped"
          : run.currentStep,
      updatedAt: now(),
      tasks: run.tasks.map((task) =>
        IN_FLIGHT.includes(task.status)
          ? { ...task, status: "interrupted" as const, lastAction: "Interrupted when Vector closed" }
          : task,
      ),
      logs: [...run.logs, `${now()}  Vector recovered an interrupted swarm run.`].slice(-240),
    }
  })
  if (changed) writeRuns(recovered)
  if (!scope) return recovered
  return recovered.filter((run) => {
    if (scope.sourcePath && run.sourcePath !== scope.sourcePath) return false
    if ("parentSessionId" in scope && run.parentSessionId !== scope.parentSessionId) return false
    return true
  })
}

export function getSwarmRun(id: string) {
  return readRuns().find((run) => run.id === id)
}

export async function createSwarmRun(input: CreateSwarmRunInput, engine: ParallelWorkspaceEngine) {
  const source = await stat(input.sourcePath).catch(() => undefined)
  if (!source?.isDirectory()) throw new Error("Open a valid project before launching an agent swarm.")
  const objective = input.objective.trim()
  if (!objective) throw new Error("Describe the objective Vector should decompose.")
  if (!input.primaryProvider.trim() || !input.primaryModel.trim()) {
    throw new Error("Connect and select a model before launching an agent swarm.")
  }

  const modelPool = swarmModelPool(
    { provider: input.primaryProvider.trim(), model: input.primaryModel.trim() },
    input.modelPool ?? [],
  )
  const strategy = input.strategy ?? "balanced"
  const planner = selectSwarmPlannerModel(modelPool, strategy)
  const requestedAgents = Number.isFinite(input.maxAgents) ? Math.floor(input.maxAgents!) : 8
  const requestedConcurrency = Number.isFinite(input.maxConcurrency) ? Math.floor(input.maxConcurrency!) : 4
  const maxAgents = Math.max(2, requestedAgents)
  const maxConcurrency = Math.max(1, Math.min(maxAgents, requestedConcurrency))
  const createdAt = now()
  const id = randomUUID()
  const record: SwarmRunRecord = {
    id,
    name: input.name?.trim() || objective.split(/\s+/).slice(0, 7).join(" "),
    objective,
    sourcePath: input.sourcePath,
    parentSessionId: input.parentSessionId,
    strategy,
    maxAgents,
    maxConcurrency,
    modelPool,
    plannerProvider: planner.provider,
    plannerModel: planner.model,
    status: "planning",
    currentStep: "Creating the isolated staging workspace",
    progress: 0,
    planSummary: "",
    tasks: [],
    createdAt,
    updatedAt: createdAt,
    changedFiles: [],
    diff: "",
    riskLevel: "low",
    summary: "Vector is inspecting the project and decomposing the objective.",
    logs: [`${createdAt}  Swarm admitted with up to ${maxAgents} tasks and ${maxConcurrency} concurrent workers.`],
  }
  writeRuns([record, ...readRuns()])
  startSwarmRun(id, engine)
  return getSwarmRun(id) ?? record
}

export function resumeSwarmRun(id: string, engine: ParallelWorkspaceEngine) {
  return inTurn(id, async () => {
    const stopping = stoppingRuns.get(id)
    if (stopping && !(await waitForCleanup(stopping)))
      throw new Error("The stopped swarm is still cleaning up. Wait for its workspaces to settle before resuming.")
    const active = activeRuns.get(id)
    if (active && !active.controller.signal.aborted) return getSwarmRun(id)!
    // A stopped scheduler must finish unwinding before another one can own the run.
    if (active && !(await waitForCleanup(active.completion)))
      throw new Error("The stopped swarm is still cleaning up. Wait for its workspaces to settle before resuming.")
    const current = getSwarmRun(id)
    if (!current) throw new Error("Swarm run was not found.")
    if (["merged", "discarded", "needs review", "complete"].includes(current.status)) return current
    if (current.coordinatorWorkspaceId) {
      const coordinator = getParallelWorkspace(current.coordinatorWorkspaceId)
      const exists = coordinator && (await stat(coordinator.isolatedPath).catch(() => undefined))
      if (!exists)
        throw new Error("The swarm staging workspace no longer exists. Discard this run and launch a new swarm.")
    }
    // Nothing else owns the run by the time the scheduler starts, so a task still in flight lost its worker, for
    // example when Vector closed while Stop was waiting for it.
    const retryable = (task: SwarmTaskRecord) =>
      ["failed", "blocked", "canceled", "interrupted", ...IN_FLIGHT].includes(task.status)
    const workspace = (task: SwarmTaskRecord) => (task.workspaceId ? getParallelWorkspace(task.workspaceId) : undefined)
    // Workers whose merge into staging is all that is left of their task, so the scheduler merges them instead of
    // running the agent again, which would pay for the same work twice (see executeSwarmTask):
    // - Vector stopped part-way through writing the worker's changes into staging. That merge is undone below and the
    //   worker merged afresh.
    // - The agent finished and passed its checks, and the merge never began: Vector closed during the pre-merge checks,
    //   or Stop came after the agent finished.
    // - The merge failed for a reason other than a conflict, such as a write, after the agent finished and passed its
    //   checks, and undid what it wrote.
    // A merge refused by a conflict is never retried as it was: staging holds a sibling's change where this worker's
    // changes go, and only the agent, run again from that staging, can work around it.
    // In each case the worker's isolated copy must still exist: it is the only complete copy of the changes.
    const kept = new Set(
      (
        await Promise.all(
          current.tasks.filter(retryable).map(async (task) => {
            const previous = workspace(task)
            if (previous?.mergeState !== "none" || !(await stat(previous.isolatedPath).catch(() => undefined)))
              return []
            if (previous.mergeFailure) return previous.mergeFailure === "error" ? [task.id] : []
            const finished =
              ["complete", "needs review"].includes(previous.status) &&
              previous.changedFilesCount > 0 &&
              previous.validationPassed !== false &&
              !previous.error
            return previous.mergeStartedAt || finished ? [task.id] : []
          }),
        )
      ).flat(),
    )
    // Undo what an unfinished merge wrote into staging now, while no worker of this run can merge there. Once the
    // scheduler runs, a sibling could merge a file the unfinished merge never reached, and undoing it would revert
    // that.
    await Promise.all(
      current.tasks
        .filter((task) => retryable(task) && workspace(task)?.mergeStartedAt && workspace(task)?.mergeState === "none")
        .map((task) => rollBackUnfinishedMerge(task.workspaceId!)),
    )
    if (activeRuns.has(id)) return getSwarmRun(id)!
    if (stoppingRuns.has(id))
      throw new Error("The stopped swarm is still cleaning up. Wait for its workspaces to settle before resuming.")
    // A retry starts in a new workspace from the staging baseline, and the task forgets the old one, so nothing could
    // open or discard the previous attempt's copy of the project again. Release it instead of leaving it on disk.
    const retired = getSwarmRun(id)!
      .tasks.filter((task) => retryable(task) && workspace(task)?.mergeState === "none" && !kept.has(task.id))
      .map((task) => task.workspaceId!)
    updateRun(id, (run) => ({
      ...run,
      status: run.tasks.length ? "running" : "planning",
      currentStep: run.tasks.length ? "Resuming dependency scheduler" : "Resuming project decomposition",
      completedAt: undefined,
      error: undefined,
      tasks: run.tasks.map((task): SwarmTaskRecord => {
        if (!retryable(task)) return task
        const merged = workspace(task)
        // Vector closed after this worker's changes reached staging but before the task was recorded complete. Running
        // it again would apply the same edits on top of themselves. The task's own summary may be the error of an
        // attempt that failed before someone merged the worker by hand, so the workspace says what the agent did.
        if (merged?.mergeState === "merged") {
          const integrated =
            merged.validationPassed === true
              ? "Validated changes integrated into staging"
              : "Changes integrated into staging"
          return {
            ...task,
            status: "complete",
            completedAt: task.completedAt ?? now(),
            lastAction: integrated,
            changedFilesCount: merged.changedFilesCount,
            riskLevel: merged.riskLevel,
            summary: merged.summaryBeforeMerge || merged.finalSummary || integrated,
            error: undefined,
          }
        }
        if (kept.has(task.id))
          return {
            ...task,
            status: "planned",
            cancelRequested: undefined,
            completedAt: undefined,
            lastAction: "Ready to integrate its finished changes into staging",
            error: undefined,
          }
        return {
          ...task,
          status: "planned",
          cancelRequested: undefined,
          workspaceId: undefined,
          startedAt: undefined,
          completedAt: undefined,
          lastAction: "Ready to retry",
          error: undefined,
        }
      }),
    }))
    appendLog(id, "Swarm resumed by the user.")
    void Promise.all(retired.map((workspaceID) => discardParallelWorkspace(workspaceID).catch(() => undefined)))
    startSwarmRun(id, engine)
    return getSwarmRun(id)!
  })
}

export async function stopSwarmRun(id: string, timeoutMs = 10_000, stopWorkspace = stopParallelWorkspace) {
  const current = getSwarmRun(id)
  if (!current) throw new Error("Swarm run was not found.")
  const active = activeRuns.get(id)
  const stopping = stoppingRuns.get(id)
  if (!active && !stopping && !["planning", "running", "interrupted"].includes(current.status)) return current
  active?.controller.abort()
  const cleanup =
    stopping ??
    Promise.resolve()
      .then(async () => {
        await active?.completion
        await Promise.all(
          (getSwarmRun(id)?.tasks ?? [])
            .filter((task) => task.workspaceId && IN_FLIGHT.includes(task.status))
            .map((task) => stopWorkspace(task.workspaceId!).catch(() => undefined)),
        )
        return updateRun(id, (run) => ({
          ...run,
          status: "canceled",
          currentStep: "Swarm stopped",
          completedAt: now(),
          tasks: run.tasks.map((task) =>
            ["planned", "creating", "queued", "running", "merging"].includes(task.status)
              ? { ...task, status: "canceled", completedAt: now(), lastAction: "Canceled by user" }
              : task,
          ),
          logs: [...run.logs, `${now()}  Swarm stopped by the user.`].slice(-240),
        }))
      })
      .finally(() => {
        if (stoppingRuns.get(id) === cleanup) stoppingRuns.delete(id)
      })
  stoppingRuns.set(id, cleanup)
  if (await waitForCleanup(cleanup, timeoutMs)) return getSwarmRun(id)!
  if (stoppingRuns.get(id) !== cleanup) return getSwarmRun(id)!
  // Keep ownership until the operation settles. A late merge must be recorded complete before Resume can retry.
  return updateRun(id, (run) => ({
    ...run,
    status: "canceled",
    currentStep: "Swarm stopped; workspace cleanup is still finishing",
    logs: [...run.logs, `${now()}  Stop returned while workspace cleanup continues.`].slice(-240),
  }))
}

export function stopSwarmTask(id: string, taskID: string, timeoutMs = 10_000) {
  return inTurn(id, async () => {
    const current = getSwarmRun(id)
    if (!current) throw new Error("Swarm run was not found.")
    const task = current.tasks.find((task) => task.id === taskID)
    if (!task) throw new Error("The task does not belong to this swarm.")
    if (["complete", "failed", "canceled", "interrupted"].includes(task.status)) return current
    const selected = new Set([taskID])
    // Settle the entire dependency chain now, including workers that have no workspace yet.
    while (current.tasks.some((task) => !selected.has(task.id) && task.dependsOn.some((id) => selected.has(id)))) {
      current.tasks
        .filter((task) => task.dependsOn.some((id) => selected.has(id)))
        .forEach((task) => selected.add(task.id))
    }
    const executing = taskExecutions.get(id)
    updateRun(id, (run) => ({
      ...run,
      tasks: run.tasks.map((task) => {
        if (!selected.has(task.id) || ["complete", "failed", "canceled", "interrupted"].includes(task.status))
          return task
        return {
          ...task,
          cancelRequested: true,
          status: executing?.has(task.id) ? task.status : "canceled",
          completedAt: executing?.has(task.id) ? task.completedAt : now(),
          lastAction: executing?.has(task.id)
            ? "Stop requested; retaining partial work"
            : task.id === taskID
              ? "Stopped by user"
              : "Stopped because a dependency was stopped",
        }
      }),
    }))
    const cleanup = Promise.all([
      ...current.tasks
        .filter((task) => selected.has(task.id) && task.workspaceId && task.status !== "merging")
        .map((task) => stopParallelWorkspace(task.workspaceId!)),
      ...[...selected].flatMap((id) => executing?.get(id) ?? []),
    ])
    // Provisioning can finish after Stop. Its worker checks the durable cancellation before any model admission.
    if (!(await waitForCleanup(cleanup, timeoutMs)))
      updateRun(id, (run) => ({
        ...run,
        tasks: run.tasks.map((task) =>
          selected.has(task.id) && IN_FLIGHT.includes(task.status)
            ? { ...task, lastAction: "Stop requested; workspace cleanup is still finishing" }
            : task,
        ),
      }))
    return getSwarmRun(id)!
  })
}

export async function mergeSwarmRun(id: string, force = false) {
  const run = getSwarmRun(id)
  if (!run?.coordinatorWorkspaceId) throw new Error("This swarm has no aggregate workspace to merge.")
  const merged = await mergeParallelWorkspace(run.coordinatorWorkspaceId, force)
  if (merged.status !== "merged") {
    return updateRun(id, (current) => ({
      ...current,
      status: "needs review",
      currentStep: "Aggregate merge blocked",
      error: merged.error || "The aggregate diff conflicts with the main project.",
      logs: [...current.logs, `${now()}  Aggregate merge blocked: ${merged.error || "unknown conflict"}`].slice(-240),
    }))
  }
  return updateRun(id, (current) => ({
    ...current,
    status: "merged",
    currentStep: "Swarm changes merged into main",
    completedAt: now(),
    summary: `Merged the swarm's ${current.changedFiles.length} changed file${current.changedFiles.length === 1 ? "" : "s"} into the main project.`,
    logs: [...current.logs, `${now()}  Aggregate diff merged into the main project.`].slice(-240),
  }))
}

export async function mergeSwarmRunSelection(id: string, selection: UnifiedDiffSelection, force = false) {
  const run = getSwarmRun(id)
  if (!run?.coordinatorWorkspaceId) throw new Error("This swarm has no aggregate workspace to merge.")
  const merged = await mergeParallelWorkspaceSelection(run.coordinatorWorkspaceId, selection, force)
  const refreshed = merged.mergeState === "none" ? await refreshParallelWorkspace(merged.id) : merged
  return updateRun(id, (current) => ({
    ...current,
    status: refreshed.status === "merged" ? "merged" : "needs review",
    currentStep:
      refreshed.status === "merged" ? "All approved changes merged" : "Approved changes merged; review remains",
    completedAt: refreshed.status === "merged" ? now() : current.completedAt,
    changedFiles: refreshed.changedFiles,
    diff: refreshed.diff,
    riskLevel: refreshed.riskLevel,
    error: refreshed.error,
    logs: [...current.logs, `${now()}  Selective aggregate review applied.`].slice(-240),
  }))
}

export function discardSwarmRun(id: string) {
  return inTurn(id, async () => {
    if (!getSwarmRun(id)) throw new Error("Swarm run was not found.")
    const stopping = stoppingRuns.get(id)
    if (stopping && !(await waitForCleanup(stopping)))
      throw new Error("The stopped swarm is still cleaning up. Wait for its workspaces to settle before discarding.")
    const active = activeRuns.get(id)
    active?.controller.abort()
    if (active && !(await waitForCleanup(active.completion)))
      throw new Error("The stopped swarm is still cleaning up. Wait for its workspaces to settle before discarding.")
    const run = getSwarmRun(id)!
    const workspaceIDs = [run.coordinatorWorkspaceId, ...run.tasks.map((task) => task.workspaceId)].filter(
      (workspaceID): workspaceID is string => Boolean(workspaceID),
    )
    await Promise.all(
      workspaceIDs.map(async (workspaceID) => {
        const workspace = getParallelWorkspace(workspaceID)
        if (!workspace || workspace.mergeState !== "none") return
        await stopParallelWorkspace(workspaceID).catch(() => undefined)
        await discardParallelWorkspace(workspaceID).catch(() => undefined)
      }),
    )
    return updateRun(id, (current) => ({
      ...current,
      status: "discarded",
      currentStep: "Swarm and isolated workspaces discarded",
      completedAt: now(),
      logs: [...current.logs, `${now()}  All remaining isolated swarm workspaces were discarded.`].slice(-240),
    }))
  })
}

async function waitForCleanup(completion: Promise<unknown>, timeoutMs = 10_000) {
  const expired = Promise.withResolvers<boolean>()
  const timer = setTimeout(() => expired.resolve(false), timeoutMs)
  return Promise.race([completion.then(() => true), expired.promise]).finally(() => clearTimeout(timer))
}

function startSwarmRun(id: string, engine: ParallelWorkspaceEngine) {
  if (activeRuns.has(id) || stoppingRuns.has(id)) return
  const controller = new AbortController()
  const completion = Promise.resolve()
    .then(() => executeSwarmRun(id, engine, controller))
    .finally(() => {
      activeRuns.delete(id)
      taskExecutions.delete(id)
    })
  activeRuns.set(id, { controller, completion })
}

async function executeSwarmRun(id: string, engine: ParallelWorkspaceEngine, controller: AbortController) {
  try {
    controller.signal.throwIfAborted()
    let run = getSwarmRun(id)
    if (!run) throw new Error("Swarm run was not found.")
    let coordinator = run.coordinatorWorkspaceId ? getParallelWorkspace(run.coordinatorWorkspaceId) : undefined
    if (!coordinator) {
      coordinator = await createParallelWorkspace({
        sourcePath: run.sourcePath,
        parentSessionId: `swarm:${run.id}`,
        engineParentSessionId: run.parentSessionId,
        name: `${run.name} · staging`,
        taskPrompt: `Aggregate validated work for this objective without touching main: ${run.objective}`,
        provider: run.plannerProvider,
        model: run.plannerModel,
        agent: "general",
        swarmRunId: run.id,
        swarmRole: "coordinator",
      })
      run = updateRun(id, (current) => ({
        ...current,
        coordinatorWorkspaceId: coordinator!.id,
        currentStep: "Inspecting the project and building a dependency graph",
        logs: [...current.logs, `${now()}  Created isolated staging workspace ${coordinator!.id}.`].slice(-240),
      }))
    }
    controller.signal.throwIfAborted()

    if (!run.tasks.length) {
      const generated = await generateSwarmPlan(run, coordinator, engine, controller.signal).catch((error) => {
        controller.signal.throwIfAborted()
        appendLog(
          id,
          `The planner produced no usable plan; using the safe fallback graph. ${error instanceof Error ? error.message : String(error)}`,
        )
        return fallbackSwarmPlan(run!.objective, run!.maxAgents)
      })
      controller.signal.throwIfAborted()
      const routed = routeSwarmModels(generated.tasks, run.modelPool, run.strategy)
      run = updateRun(id, (current) => ({
        ...current,
        status: "running",
        currentStep: `Scheduling ${routed.length} dependency-aware agent tasks`,
        planSummary: generated.summary,
        tasks: routed.map(
          (task): SwarmTaskRecord => ({
            ...task,
            status: "planned",
            lastAction: task.dependsOn.length ? `Waiting for ${task.dependsOn.join(", ")}` : "Ready for an agent slot",
            changedFilesCount: 0,
            riskLevel: "low",
            summary: "",
          }),
        ),
        logs: [...current.logs, `${now()}  Planner produced ${routed.length} validated tasks.`].slice(-240),
      }))
    }

    await scheduleSwarmTasks(id, engine, controller.signal)
    if (controller.signal.aborted) return
    run = getSwarmRun(id)!
    coordinator = getParallelWorkspace(run.coordinatorWorkspaceId!)
    if (!coordinator) throw new Error("The swarm staging workspace disappeared before review.")
    const aggregate = await refreshParallelWorkspace(coordinator.id)
    controller.signal.throwIfAborted()
    const failures = run.tasks.filter((task) => task.status === "failed" || task.status === "blocked")
    const canceled = run.tasks.filter((task) => task.status === "canceled")
    const status: SwarmRunStatus = aggregate.changedFilesCount
      ? "needs review"
      : failures.length
        ? "failed"
        : canceled.length
          ? "canceled"
          : "complete"
    // Like the failure path below, a run the user discarded or merged meanwhile keeps that outcome.
    if (["discarded", "merged"].includes(getSwarmRun(id)?.status ?? "")) return
    updateRun(id, (current) => ({
      ...current,
      status,
      currentStep: aggregate.changedFilesCount
        ? `Aggregate diff ready: ${aggregate.changedFilesCount} changed file${aggregate.changedFilesCount === 1 ? "" : "s"}`
        : failures.length
          ? `${failures.length} swarm task${failures.length === 1 ? "" : "s"} failed`
          : canceled.length
            ? `${canceled.length} swarm task${canceled.length === 1 ? "" : "s"} stopped; partial work retained`
            : "Swarm completed with no file changes",
      completedAt: now(),
      changedFiles: aggregate.changedFiles,
      diff: aggregate.diff,
      riskLevel: aggregate.riskLevel,
      summary: [
        swarmSummary(current.tasks, aggregate.changedFilesCount, failures.length),
        ...(canceled.length ? [`${canceled.length} task(s) stopped; unfinished work remains.`] : []),
      ].join("\n"),
      error: failures.length
        ? failures.map((task) => `${task.title}: ${task.error || task.lastAction}`).join("\n")
        : undefined,
      logs: [
        ...current.logs,
        `${now()}  Swarm execution finished with ${aggregate.changedFilesCount} aggregate changed files.`,
      ].slice(-240),
    }))
  } catch (error) {
    const current = getSwarmRun(id)
    if (!current || current.status === "discarded" || current.status === "merged") return
    const canceled = controller.signal.aborted
    const detail = canceled
      ? "The swarm was stopped by the user."
      : error instanceof Error
        ? error.message
        : String(error)
    updateRun(id, (run) => ({
      ...run,
      status: canceled ? "canceled" : "failed",
      currentStep: canceled ? "Swarm stopped" : "Swarm orchestration failed",
      completedAt: now(),
      error: canceled ? undefined : detail,
      summary: detail,
      tasks: run.tasks.map((task) =>
        canceled && ["planned", "creating", "queued", "running", "merging"].includes(task.status)
          ? { ...task, status: "canceled", completedAt: now(), lastAction: "Canceled by user" }
          : task,
      ),
      logs: [...run.logs, `${now()}  ${detail}`].slice(-240),
    }))
  }
}

async function scheduleSwarmTasks(id: string, engine: ParallelWorkspaceEngine, signal: AbortSignal) {
  const executing = new Map<string, Promise<void>>()
  taskExecutions.set(id, executing)
  while (!signal.aborted) {
    let run = getSwarmRun(id)
    if (!run) throw new Error("Swarm run was not found.")
    const failed = new Set(
      run.tasks.filter((task) => ["failed", "blocked", "canceled"].includes(task.status)).map((task) => task.id),
    )
    const blocked = run.tasks.filter(
      (task) => task.status === "planned" && task.dependsOn.some((dependency) => failed.has(dependency)),
    )
    if (blocked.length) {
      const blockedIDs = new Set(blocked.map((task) => task.id))
      run = updateRun(id, (current) => ({
        ...current,
        tasks: current.tasks.map((task) =>
          blockedIDs.has(task.id)
            ? {
                ...task,
                status: "blocked",
                lastAction: "Blocked by a failed dependency",
                error: "A required dependency did not complete.",
              }
            : task,
        ),
      }))
    }

    const completed = new Set(run.tasks.filter((task) => task.status === "complete").map((task) => task.id))
    const ready = run.tasks.filter(
      (task) => task.status === "planned" && task.dependsOn.every((dependency) => completed.has(dependency)),
    )
    const slots = Math.max(0, run.maxConcurrency - executing.size)
    ready.slice(0, slots).forEach((task) => {
      const execution = executeSwarmTask(id, task.id, engine, signal)
        .catch((error) => {
          const detail = error instanceof Error ? error.message : String(error)
          updateTask(id, task.id, (current) => ({
            ...current,
            status: signal.aborted || current.cancelRequested ? "canceled" : "failed",
            completedAt: now(),
            lastAction:
              signal.aborted || current.cancelRequested ? "Stopped; partial work retained" : "Agent task failed",
            error: signal.aborted || current.cancelRequested ? undefined : detail,
            summary: detail,
          }))
          appendLog(
            id,
            `${task.title} ${signal.aborted || getSwarmRun(id)?.tasks.find((item) => item.id === task.id)?.cancelRequested ? "stopped" : "failed"}: ${detail}`,
          )
        })
        .finally(() => executing.delete(task.id))
      executing.set(task.id, execution)
    })

    run = getSwarmRun(id)!
    const unresolved = run.tasks.filter((task) => !["complete", "failed", "blocked", "canceled"].includes(task.status))
    if (!unresolved.length && !executing.size) return
    if (!executing.size && !ready.length) {
      updateRun(id, (current) => ({
        ...current,
        tasks: current.tasks.map((task) =>
          ["planned", "interrupted"].includes(task.status)
            ? {
                ...task,
                status: "blocked",
                lastAction: "No valid dependency path remained",
                error: "Dependency scheduler could not make progress.",
              }
            : task,
        ),
      }))
      return
    }
    if (executing.size) await Promise.race(executing.values())
  }
  // Stop/discard waits for every worker to release its workspace, including
  // workers still provisioning when cancellation arrived.
  await Promise.all(executing.values())
}

async function executeSwarmTask(id: string, taskID: string, engine: ParallelWorkspaceEngine, signal: AbortSignal) {
  const run = getSwarmRun(id)
  const task = run?.tasks.find((item) => item.id === taskID)
  const coordinator = run?.coordinatorWorkspaceId ? getParallelWorkspace(run.coordinatorWorkspaceId) : undefined
  if (!run || !task || !coordinator) throw new Error("Swarm task lost its coordinator state.")
  if (signal.aborted) throw new DOMException("Swarm stopped.", "AbortError")

  // A planned task that still names a workspace is one Resume kept (see resumeSwarmRun): its agent finished and passed
  // its checks, and Resume undid any merge Vector stopped part-way through, so only a fresh merge into staging is left.
  const kept = task.workspaceId ? getParallelWorkspace(task.workspaceId) : undefined
  const settled = kept ?? (await runSwarmWorker(run, task, coordinator, engine, signal))
  if (signal.aborted || getSwarmRun(id)?.tasks.find((task) => task.id === taskID)?.cancelRequested)
    throw new DOMException("Swarm task stopped.", "AbortError")

  const summary = settled.finalSummary || settled.lastAction
  if (settled.changedFilesCount) {
    updateTask(id, taskID, (current) => ({
      ...current,
      status: "merging",
      lastAction: "Integrating validated changes into swarm staging",
    }))
    const merged = await mergeParallelWorkspace(settled.id)
    if (merged.status !== "merged")
      throw new Error(merged.error || "Worker changes conflicted with the swarm staging workspace.")
  } else if (settled.mergeState === "none") {
    await discardParallelWorkspace(settled.id).catch(() => undefined)
  }
  // No Stop checkpoint here: the worker's changes are already in staging, so a Stop that arrived during the merge
  // must still record the task complete. Recorded as canceled, Resume would run it again on a baseline that already
  // holds its edits.

  updateTask(id, taskID, (current) => ({
    ...current,
    status: "complete",
    completedAt: now(),
    lastAction: settled.changedFilesCount
      ? "Validated changes integrated into staging"
      : "Completed with no file changes",
    changedFilesCount: settled.changedFilesCount,
    riskLevel: settled.riskLevel,
    summary,
    error: undefined,
  }))
  appendLog(
    id,
    `${task.title} completed${settled.changedFilesCount ? ` with ${settled.changedFilesCount} changed files` : " without file changes"}.`,
  )
}

// Runs the task's agent in a new worker workspace made from staging, and returns the workspace once the agent finished
// and its checks passed.
async function runSwarmWorker(
  run: SwarmRunRecord,
  task: SwarmTaskRecord,
  coordinator: ParallelWorkspaceRecord,
  engine: ParallelWorkspaceEngine,
  signal: AbortSignal,
) {
  updateTask(run.id, task.id, (current) => ({
    ...current,
    status: "creating",
    startedAt: now(),
    lastAction: "Creating an isolated worker workspace",
  }))
  const dependencyResults = run.tasks
    .filter((candidate) => task.dependsOn.includes(candidate.id))
    .map((candidate) => `- ${candidate.title}: ${candidate.summary || candidate.lastAction}`)
    .join("\n")
  const workspace = await createParallelWorkspace({
    sourcePath: coordinator.isolatedPath,
    parentSessionId: `swarm:${run.id}`,
    engineParentSessionId: run.parentSessionId,
    name: `${run.name} · ${task.title}`,
    taskPrompt: [
      task.prompt,
      task.fileHints.length
        ? `Prioritize these files when relevant:\n${task.fileHints.map((file) => `- ${file}`).join("\n")}`
        : "",
      dependencyResults ? `Validated dependency results:\n${dependencyResults}` : "",
      "Work only on this assigned task. Do not undo or broaden changes already present in the staging baseline.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    provider: task.provider,
    model: task.model,
    agent: agentForRole(task.role),
    swarmRunId: run.id,
    swarmTaskId: task.id,
    swarmRole: "worker",
  })
  updateTask(run.id, task.id, (current) => ({
    ...current,
    workspaceId: workspace.id,
    status: "queued",
    lastAction: "Queued on the isolated agent pool",
  }))
  if (signal.aborted || getSwarmRun(run.id)?.tasks.find((item) => item.id === task.id)?.cancelRequested) {
    await stopParallelWorkspace(workspace.id)
    throw new DOMException("Swarm task stopped before starting its worker.", "AbortError")
  }
  signal.throwIfAborted()
  appendLog(run.id, `${task.title} assigned to ${task.provider}/${task.model}.`)
  // No concurrency argument: the run pool is shared by every agent on the
  // machine, so passing this swarm's maxConcurrency would shrink it for launches
  // outside the swarm. The scheduler's `slots` check already bounds this swarm.
  await runParallelWorkspace(workspace.id, engine)
  const settled = await waitForWorkspace(workspace.id, run.id, task.id, signal).finally(async () => {
    if (signal.aborted) await stopParallelWorkspace(workspace.id).catch(() => undefined)
  })
  signal.throwIfAborted()
  if (settled.status === "failed" || settled.status === "stopped" || settled.status === "discarded") {
    throw new Error(settled.error || settled.finalSummary || `${task.title} did not complete.`)
  }
  if (settled.validationPassed === false) {
    throw new Error(settled.error || "Deterministic validation still failed after the bounded repair pass.")
  }
  return settled
}

async function waitForWorkspace(workspaceID: string, runID: string, taskID: string, signal: AbortSignal) {
  let previous = ""
  while (!signal.aborted) {
    if (getSwarmRun(runID)?.tasks.find((task) => task.id === taskID)?.cancelRequested) {
      await stopParallelWorkspace(workspaceID)
      throw new DOMException("Swarm task stopped.", "AbortError")
    }
    const workspace = getParallelWorkspace(workspaceID)
    if (!workspace) throw new Error("The isolated worker workspace disappeared.")
    if (workspace.status !== previous) {
      previous = workspace.status
      updateTask(runID, taskID, (task) => ({
        ...task,
        status: ["queued", "planning"].includes(workspace.status)
          ? "queued"
          : ["editing", "running commands", "testing"].includes(workspace.status)
            ? "running"
            : task.status,
        lastAction: workspace.lastAction,
        changedFilesCount: workspace.changedFilesCount,
        riskLevel: workspace.riskLevel,
      }))
    }
    if (["complete", "failed", "needs review", "stopped", "merged", "discarded"].includes(workspace.status))
      return workspace
    await sleep(700, signal)
  }
  throw new DOMException("Swarm stopped.", "AbortError")
}

async function generateSwarmPlan(
  run: SwarmRunRecord,
  coordinator: NonNullable<ReturnType<typeof getParallelWorkspace>>,
  engine: ParallelWorkspaceEngine,
  signal: AbortSignal,
) {
  // The planner is a helper session: out of every session list, and its spend counts towards the task the swarm was
  // started from.
  const created = await engineRequest<{ data?: { id?: string } }>(engine, "/api/session", {
    method: "POST",
    body: {
      location: { directory: coordinator.isolatedPath },
      model: { providerID: run.plannerProvider, id: run.plannerModel },
      agent: "explore",
      title: `Swarm planner · ${run.objective.slice(0, 60)}`,
      internal: "swarm.planner",
      ...(run.parentSessionId?.startsWith("ses") ? { parentID: run.parentSessionId } : {}),
    },
    signal,
  })
  const sessionID = created?.data?.id
  if (!sessionID) throw new Error("Vector's planner did not return a session ID.")
  updateRun(run.id, (current) => ({ ...current, plannerSessionId: sessionID }))
  // Aborting the HTTP requests does not interrupt the model work the planner admitted, so planning that ends without a
  // plan (Stop, the idle timeout, a failed request) interrupts the session too. Stop waits a bounded time for it.
  return readPlannerPlan(run, sessionID, engine, signal).catch(async (error) => {
    await interruptEngineSession(engine, sessionID, (message) => appendLog(run.id, `Planner: ${message}`))
    throw error
  })
}

async function readPlannerPlan(
  run: SwarmRunRecord,
  sessionID: string,
  engine: ParallelWorkspaceEngine,
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  await engineRequest(engine, `/api/session/${encodeURIComponent(sessionID)}/prompt`, {
    method: "POST",
    body: { prompt: { text: plannerPrompt(run) }, resume: true },
    signal,
  })
  await waitForPlannerIdle(run.id, sessionID, engine, signal)
  const context = await engineRequest<{ data?: readonly (typeof SessionMessage.Message.Encoded)[] }>(
    engine,
    `/api/session/${encodeURIComponent(sessionID)}/context`,
    { signal },
  )
  // Only the planner's own answers can hold its plan. Tool results carry text parts too, so a JSON file the planner
  // read, such as a tasks.json, would otherwise be accepted as the task graph.
  const answers = (context?.data ?? []).flatMap((message) =>
    message.type === "assistant"
      ? message.content.flatMap((part) => (part.type === "text" && part.text.trim() ? [part.text.trim()] : []))
      : [],
  )
  return findSwarmPlan(answers.reverse(), run.objective, run.maxAgents)
}

function plannerPrompt(run: SwarmRunRecord) {
  return [
    "You are Vector's read-only swarm coordinator. Inspect the current project and decompose the objective into a dependency graph of independently executable engineering tasks.",
    "Do not edit files. Return exactly one JSON object and no prose.",
    `Create between 2 and ${run.maxAgents} tasks. Use parallel tasks only when their likely file ownership does not overlap. Make dependencies explicit so dependent agents inherit validated staging changes.`,
    "Allowed roles: explore, implement, debug, test, review, security, docs.",
    "Allowed modelTier values: fast, balanced, strong.",
    "Every task must be concrete, bounded, and independently verifiable. Include fileHints when repository inspection identifies likely paths.",
    "Use this schema:",
    '{"summary":"short plan summary","tasks":[{"id":"stable-kebab-id","title":"short title","prompt":"complete task instructions","role":"implement","dependsOn":[],"fileHints":["src/path.ts"],"modelTier":"balanced"}]}',
    "",
    `Objective: ${run.objective}`,
  ].join("\n")
}

async function waitForPlannerIdle(id: string, sessionID: string, engine: ParallelWorkspaceEngine, signal: AbortSignal) {
  const startedAt = Date.now()
  const timeoutAt = startedAt + 10 * 60_000
  let observedBusy = false
  let idleSamples = 0
  while (Date.now() < timeoutAt) {
    const raw = await engineRequest<unknown>(engine, "/api/session/active", { signal })
    const active = activeSessionMap(raw)[sessionID]
    if (active) {
      observedBusy = true
      idleSamples = 0
      updateRun(id, (run) => ({ ...run, currentStep: "Planner is reading the repository and decomposing work" }))
    } else {
      idleSamples += 1
      if ((observedBusy && idleSamples >= 1) || (Date.now() - startedAt >= 20_000 && idleSamples >= 6)) return
    }
    await sleep(650, signal)
  }
  throw new Error("The swarm planner did not become idle within 10 minutes.")
}

function engineHeaders(engine: ParallelWorkspaceEngine) {
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" }
  if (engine.username && engine.password) {
    headers.authorization = `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}`
  }
  return headers
}

async function engineRequest<T>(
  engine: ParallelWorkspaceEngine,
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
) {
  const base = engine.url.endsWith("/") ? engine.url : `${engine.url}/`
  const response = await fetch(new URL(path.replace(/^\//, ""), base), {
    method: init.method ?? "GET",
    headers: engineHeaders(engine),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Vector engine request failed (${response.status})${body ? `: ${body.slice(0, 500)}` : ""}`)
  }
  if (response.status === 204) return undefined as T
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

function activeSessionMap(value: unknown) {
  if (!value || typeof value !== "object") return {} as Record<string, unknown>
  const record = value as Record<string, unknown>
  const candidate = record.data && typeof record.data === "object" ? record.data : record
  return candidate as Record<string, unknown>
}

function sleep(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(new DOMException("Swarm stopped.", "AbortError"))
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, milliseconds)
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      reject(new DOMException("Swarm stopped.", "AbortError"))
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}

function agentForRole(role: SwarmAgentRole) {
  if (role === "explore") return "explore"
  if (role === "debug") return "debug"
  if (role === "test") return "test"
  if (role === "review") return "review"
  if (role === "security") return "security"
  return "general"
}

function swarmSummary(tasks: SwarmTaskRecord[], changedFiles: number, failures: number) {
  const completed = tasks.filter((task) => task.status === "complete").length
  return [
    `${completed} of ${tasks.length} coordinated tasks completed.`,
    `${changedFiles} aggregate changed file${changedFiles === 1 ? "" : "s"} are isolated in staging.`,
    failures
      ? `${failures} task${failures === 1 ? "" : "s"} require attention before merge.`
      : "All completed task results passed their available deterministic checks.",
  ].join(" ")
}
