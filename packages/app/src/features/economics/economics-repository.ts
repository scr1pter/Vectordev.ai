// Persists verified ModelOutcome history per project, using Vector's standard
// desktop/web persistence pattern: electron-store IPC when running in the
// desktop shell, falling back to localStorage in the web build. Keys are
// namespaced per project via an FNV-1a hash (the same `checksum` helper
// persist.ts uses) so unrelated projects never collide or leak into each
// other's history.
import { checksum } from "@vectordevai/core/util/encode"
import { createEffect, createSignal } from "solid-js"
import type { ModelOutcome, TaskCategory } from "./economics-types"
import type { MeasuredUsage } from "./token-usage"

const STORAGE_NAME = "vector.model-economics.v1.dat"
const MAX_OUTCOMES_PER_PROJECT = 500

type StoreApi = {
  storeGet?: (name: string, key: string) => Promise<string | null>
  storeSet?: (name: string, key: string, value: string) => Promise<void>
  storeDelete?: (name: string, key: string) => Promise<void>
}

function storeApi(): StoreApi | undefined {
  return globalThis.window?.api as StoreApi | undefined
}

function projectKey(projectId: string) {
  return `outcomes:${checksum(projectId) ?? "0"}`
}

function localStorageKey(projectId: string) {
  return `${STORAGE_NAME}:${projectKey(projectId)}`
}

function parseOutcomes(raw: string | null): ModelOutcome[] {
  if (!raw) return []
  const parsed = (() => {
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return undefined
    }
  })()
  return Array.isArray(parsed) ? (parsed as ModelOutcome[]) : []
}

async function readOutcomes(projectId: string): Promise<ModelOutcome[]> {
  const api = storeApi()
  if (api?.storeGet) {
    const raw = await api.storeGet(STORAGE_NAME, projectKey(projectId)).catch(() => null)
    return parseOutcomes(raw)
  }
  return parseOutcomes(globalThis.localStorage?.getItem(localStorageKey(projectId)) ?? null)
}

async function writeOutcomes(projectId: string, outcomes: ModelOutcome[]): Promise<void> {
  const capped = outcomes.slice(-MAX_OUTCOMES_PER_PROJECT)
  const value = JSON.stringify(capped)

  const api = storeApi()
  if (api?.storeSet) {
    await api.storeSet(STORAGE_NAME, projectKey(projectId), value).catch(() => undefined)
    return
  }
  globalThis.localStorage?.setItem(localStorageKey(projectId), value)
}

// Recording reads, appends to and writes back a project's whole list, so records for one project run one at a time;
// two at once would each write a list without the other's outcome.
const queues = new Map<string, Promise<void>>()
// Bumped after each new outcome is written, so views showing a project's history read it again.
const [version, setVersion] = createSignal(0)

export function recordOutcome(outcome: ModelOutcome): Promise<void> {
  const key = projectKey(outcome.projectId)
  const next = (queues.get(key) ?? Promise.resolve()).then(() => appendOutcome(outcome))
  queues.set(
    key,
    next.catch(() => undefined),
  )
  return next
}

async function appendOutcome(outcome: ModelOutcome) {
  const existing = await readOutcomes(outcome.projectId)
  // Idempotent: outcomes carry the source workspace record's id, and callers
  // re-run over the full workspace list, so skip anything already recorded.
  if (existing.some((o) => o.id === outcome.id)) return
  await writeOutcomes(outcome.projectId, [...existing, outcome])
  setVersion((value) => value + 1)
}

export async function listOutcomes(projectId: string): Promise<ModelOutcome[]> {
  return readOutcomes(projectId)
}

// A project's outcome history that stays current as new outcomes are recorded. A signal rather than a resource:
// outcomes are recorded on every session's first idle, and reading a resource while it refetches would suspend the
// page around the reader.
export function createOutcomes(projectId: () => string) {
  const [outcomes, setOutcomes] = createSignal<ModelOutcome[]>([])
  createEffect(() => {
    const id = projectId()
    version()
    void listOutcomes(id).then((list) => {
      if (projectId() === id) setOutcomes(list)
    })
  })
  return outcomes
}

// The real evidence record parallel workspaces produce is the renderer-side
// ParallelWorkspaceRecord type in pages/layout-new.tsx. That type isn't
// exported (and this module doesn't own that file), so this is the minimal
// structural subset this mapper actually reads — any real
// ParallelWorkspaceRecord satisfies it.
export type WorkspaceRecordForEconomics = {
  id: string
  provider: string
  model: string
  sourcePath: string
  createdAt: string
  lastActivityAt: string
  changedFilesCount: number
  validationPassed?: boolean
  validationReport?: { hadChecks: boolean; passed: boolean }
}

export function outcomesFromWorkspaceRecord(
  record: WorkspaceRecordForEconomics,
  category: TaskCategory,
  measured?: MeasuredUsage,
): ModelOutcome {
  const createdAtMs = Date.parse(record.createdAt)
  const lastActivityMs = Date.parse(record.lastActivityAt)
  const latencyMs =
    Number.isFinite(createdAtMs) && Number.isFinite(lastActivityMs) ? Math.max(0, lastActivityMs - createdAtMs) : 0

  return {
    id: record.id,
    projectId: record.sourcePath,
    provider: record.provider,
    model: record.model,
    category,
    createdAt: Date.now(),
    checksPassed: record.validationPassed ?? record.validationReport?.passed,
    hadChecks: record.validationReport?.hadChecks ?? false,
    latencyMs,
    changedFiles: record.changedFilesCount,
    usage: measured?.usage,
    costUsd: measured?.costUsd,
    ...(measured?.costUsd !== undefined ? { costPriced: true } : {}),
  }
}
