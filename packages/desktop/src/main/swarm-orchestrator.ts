import { randomUUID } from "node:crypto"
import { stat } from "node:fs/promises"

import { getStore } from "./store"
import {
  createParallelWorkspace,
  discardParallelWorkspace,
  getParallelWorkspace,
  mergeParallelWorkspace,
  mergeParallelWorkspaceSelection,
  refreshParallelWorkspace,
  runParallelWorkspace,
  stopParallelWorkspace,
  type ParallelWorkspaceEngine,
} from "./parallel-workspaces"
import {
  fallbackSwarmPlan,
  parseSwarmPlan,
  routeSwarmModels,
  selectSwarmPlannerModel,
  type SwarmAgentRole,
  type SwarmModelCandidate,
  type SwarmStrategy,
} from "./swarm-plan"
import type { UnifiedDiffSelection } from "./unified-diff"

const STORE_NAME = "swarm-orchestrator-state"
const STORE_KEY = "runs"
const activeRuns = new Map<string, AbortController>()

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

function readRuns(): SwarmRunRecord[] {
  const raw = getStore(STORE_NAME).get(STORE_KEY)
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is SwarmRunRecord => typeof item?.id === "string")
}

function writeRuns(runs: SwarmRunRecord[]) {
  getStore(STORE_NAME).set(STORE_KEY, runs)
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
    if (!["planning", "running"].includes(run.status) || activeRuns.has(run.id)) return run
    changed = true
    return {
      ...run,
      status: "interrupted" as const,
      currentStep: "Interrupted when Vector closed",
      updatedAt: now(),
      tasks: run.tasks.map((task) =>
        ["creating", "queued", "running", "merging"].includes(task.status)
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

  const primary = { provider: input.primaryProvider.trim(), model: input.primaryModel.trim() }
  const modelPool = [
    ...new Map(
      [primary, ...(input.modelPool ?? [])]
        .filter((candidate) => candidate.provider.trim() && candidate.model.trim())
        .map((candidate) => [`${candidate.provider}/${candidate.model}`, candidate]),
    ).values(),
  ]
  const strategy = input.strategy ?? "balanced"
  const planner = selectSwarmPlannerModel(modelPool, strategy)
  const maxAgents = Math.max(2, Math.min(16, Math.floor(input.maxAgents ?? 8)))
  const maxConcurrency = Math.max(1, Math.min(16, maxAgents, Math.floor(input.maxConcurrency ?? 4)))
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

export async function resumeSwarmRun(id: string, engine: ParallelWorkspaceEngine) {
  const current = getSwarmRun(id)
  if (!current) throw new Error("Swarm run was not found.")
  if (["merged", "discarded", "needs review", "complete"].includes(current.status)) return current
  if (current.coordinatorWorkspaceId) {
    const coordinator = getParallelWorkspace(current.coordinatorWorkspaceId)
    const exists = coordinator && (await stat(coordinator.isolatedPath).catch(() => undefined))
    if (!exists)
      throw new Error("The swarm staging workspace no longer exists. Discard this run and launch a new swarm.")
  }
  updateRun(id, (run) => ({
    ...run,
    status: run.tasks.length ? "running" : "planning",
    currentStep: run.tasks.length ? "Resuming dependency scheduler" : "Resuming project decomposition",
    error: undefined,
    tasks: run.tasks.map((task) =>
      ["failed", "blocked", "canceled", "interrupted"].includes(task.status)
        ? {
            ...task,
            status: "planned",
            workspaceId: undefined,
            startedAt: undefined,
            completedAt: undefined,
            lastAction: "Ready to retry",
            error: undefined,
          }
        : task,
    ),
  }))
  appendLog(id, "Swarm resumed by the user.")
  startSwarmRun(id, engine)
  return getSwarmRun(id)!
}

export async function stopSwarmRun(id: string) {
  const current = getSwarmRun(id)
  if (!current) throw new Error("Swarm run was not found.")
  activeRuns.get(id)?.abort()
  await Promise.all(
    current.tasks
      .filter((task) => task.workspaceId && ["creating", "queued", "running", "merging"].includes(task.status))
      .map((task) => stopParallelWorkspace(task.workspaceId!).catch(() => undefined)),
  )
  return updateRun(id, (run) => ({
    ...run,
    status: "canceled",
    currentStep: "Swarm stopped",
    completedAt: now(),
    tasks: run.tasks.map((task) =>
      ["planned", "creating", "queued", "running", "merging"].includes(task.status)
        ? { ...task, status: "canceled", lastAction: "Canceled by user" }
        : task,
    ),
    logs: [...run.logs, `${now()}  Swarm stopped by the user.`].slice(-240),
  }))
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

export async function discardSwarmRun(id: string) {
  const run = getSwarmRun(id)
  if (!run) throw new Error("Swarm run was not found.")
  activeRuns.get(id)?.abort()
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
}

function startSwarmRun(id: string, engine: ParallelWorkspaceEngine) {
  if (activeRuns.has(id)) return
  const controller = new AbortController()
  activeRuns.set(id, controller)
  void executeSwarmRun(id, engine, controller).finally(() => activeRuns.delete(id))
}

async function executeSwarmRun(id: string, engine: ParallelWorkspaceEngine, controller: AbortController) {
  try {
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

    if (!run.tasks.length) {
      const generated = await generateSwarmPlan(run, coordinator, engine, controller.signal).catch((error) => {
        appendLog(
          id,
          `Planner output could not be validated; using the safe fallback graph. ${error instanceof Error ? error.message : String(error)}`,
        )
        return fallbackSwarmPlan(run!.objective, run!.maxAgents)
      })
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
    const failures = run.tasks.filter((task) => task.status === "failed" || task.status === "blocked")
    const status: SwarmRunStatus = aggregate.changedFilesCount
      ? "needs review"
      : failures.length
        ? "failed"
        : "complete"
    updateRun(id, (current) => ({
      ...current,
      status,
      currentStep: aggregate.changedFilesCount
        ? `Aggregate diff ready: ${aggregate.changedFilesCount} changed file${aggregate.changedFilesCount === 1 ? "" : "s"}`
        : failures.length
          ? `${failures.length} swarm task${failures.length === 1 ? "" : "s"} failed`
          : "Swarm completed with no file changes",
      completedAt: now(),
      changedFiles: aggregate.changedFiles,
      diff: aggregate.diff,
      riskLevel: aggregate.riskLevel,
      summary: swarmSummary(current.tasks, aggregate.changedFilesCount, failures.length),
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
          ? { ...task, status: "canceled", lastAction: "Canceled by user" }
          : task,
      ),
      logs: [...run.logs, `${now()}  ${detail}`].slice(-240),
    }))
  }
}

async function scheduleSwarmTasks(id: string, engine: ParallelWorkspaceEngine, signal: AbortSignal) {
  const executing = new Map<string, Promise<void>>()
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
            status: signal.aborted ? "canceled" : "failed",
            completedAt: now(),
            lastAction: signal.aborted ? "Canceled by user" : "Agent task failed",
            error: signal.aborted ? undefined : detail,
            summary: detail,
          }))
          appendLog(id, `${task.title} failed: ${detail}`)
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
}

async function executeSwarmTask(id: string, taskID: string, engine: ParallelWorkspaceEngine, signal: AbortSignal) {
  const run = getSwarmRun(id)
  const task = run?.tasks.find((item) => item.id === taskID)
  const coordinator = run?.coordinatorWorkspaceId ? getParallelWorkspace(run.coordinatorWorkspaceId) : undefined
  if (!run || !task || !coordinator) throw new Error("Swarm task lost its coordinator state.")
  if (signal.aborted) throw new DOMException("Swarm stopped.", "AbortError")

  updateTask(id, taskID, (current) => ({
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
  updateTask(id, taskID, (current) => ({
    ...current,
    workspaceId: workspace.id,
    status: "queued",
    lastAction: "Queued on the isolated agent pool",
  }))
  appendLog(id, `${task.title} assigned to ${task.provider}/${task.model}.`)
  await runParallelWorkspace(workspace.id, engine, run.maxConcurrency)
  const settled = await waitForWorkspace(workspace.id, id, taskID, signal)
  if (settled.status === "failed" || settled.status === "stopped") {
    throw new Error(settled.error || settled.finalSummary || `${task.title} did not complete.`)
  }
  if (settled.validationPassed === false) {
    throw new Error(settled.error || "Deterministic validation still failed after the bounded repair pass.")
  }

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

async function waitForWorkspace(workspaceID: string, runID: string, taskID: string, signal: AbortSignal) {
  let previous = ""
  while (!signal.aborted) {
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
  await stopParallelWorkspace(workspaceID).catch(() => undefined)
  throw new DOMException("Swarm stopped.", "AbortError")
}

async function generateSwarmPlan(
  run: SwarmRunRecord,
  coordinator: NonNullable<ReturnType<typeof getParallelWorkspace>>,
  engine: ParallelWorkspaceEngine,
  signal: AbortSignal,
) {
  const created = await engineRequest<{ data?: { id?: string } }>(engine, "/api/session", {
    method: "POST",
    body: {
      location: { directory: coordinator.isolatedPath },
      model: { providerID: run.plannerProvider, id: run.plannerModel },
      agent: "explore",
    },
    signal,
  })
  const sessionID = created?.data?.id
  if (!sessionID) throw new Error("Vector's planner did not return a session ID.")
  updateRun(run.id, (current) => ({ ...current, plannerSessionId: sessionID }))
  await engineRequest(engine, `/api/session/${encodeURIComponent(sessionID)}/prompt`, {
    method: "POST",
    body: { prompt: { text: plannerPrompt(run) }, resume: true },
    signal,
  })
  await waitForPlannerIdle(run.id, sessionID, engine, signal)
  const context = await engineRequest<{ data?: unknown }>(
    engine,
    `/api/session/${encodeURIComponent(sessionID)}/context`,
    { signal },
  )
  const messages = collectText(context?.data).reverse()
  const parsed = messages
    .map((message) => {
      try {
        return parseSwarmPlan(message, run.objective, run.maxAgents)
      } catch {
        return undefined
      }
    })
    .find((plan) => plan)
  if (!parsed) throw new Error("Vector could not validate the planner's dependency graph.")
  return parsed
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

function collectText(value: unknown, output: string[] = []) {
  if (!value || typeof value === "string" || typeof value !== "object") return output
  if (Array.isArray(value)) {
    value.forEach((item) => collectText(item, output))
    return output
  }
  const record = value as Record<string, unknown>
  if (record.type === "text" && typeof record.text === "string" && record.text.trim()) output.push(record.text.trim())
  Object.values(record).forEach((item) => collectText(item, output))
  return output
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
