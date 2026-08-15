import { randomUUID } from "node:crypto"

import { getStore } from "./store"

const STORE_NAME = "scheduled-agents"
const STORE_KEY = "records"
// The scheduler wakes up on this cadence to launch any records that are due.
const TICK_INTERVAL_MS = 20_000
const COMPLETION_POLL_MS = 1_500
const COMPLETION_TIMEOUT_MS = 6 * 60 * 60_000
const STARTUP_GRACE_MS = 3_000

export type ScheduledAgentStatus = "scheduled" | "running" | "completed" | "failed" | "canceled"

export type ScheduledAgentRecord = {
  id: string
  prompt: string
  directory: string
  parentSessionId?: string
  runAt: string
  status: ScheduledAgentStatus
  createdAt: string
  startedAt?: string
  completedAt?: string
  sessionId?: string
  error?: string
}

// Same shape as ServerReadyData; the IPC layer passes deps.awaitInitialization
// straight through so launches wait for the sidecar engine to be ready.
export type ScheduledAgentEngine = {
  url: string
  username: string | null
  password: string | null
}

export type CreateScheduledAgentInput = {
  prompt: string
  directory: string
  parentSessionId?: string
  runAt: string
}

const now = () => new Date().toISOString()

let engineProvider: (() => Promise<ScheduledAgentEngine>) | undefined
let tickTimer: NodeJS.Timeout | undefined
let tickInProgress = false
const activeRuns = new Set<string>()

function readRecords(): ScheduledAgentRecord[] {
  const raw = getStore(STORE_NAME).get(STORE_KEY)
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is ScheduledAgentRecord => typeof item?.id === "string")
}

function writeRecords(records: ScheduledAgentRecord[]) {
  getStore(STORE_NAME).set(STORE_KEY, records)
}

function updateRecord(id: string, update: (record: ScheduledAgentRecord) => ScheduledAgentRecord) {
  const records = readRecords()
  const index = records.findIndex((record) => record.id === id)
  if (index === -1) throw new Error("Scheduled agent was not found.")
  records[index] = update(records[index]!)
  writeRecords(records)
  return records[index]!
}

function engineHeaders(engine: ScheduledAgentEngine) {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  }
  if (engine.username && engine.password) {
    headers.authorization = `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}`
  }
  return headers
}

async function engineRequest<T>(
  engine: ScheduledAgentEngine,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  const base = engine.url.endsWith("/") ? engine.url : `${engine.url}/`
  const response = await fetch(new URL(path.replace(/^\//, ""), base), {
    method: init.method ?? "GET",
    headers: engineHeaders(engine),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Vector engine request failed (${response.status})${body ? `: ${body.slice(0, 500)}` : ""}`)
  }
  if (response.status === 204) return undefined as T
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

function reconcileInterruptedRecords(records: ScheduledAgentRecord[]) {
  let changed = false
  const next = records.map((record) => {
    if (record.status !== "running" || activeRuns.has(record.id)) return record
    changed = true
    return {
      ...record,
      status: "failed" as const,
      completedAt: now(),
      error: "Interrupted by app restart before the agent completed.",
    }
  })
  if (changed) writeRecords(next)
  return next
}

type EngineMessageResponse = {
  data?: Array<{
    info?: {
      role?: string
      finish?: string
      error?: { message?: string; data?: { message?: string } } | string
    }
  }>
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

function activeSessionMap(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {}
  const record = value as Record<string, unknown>
  const candidate = record.data && typeof record.data === "object" ? record.data : record
  return candidate as Record<string, unknown>
}

function assistantFailure(response: EngineMessageResponse) {
  const messages = response.data ?? []
  const assistant = messages.filter((item) => item.info?.role === "assistant").at(-1)?.info
  if (!assistant) return { settled: false as const }
  if (!assistant.error) return { settled: true as const }
  if (typeof assistant.error === "string") return { settled: true as const, error: assistant.error }
  return {
    settled: true as const,
    error: assistant.error.data?.message ?? assistant.error.message ?? "The scheduled agent failed.",
  }
}

async function abortEngineSession(engine: ScheduledAgentEngine, sessionId: string) {
  await engineRequest(engine, `/api/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" }).catch(() => {})
}

async function waitForSessionCompletion(engine: ScheduledAgentEngine, recordId: string, sessionId: string) {
  const startedAt = Date.now()
  let observedActive = false
  while (Date.now() - startedAt < COMPLETION_TIMEOUT_MS) {
    const record = readRecords().find((item) => item.id === recordId)
    if (!record || record.status === "canceled") {
      await abortEngineSession(engine, sessionId)
      return "canceled" as const
    }

    // Scheduled agents run on the V2 session engine. Active sessions are
    // present in this registry and disappear only after the execution loop
    // settles, which avoids marking a merely admitted prompt as complete.
    const sessions = activeSessionMap(await engineRequest<unknown>(engine, "/api/session/active"))
    const active = Boolean(sessions[sessionId])
    if (active) observedActive = true
    if (!active && (observedActive || Date.now() - startedAt >= STARTUP_GRACE_MS)) {
      const messages = await engineRequest<EngineMessageResponse>(
        engine,
        `/api/session/${encodeURIComponent(sessionId)}/message?limit=20`,
      )
      const outcome = assistantFailure(messages)
      if (!outcome.settled) {
        await delay(COMPLETION_POLL_MS)
        continue
      }
      if (outcome.error) throw new Error(outcome.error)
      return "completed" as const
    }
    await delay(COMPLETION_POLL_MS)
  }
  await abortEngineSession(engine, sessionId)
  throw new Error("Scheduled agent exceeded the six-hour completion limit and was stopped.")
}

async function launchScheduledAgent(id: string, awaitEngine: () => Promise<ScheduledAgentEngine>) {
  activeRuns.add(id)
  try {
    updateRecord(id, (current) => ({ ...current, status: "running", startedAt: now(), error: undefined }))
    const record = readRecords().find((item) => item.id === id)
    if (!record) throw new Error("Scheduled agent was not found.")

    const engine = await awaitEngine()
    const created = await engineRequest<{ data?: { id?: string } }>(engine, "/api/session", {
      method: "POST",
      body: { location: { directory: record.directory } },
    })
    const sessionId = created?.data?.id
    if (!sessionId) throw new Error("Vector's engine did not return a session ID for the scheduled agent.")
    const current = updateRecord(id, (item) => ({ ...item, sessionId }))
    if (current.status === "canceled") {
      await abortEngineSession(engine, sessionId)
      return
    }

    await engineRequest(engine, `/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      body: { prompt: { text: record.prompt }, resume: true },
    })

    const outcome = await waitForSessionCompletion(engine, id, sessionId)
    if (outcome === "canceled") return
    updateRecord(id, (item) => ({
      ...item,
      status: "completed",
      completedAt: now(),
      sessionId,
      error: undefined,
    }))
  } finally {
    activeRuns.delete(id)
  }
}

async function runDueScheduledAgents() {
  if (tickInProgress || !engineProvider) return
  tickInProgress = true
  try {
    const nowMs = Date.now()
    const due = readRecords().filter((record) => {
      if (record.status !== "scheduled") return false
      const runAtMs = Date.parse(record.runAt)
      // A record with an unreadable time can never become due later; fire it
      // now instead of leaving it stuck as "scheduled" forever.
      return !Number.isFinite(runAtMs) || runAtMs <= nowMs
    })
    for (const record of due) {
      void launchScheduledAgent(record.id, engineProvider).catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        try {
          updateRecord(record.id, (current) =>
            current.status === "canceled"
              ? current
              : { ...current, status: "failed", completedAt: now(), error: message },
          )
        } catch {
          // The record was removed mid-run; there is nothing left to mark.
        }
      })
    }
  } finally {
    tickInProgress = false
  }
}

export function initScheduledAgents(awaitEngine: () => Promise<ScheduledAgentEngine>): void {
  if (tickTimer) return
  engineProvider = awaitEngine
  reconcileInterruptedRecords(readRecords())
  tickTimer = setInterval(() => {
    void runDueScheduledAgents()
  }, TICK_INTERVAL_MS)
}

export function listScheduledAgents(scope?: { directory?: string; parentSessionId?: string }): ScheduledAgentRecord[] {
  return reconcileInterruptedRecords(readRecords()).filter((record) => {
    if (!scope) return true
    if (scope.directory && record.directory !== scope.directory) return false
    return record.parentSessionId === scope.parentSessionId
  })
}

export function createScheduledAgent(input: CreateScheduledAgentInput): ScheduledAgentRecord {
  const prompt = input.prompt?.trim()
  if (!prompt) throw new Error("Write a prompt for the scheduled agent to run.")
  const directory = input.directory?.trim()
  if (!directory) throw new Error("Choose a project directory for the scheduled agent.")
  const parsed = Date.parse(input.runAt)
  if (!Number.isFinite(parsed)) throw new Error("The scheduled time is not a valid date.")

  // Past times are clamped to now so the record fires on the next scheduler
  // tick instead of being rejected.
  const record: ScheduledAgentRecord = {
    id: randomUUID(),
    prompt,
    directory,
    parentSessionId: input.parentSessionId?.trim() || undefined,
    runAt: new Date(Math.max(parsed, Date.now())).toISOString(),
    status: "scheduled",
    createdAt: now(),
  }
  writeRecords([record, ...readRecords()])
  return record
}

export async function cancelScheduledAgent(id: string): Promise<ScheduledAgentRecord | undefined> {
  const record = readRecords().find((item) => item.id === id)
  if (!record) return undefined
  if (record.status !== "scheduled" && record.status !== "running") return record
  const canceled = updateRecord(id, (current) => ({ ...current, status: "canceled", completedAt: now() }))
  if (!record.sessionId || !engineProvider) return canceled
  const engine = await engineProvider().catch(() => undefined)
  if (engine) await abortEngineSession(engine, record.sessionId)
  return canceled
}

export function removeScheduledAgent(id: string): ScheduledAgentRecord[] {
  const next = readRecords().filter((item) => item.id !== id)
  writeRecords(next)
  return next
}
