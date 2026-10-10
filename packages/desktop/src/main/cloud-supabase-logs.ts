import { management, refPath, scrub, stringField, numberField, type SupabaseContext } from "./cloud-supabase-api"

// Recent logs of one Supabase service, read from the Management API's logs
// endpoint. It takes ClickHouse SQL against a single `logs` table whose
// `source` column names the service, and a window of at most 24 hours:
// https://supabase.com/docs/reference/api/v1-get-project-logs
// https://supabase.com/docs/guides/observability/advanced-log-filtering

export const LOG_SERVICES = {
  api: { label: "API gateway", sources: ["edge_logs"] },
  postgres: { label: "Postgres", sources: ["postgres_logs"] },
  auth: { label: "Auth", sources: ["auth_logs"] },
  storage: { label: "Storage", sources: ["storage_logs"] },
  functions: { label: "Edge Functions", sources: ["function_edge_logs", "function_logs"] },
} as const

export type LogService = keyof typeof LOG_SERVICES

export function isLogService(value: unknown): value is LogService {
  return typeof value === "string" && value in LOG_SERVICES
}

const MAX_WINDOW_MINUTES = 24 * 60

// ClickHouse string literal: backslash and quote are the only escapes needed.
function literal(value: string) {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
}

export async function readSupabaseLogs(
  context: SupabaseContext,
  input: { service: LogService; minutes?: number; limit?: number; search?: string },
) {
  const service = LOG_SERVICES[input.service]
  const minutes = Math.min(MAX_WINDOW_MINUTES, Math.max(1, Math.trunc(input.minutes ?? 60)))
  const limit = Math.min(500, Math.max(1, Math.trunc(input.limit ?? 100)))
  const search = input.search?.trim().slice(0, 200)
  const sql = [
    "select timestamp, event_message from logs",
    `where source in (${service.sources.map(literal).join(", ")})`,
    search ? `and event_message ilike ${literal(`%${search}%`)}` : "",
    "order by timestamp desc",
    `limit ${limit}`,
  ]
    .filter(Boolean)
    .join(" ")
  const end = new Date()
  const start = new Date(end.getTime() - minutes * 60_000)
  const query = new URLSearchParams({
    sql,
    iso_timestamp_start: start.toISOString(),
    iso_timestamp_end: end.toISOString(),
  })
  const body = await management(context, refPath(context, `/analytics/endpoints/logs?${query}`))
  const failure = body && typeof body === "object" ? Reflect.get(body, "error") : undefined
  if (failure) {
    throw new Error(
      `Supabase could not read the ${service.label} logs: ${scrub(context, typeof failure === "string" ? failure : (stringField(failure, "message") ?? JSON.stringify(failure)))}`,
    )
  }
  const result = body && typeof body === "object" ? Reflect.get(body, "result") : undefined
  const entries = (Array.isArray(result) ? result : [])
    .map((row) => ({
      at: timestamp(row),
      message: scrub(context, stringField(row, "event_message") ?? ""),
    }))
    .filter((row) => row.message)
    .toReversed()
  return {
    service: input.service,
    label: service.label,
    project: { ref: context.projectRef, name: context.projectName },
    from: start.toISOString(),
    to: end.toISOString(),
    entries,
    truncated: entries.length >= limit,
  }
}

// Timestamps arrive as microseconds since the epoch or as text. The column is
// a UTC DateTime64, so text without a zone ("2026-10-10 09:30:00.000000") is
// UTC; Date.parse would read it in the machine's own time zone.
function timestamp(row: unknown) {
  const micros = numberField(row, "timestamp")
  if (micros !== undefined) return new Date(micros > 1e14 ? micros / 1000 : micros).toISOString()
  const text = stringField(row, "timestamp")?.trim()
  if (!text) return ""
  const utc = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text.replace(" ", "T")}Z`
  return Number.isNaN(Date.parse(utc)) ? text : new Date(utc).toISOString()
}
