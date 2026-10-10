import { randomUUID } from "node:crypto"
import { Option, Schema } from "effect"

const CHECKIN_URL = "https://vectordev.ai/api/usage/checkin"
const DAY = 24 * 60 * 60 * 1000
const MAX_COUNT = 100_000
// The last tick before UTC midnight lands this far ahead of it, so the end of a day is still sent as part of that day.
const DAY_END_MARGIN = 5 * 60 * 1000
const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// Only the parent link is read; titles, directories and everything else in a row are ignored.
const SessionRows = Schema.Array(Schema.Struct({ parentID: Schema.optional(Schema.String) }))
// The counts the server last accepted and the UTC day they belong to.
const Sent = Schema.Struct({ day: Schema.String, sessions: Schema.Number, subagentSessions: Schema.Number })

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
 * Reports a random install ID, the account token when signed in, the app version, OS, CPU architecture and how many
 * sessions and subagent sessions were active in the current UTC day. Nothing those sessions contain is sent.
 *
 * The first check-in of a day marks the install active; later ones send the day's counts again whenever one of them has
 * gone up, and the server keeps the largest counts it receives for an install and day.
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
    // A failed count still reports the install as active today, once, with nothing counted. The next count that works
    // is higher than those zeros whenever anything was used, so it replaces them.
    if (!counted && Option.isSome(sent)) return false
    const counts = counted ?? { sessions: 0, subagentSessions: 0 }
    // A day's counts only grow (unless sessions are deleted), so nothing needs sending until one of them goes up.
    if (
      Option.isSome(sent) &&
      counts.sessions <= sent.value.sessions &&
      counts.subagentSessions <= sent.value.subagentSessions
    )
      return false
    const token = await deps.token().catch(() => undefined)
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
        }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      })
      .catch(() => undefined)
    await response?.body?.cancel().catch(() => undefined)
    if (!response?.ok) return false
    deps.store.set("sent", { day, ...counts })
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
    headers:
      deps.engine.username && deps.engine.password
        ? {
            authorization: `Basic ${Buffer.from(`${deps.engine.username}:${deps.engine.password}`).toString("base64")}`,
          }
        : {},
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

function installId(store: Dependencies["store"]) {
  const existing = store.get("installId")
  if (typeof existing === "string" && INSTALL_ID.test(existing)) return existing
  const created = randomUUID()
  store.set("installId", created)
  return created
}
