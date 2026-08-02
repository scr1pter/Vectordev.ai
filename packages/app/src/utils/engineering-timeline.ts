export type EngineeringEventType =
  | "ai"
  | "file"
  | "terminal"
  | "browser"
  | "checkpoint"
  | "review"
  | "error"
  | "build"
  | "decision"

export type EngineeringEventStatus = "pending" | "running" | "success" | "warning" | "failed"

export type EngineeringTimelineEvent = {
  id: string
  timestamp: number
  type: EngineeringEventType
  title: string
  summary?: string
  status: EngineeringEventStatus
  details?: string[]
  files?: string[]
  command?: string
  output?: string
  browserAction?: string
  screenshotPath?: string
  checkpointId?: string
  source?: string
}

type EngineeringTimelineInput = Partial<Pick<EngineeringTimelineEvent, "id" | "timestamp">> &
  Omit<EngineeringTimelineEvent, "id" | "timestamp">

const STORAGE_KEY = "vector.engineering-timeline.v1"
const MAX_EVENTS_PER_PROJECT = 250

function storage() {
  if (typeof window === "undefined") return undefined
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function createEventId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID()
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function readStore(): Record<string, EngineeringTimelineEvent[]> {
  const local = storage()
  if (!local) return {}
  try {
    const parsed = JSON.parse(local.getItem(STORAGE_KEY) ?? "{}") as Record<string, EngineeringTimelineEvent[]>
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

function writeStore(store: Record<string, EngineeringTimelineEvent[]>) {
  const local = storage()
  if (!local) return
  local.setItem(STORAGE_KEY, JSON.stringify(store))
}

function normalizeProjectId(projectId: string | undefined) {
  return projectId?.trim() || "default"
}

function notifyTimelineUpdated(projectId: string) {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent("vector:engineering-timeline-updated", { detail: { projectId } }))
}

export function getEngineeringEvents(projectId: string) {
  const key = normalizeProjectId(projectId)
  return [...(readStore()[key] ?? [])].sort((a, b) => b.timestamp - a.timestamp)
}

export function logEngineeringEvent(projectId: string, input: EngineeringTimelineInput) {
  const key = normalizeProjectId(projectId)
  const event: EngineeringTimelineEvent = {
    ...input,
    id: input.id ?? createEventId(),
    timestamp: input.timestamp ?? Date.now(),
    details: input.details?.filter(Boolean),
    files: input.files?.filter(Boolean),
  }

  const store = readStore()
  const current = store[key] ?? []
  store[key] = [event, ...current.filter((item) => item.id !== event.id)]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_EVENTS_PER_PROJECT)
  writeStore(store)
  notifyTimelineUpdated(key)
  return event
}

export function clearEngineeringEvents(projectId: string) {
  const key = normalizeProjectId(projectId)
  const store = readStore()
  delete store[key]
  writeStore(store)
  notifyTimelineUpdated(key)
}

export const engineeringTimelineService = {
  logEngineeringEvent,
  getEngineeringEvents,
  clearEngineeringEvents,
}
