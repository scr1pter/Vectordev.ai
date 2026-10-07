// Persists verified ModelOutcome history per project, using Vector's standard
// desktop/web persistence pattern: electron-store IPC when running in the
// desktop shell, falling back to localStorage in the web build. Keys are
// namespaced per project via an FNV-1a hash (the same `checksum` helper
// persist.ts uses), with stored project identities checked before reading.
import { checksum } from "@vectordevai/core/util/encode"
import { createEffect, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
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

function parseOutcomes(raw: string | null, projectId: string): ModelOutcome[] {
  if (!raw) return []
  const parsed = (() => {
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return undefined
    }
  })()
  if (!Array.isArray(parsed)) return []
  return parsed.filter((value): value is ModelOutcome => {
    if (!value || typeof value !== "object") return false
    const outcome = value as Record<string, unknown>
    if (!["id", "projectId", "provider", "model"].every((key) => typeof outcome[key] === "string" && outcome[key]))
      return false
    if (outcome.projectId !== projectId || typeof outcome.hadChecks !== "boolean") return false
    if (
      ![
        "documentation",
        "bug-fix",
        "small-edit",
        "frontend",
        "backend",
        "refactor",
        "architecture",
        "testing",
        "general",
      ].includes(String(outcome.category))
    )
      return false
    if (
      !["createdAt", "latencyMs", "changedFiles"].every(
        (key) => typeof outcome[key] === "number" && Number.isFinite(outcome[key]) && outcome[key] >= 0,
      )
    )
      return false
    if (outcome.checksPassed !== undefined && typeof outcome.checksPassed !== "boolean") return false
    if (outcome.usage === undefined) return true
    if (!outcome.usage || typeof outcome.usage !== "object") return false
    const usage = outcome.usage as Record<string, unknown>
    return ["input", "output", "reasoning", "cacheRead", "cacheWrite"].every(
      (key) => typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0,
    )
  })
}

async function readOutcomes(projectId: string): Promise<ModelOutcome[]> {
  const api = storeApi()
  if (api?.storeGet) {
    const raw = await api.storeGet(STORAGE_NAME, projectKey(projectId))
    return parseOutcomes(raw, projectId)
  }
  return parseOutcomes(globalThis.localStorage?.getItem(localStorageKey(projectId)) ?? null, projectId)
}

async function writeOutcomes(projectId: string, outcomes: ModelOutcome[]): Promise<void> {
  const capped = outcomes.slice(-MAX_OUTCOMES_PER_PROJECT)
  const value = JSON.stringify(capped)

  const api = storeApi()
  if (api?.storeSet) {
    await api.storeSet(STORAGE_NAME, projectKey(projectId), value)
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
  return queueUpdate(outcome.projectId, () => appendOutcome(outcome))
}

export function removeOutcome(projectId: string, id: string): Promise<void> {
  return queueUpdate(projectId, async () => {
    const existing = await readOutcomes(projectId)
    const remaining = existing.filter((outcome) => outcome.id !== id)
    if (remaining.length === existing.length) return
    await writeOutcomes(projectId, remaining)
    setVersion((value) => value + 1)
  })
}

function queueUpdate(projectId: string, update: () => Promise<void>) {
  const key = projectKey(projectId)
  const next = (queues.get(key) ?? Promise.resolve()).then(update)
  const settled = next.catch(() => undefined)
  queues.set(key, settled)
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key)
  })
  return next
}

async function appendOutcome(outcome: ModelOutcome) {
  const existing = await readOutcomes(outcome.projectId)
  // Sessions accumulate work and workspace validation can be rerun. Replace
  // each source's sample so revisions update evidence without adding runs.
  await writeOutcomes(outcome.projectId, [...existing.filter((entry) => entry.id !== outcome.id), outcome])
  setVersion((value) => value + 1)
}

export async function listOutcomes(projectId: string): Promise<ModelOutcome[]> {
  return readOutcomes(projectId)
}

// A project's outcome history that stays current as new outcomes are recorded. A signal rather than a resource:
// outcomes are recorded when sessions go idle, and reading a resource while it refetches would suspend the
// page around the reader.
export function createOutcomes(projectId: () => string) {
  const [store, setStore] = createStore<{ projectId: string; outcomes: ModelOutcome[] }>({
    projectId: "",
    outcomes: [],
  })
  let request = 0
  createEffect(() => {
    const id = projectId()
    version()
    const generation = ++request
    void listOutcomes(id)
      .then((list) => {
        if (generation === request && projectId() === id) setStore({ projectId: id, outcomes: list })
      })
      .catch(() => undefined)
  })
  // A directory change invalidates the previous history immediately, including
  // the interval before the effect starts its asynchronous storage read.
  return () => (store.projectId === projectId() ? store.outcomes : [])
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
): ModelOutcome | undefined {
  // A model switch also invalidates check attribution, not just spend.
  if (measured && (measured.provider !== record.provider || measured.model !== record.model)) return undefined
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
    latencyMeasured: Number.isFinite(createdAtMs) && Number.isFinite(lastActivityMs) && lastActivityMs >= createdAtMs,
    changedFiles: record.changedFilesCount,
    usage: measured?.usage,
    costUsd: measured?.costUsd,
    ...(measured?.costUsd !== undefined ? { costPriced: true } : {}),
  }
}
