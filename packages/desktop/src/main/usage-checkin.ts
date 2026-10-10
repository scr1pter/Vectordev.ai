import { randomUUID } from "node:crypto"
import { UsageReport } from "@vectordevai/schema/usage-report"
import { Option, Schema } from "effect"

const CHECKIN_URL = "https://vectordev.ai/api/usage/checkin"
const DAY = 24 * 60 * 60 * 1000
const MAX_COUNT = 100_000
// The last tick before UTC midnight lands this far ahead of it, so the end of a day is still sent as part of that day.
const DAY_END_MARGIN = 5 * 60 * 1000
const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// Only the parent link is read; titles, directories and everything else in a row are ignored.
const SessionRows = Schema.Array(Schema.Struct({ parentID: Schema.optional(Schema.String) }))
// The counts the server last accepted and the UTC day they belong to, with the lifetime tokens and model responses of
// the last usage report it accepted that day.
const Sent = Schema.Struct({
  day: Schema.String,
  sessions: Schema.Number,
  subagentSessions: Schema.Number,
  tokens: Schema.optionalKey(Schema.Number),
  responses: Schema.optionalKey(Schema.Number),
})

type Counts = { sessions: number; subagentSessions: number }
type Dependencies = {
  /** Where to send the check-in; undefined turns the service off (development builds). */
  endpoint: string | undefined
  store: { get(key: string): unknown; set(key: string, value: unknown): void }
  enabled(): boolean
  engine: { url: string; username: string | null; password: string | null }
  token(): Promise<string | undefined>
  fetch(url: string, init: RequestInit): Promise<Response>
  now(): number
  version: string
  platform: string
  arch: string
  delay?: number
  interval?: number
}

/**
 * Reports a random install ID, the account token when signed in, the app version, OS, CPU architecture, how many
 * sessions and subagent sessions were active in the current UTC day, and, when signed in, the usage report behind
 * Settings > Usage & streaks (token totals, cost, models and their token shares, effort levels, chats, streaks, task
 * timing). Nothing those sessions contain is sent.
 *
 * The first check-in of a day marks the install active; later ones send again whenever a count has gone up or the
 * report shows more tokens or model responses, and the server keeps the largest values it receives for an install and
 * day. When the report cannot be read, the check-in goes without it.
 */
export function createUsageCheckin(deps: Dependencies) {
  const state: {
    running?: Promise<boolean>
    timer?: ReturnType<typeof setTimeout>
  } = {}

  const checkin = async () => {
    if (!deps.endpoint || !deps.enabled()) return false
    const now = deps.now()
    const day = new Date(now).toISOString().slice(0, 10)
    const sent = Schema.decodeUnknownOption(Sent)(deps.store.get("sent")).pipe(
      Option.filter((value) => value.day === day),
    )
    const counted = await countSessions(deps, Math.floor(now / DAY) * DAY).catch(() => undefined)
    const token = await deps.token().catch(() => undefined)
    // The server keeps model use only from a signed-in install, so a signed-out one neither reads nor sends it.
    const usage = token ? await readUsage(deps).catch(() => undefined) : undefined
    // A failed count still reports the install as active today, once, with nothing counted. The next count that works
    // is higher than those zeros whenever anything was used, so it replaces them. Later in the day a failed count
    // repeats what was accepted, which the server already keeps.
    const counts =
      counted ??
      Option.match(sent, {
        onNone: () => ({ sessions: 0, subagentSessions: 0 }),
        onSome: (value) => ({ sessions: value.sessions, subagentSessions: value.subagentSessions }),
      })
    // A day's counts and a report's totals only grow (unless sessions are deleted), so nothing needs sending until one
    // of them goes up.
    if (
      Option.isSome(sent) &&
      counts.sessions <= sent.value.sessions &&
      counts.subagentSessions <= sent.value.subagentSessions &&
      (!usage ||
        (usage.lifetimeTokens <= (sent.value.tokens ?? -1) && usage.modelResponses <= (sent.value.responses ?? -1)))
    )
      return false
    // Switching sharing off while the sessions were being counted still stops this check-in.
    if (!deps.enabled()) return false
    const response = await deps
      .fetch(deps.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          installId: installId(deps.store),
          client: "desktop",
          version: deps.version,
          platform: deps.platform,
          arch: deps.arch,
          sessions: counts.sessions,
          subagentSessions: counts.subagentSessions,
          ...(usage ? { usage } : {}),
        }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      })
      .catch(() => undefined)
    await response?.body?.cancel().catch(() => undefined)
    if (!response?.ok) return false
    const tokens = usage?.lifetimeTokens ?? Option.getOrUndefined(sent)?.tokens
    const responses = usage?.modelResponses ?? Option.getOrUndefined(sent)?.responses
    deps.store.set("sent", {
      day,
      ...counts,
      ...(tokens === undefined ? {} : { tokens }),
      ...(responses === undefined ? {} : { responses }),
    })
    return true
  }

  const run = () => {
    if (state.running) return state.running
    const running = checkin()
      .catch(() => false)
      .finally(() => {
        state.running = undefined
      })
    state.running = running
    return running
  }

  const schedule = (delay: number) => {
    const timer = setTimeout(() => {
      void run().then(() => {
        // stop(), or a stop() and start() while this run was in flight, leaves another timer (or none) in charge.
        if (state.timer !== timer) return
        const interval = deps.interval ?? 60 * 60 * 1000
        const untilDayEnd = DAY - (deps.now() % DAY) - DAY_END_MARGIN
        schedule(untilDayEnd > 0 ? Math.min(interval, untilDayEnd) : interval)
      })
    }, delay)
    timer.unref?.()
    state.timer = timer
  }

  return {
    /** Never throws; resolves true only when a check-in was sent and accepted. */
    checkin: run,
    start() {
      if (state.timer) return
      schedule(deps.delay ?? 60_000)
    },
    stop() {
      clearTimeout(state.timer)
      state.timer = undefined
    },
  }
}

/** Packaged release builds report to vectordev.ai; development builds report only where VECTOR_USAGE_URL points. */
export function usageCheckinEndpoint(input: { packaged: boolean; channel: string; override: string | undefined }) {
  if (input.packaged && input.channel !== "dev") return CHECKIN_URL
  if (input.override && URL.canParse(input.override)) return input.override
  return undefined
}

async function countSessions(
  deps: Pick<Dependencies, "engine" | "fetch">,
  start: number,
  cursor?: string,
  counted: Counts = { sessions: 0, subagentSessions: 0 },
): Promise<Counts> {
  const url = new URL("/experimental/session", deps.engine.url)
  url.search = new URLSearchParams({
    start: String(start),
    archived: "true",
    limit: "500",
    ...(cursor ? { cursor } : {}),
  }).toString()
  const response = await deps.fetch(url.href, {
    headers: engineHeaders(deps.engine),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`The local server could not list sessions (${response.status}).`)
  const rows = Schema.decodeUnknownOption(SessionRows)(await response.json())
  if (Option.isNone(rows)) throw new Error("The local server returned an unexpected session list.")
  const subagents = rows.value.filter((row) => row.parentID).length
  const next = {
    sessions: Math.min(MAX_COUNT, counted.sessions + rows.value.length - subagents),
    subagentSessions: Math.min(MAX_COUNT, counted.subagentSessions + subagents),
  }
  const nextCursor = response.headers.get("x-next-cursor")
  if (!nextCursor || rows.value.length === 0) return next
  if (next.sessions === MAX_COUNT && next.subagentSessions === MAX_COUNT) return next
  return countSessions(deps, start, nextCursor, next)
}

/** The local summary behind Settings > Usage & streaks, as the report the server accepts; undefined when unreadable. */
async function readUsage(deps: Pick<Dependencies, "engine" | "fetch">) {
  const response = await deps.fetch(new URL("/experimental/session/usage", deps.engine.url).href, {
    headers: engineHeaders(deps.engine),
    redirect: "error",
    // It reads every message's usage, which takes a while on a long history; nothing waits on it.
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return undefined
  }
  return UsageReport.fromSummary(await response.json())
}

function engineHeaders(engine: Dependencies["engine"]): Record<string, string> {
  if (!engine.username || !engine.password) return {}
  return { authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` }
}

function installId(store: Dependencies["store"]) {
  const existing = store.get("installId")
  if (typeof existing === "string" && INSTALL_ID.test(existing)) return existing
  const created = randomUUID()
  store.set("installId", created)
  return created
}
