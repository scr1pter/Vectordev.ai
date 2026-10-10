import { Option, Schema } from "effect"

/*
 * Keeps the computer awake while the local engine has work running.
 *
 * Idle sleep froze agents mid-run: on battery a Mac can sleep after a minute without input, and a sleeping machine
 * only moves its agents forward in brief dark wakes. While any session in the engine is busy or retrying, this holds
 * a power save blocker that lets the display sleep but keeps the system awake. Sleep the user asks for still happens:
 * closing a laptop's lid sleeps it whatever is running.
 *
 * Busy sessions are tracked here, from the engine's own event stream, and never from a window, whose stream is what
 * goes stale. Each connection is seeded from the status of every directory sessions have run in. The blocker is never
 * held on old news: once the stream has been down or silent for longer than `silenceMs` (the engine sends a heartbeat
 * every 10 seconds), it is released until a fresh connection has been seeded.
 *
 * Nor is it held for work that waits on the user. A session stays busy while a permission or question prompt is
 * unanswered, so a session with one does not count. Its parent, waiting on it as a foreground subagent, still looks
 * busy; so while any prompt is unanswered, the blocker is released once nothing has moved for `stalledMs`.
 */

const SILENCE_MS = 5 * 60_000
const STALLED_MS = 10 * 60_000
const RETRY_MS = 1_000
const RETRY_MAX_MS = 30_000
const WATCHDOG_MAX_MS = 15_000
const SEED_TIMEOUT_MS = 10_000
const BUSY = new Set(["busy", "retry"])
const ASKED = new Set(["permission.asked", "question.asked"])
const ANSWERED = new Set(["permission.replied", "question.replied", "question.rejected"])

const KeepAwakeEvent = Schema.Struct({
  directory: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  payload: Schema.Struct({ type: Schema.String, properties: Schema.optional(Schema.Unknown) }),
})
export type KeepAwakeEvent = typeof KeepAwakeEvent.Type

const Status = Schema.Struct({ type: Schema.String })
const Statuses = Schema.Record(Schema.String, Status)
const Request = Schema.Struct({ id: Schema.String, sessionID: Schema.String })
const Requests = Schema.Array(Request)
const StatusProperties = Schema.Struct({ sessionID: Schema.String, status: Status })
const AnsweredProperties = Schema.Struct({ requestID: Schema.String })
const DisposedProperties = Schema.Struct({ directory: Schema.String })

export type KeepAwakeLocation = { directory: string; workspace?: string }

export type KeepAwakeSource = {
  /** The engine's global event stream. It ends or throws when the connection drops, and stops when `signal` aborts. */
  events(signal: AbortSignal): AsyncIterable<KeepAwakeEvent>
  /** The status of each session the engine has for one directory; sessions missing from it are idle. */
  statuses(location: KeepAwakeLocation, signal: AbortSignal): Promise<Readonly<Record<string, { type: string }>>>
  /** The permission and question prompts waiting on the user in one directory. */
  requests(location: KeepAwakeLocation, signal: AbortSignal): Promise<readonly { id: string; sessionID: string }[]>
}

export type PowerBlocker = { start(): number; stop(id: number): void }

export function startKeepAwake(input: {
  source: KeepAwakeSource
  blocker: PowerBlocker
  /** How long the stream may be down or silent before what it last said stops holding the blocker. */
  silenceMs?: number
  /** How long work may go without progress, while a prompt waits on the user, before it stops holding the blocker. */
  stalledMs?: number
  /** The first reconnect delay; it doubles after each failed attempt, up to 30 seconds. */
  retryMs?: number
  log?: (message: string, meta?: Record<string, unknown>) => void
}) {
  const silenceMs = input.silenceMs ?? SILENCE_MS
  const stalledMs = input.stalledMs ?? STALLED_MS
  const retryMs = input.retryMs ?? RETRY_MS
  // Each busy or retrying session, with the key of the location its status came from.
  const busy = new Map<string, string>()
  // Each prompt waiting on the user, with the session that asked it.
  const waiting = new Map<string, string>()
  const locations = new Map<string, KeepAwakeLocation>()
  let held: number | undefined
  // When a seeded connection was last heard from; only that keeps the blocker held.
  let heardAt = Date.now()
  // When the current connection attempt was last heard from, seeded or not.
  let activeAt = Date.now()
  // When a session last changed status or wrote to its messages.
  let progressAt = Date.now()
  let seeded = 0
  let stopped = false
  let attempt: AbortController | undefined

  const apply = () => {
    const blocked = new Set(waiting.values())
    const working = [...busy.keys()].filter((sessionID) => !blocked.has(sessionID))
    const stalled = working.length < busy.size && Date.now() - progressAt > stalledMs
    const hold = !stopped && working.length > 0 && !stalled && Date.now() - heardAt <= silenceMs
    if (hold && held === undefined) {
      held = input.blocker.start()
      input.log?.("keep awake: holding off idle sleep", { sessions: working.length })
    }
    if (!hold && held !== undefined) {
      input.blocker.stop(held)
      held = undefined
      input.log?.("keep awake: released", { sessions: working.length, waiting: busy.size - working.length })
    }
  }

  const handle = (event: KeepAwakeEvent) => {
    const type = event.payload.type
    if (type.startsWith("message.") || type === "session.status") progressAt = Date.now()
    if (type === "session.status") {
      const change = Option.getOrUndefined(Schema.decodeUnknownOption(StatusProperties)(event.payload.properties))
      if (!change || !event.directory) return
      const location = { directory: event.directory, ...(event.workspace ? { workspace: event.workspace } : {}) }
      const key = locationKey(location)
      locations.set(key, location)
      busy.delete(change.sessionID)
      if (BUSY.has(change.status.type)) {
        busy.set(change.sessionID, key)
        return
      }
      // An idle session has nothing left to ask. A prompt it never announced an answer to (disposing a directory ends
      // its prompts silently) must not hide the session's next run.
      for (const entry of waiting) if (entry[1] === change.sessionID) waiting.delete(entry[0])
      return
    }
    if (ASKED.has(type)) {
      const request = Option.getOrUndefined(Schema.decodeUnknownOption(Request)(event.payload.properties))
      if (request) waiting.set(request.id, request.sessionID)
      return
    }
    if (ANSWERED.has(type)) {
      const answered = Option.getOrUndefined(Schema.decodeUnknownOption(AnsweredProperties)(event.payload.properties))
      if (answered) waiting.delete(answered.requestID)
      return
    }
    if (type !== "server.instance.disposed") return
    const disposed = Option.getOrUndefined(Schema.decodeUnknownOption(DisposedProperties)(event.payload.properties))
    if (!disposed) return
    // A disposed directory runs nothing, and asking it for statuses on the next connection would start it again.
    for (const entry of locations) if (entry[1].directory === disposed.directory) locations.delete(entry[0])
    for (const entry of busy) if (!locations.has(entry[1])) busy.delete(entry[0])
    for (const entry of waiting) if (!busy.has(entry[1])) waiting.delete(entry[0])
  }

  // Events that arrive while the seed is in flight wait in the stream and apply after it, in order, so the newest
  // word on each session wins. A directory that cannot answer is left out rather than failing the connection, so one
  // bad directory never keeps the others from being followed; its sessions count again from their next status.
  const seed = async (signal: AbortSignal) => {
    const answers = await Promise.allSettled(
      [...locations].map(async (entry) => {
        const limited = AbortSignal.any([signal, AbortSignal.timeout(SEED_TIMEOUT_MS)])
        const both = await Promise.all([
          input.source.statuses(entry[1], limited),
          input.source.requests(entry[1], limited),
        ])
        return { key: entry[0], statuses: both[0], requests: both[1] }
      }),
    )
    signal.throwIfAborted()
    const failed = answers.flatMap((answer) => (answer.status === "rejected" ? [answer.reason] : []))
    if (failed.length > 0)
      input.log?.("keep awake: some directories could not report their sessions", {
        directories: failed.length,
        error: String(failed[0]),
      })
    busy.clear()
    waiting.clear()
    answers.forEach((answer) => {
      if (answer.status === "rejected") return
      Object.entries(answer.value.statuses)
        .filter((entry) => BUSY.has(entry[1].type))
        .forEach((entry) => busy.set(entry[0], answer.value.key))
      answer.value.requests.forEach((request) => waiting.set(request.id, request.sessionID))
    })
  }

  const connect = async () => {
    const controller = new AbortController()
    attempt = controller
    activeAt = Date.now()
    let ready = false
    // Leaving the loop by a throw (a seed that was aborted) leaves the connection open unless it is aborted here, and
    // once `attempt` moves on nothing else could.
    try {
      for await (const event of input.source.events(controller.signal)) {
        activeAt = Date.now()
        if (event.payload.type === "server.connected") {
          await seed(controller.signal)
          ready = true
          seeded += 1
        }
        handle(event)
        if (ready) heardAt = Date.now()
        apply()
      }
    } finally {
      controller.abort()
    }
  }

  const run = async () => {
    let failures = 0
    while (!stopped) {
      const before = seeded
      await connect().catch((error: unknown) => {
        if (stopped || failures > 0) return
        input.log?.("keep awake: engine event stream failed", { error: String(error) })
      })
      attempt = undefined
      failures = seeded > before ? 0 : failures + 1
      apply()
      if (stopped) return
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryMs * 2 ** failures, RETRY_MAX_MS)).unref())
    }
  }

  const watchdog = setInterval(
    () => {
      // A connection that stays open but says nothing, not even a heartbeat, is as good as dropped.
      if (attempt && Date.now() - activeAt > silenceMs) attempt.abort()
      apply()
    },
    Math.min(silenceMs / 4, stalledMs / 4, WATCHDOG_MAX_MS),
  )
  watchdog.unref()
  void run()

  return {
    stop() {
      stopped = true
      clearInterval(watchdog)
      attempt?.abort()
      apply()
    },
  }
}

/** The local engine's event stream, session statuses and prompts, over its authenticated loopback HTTP server. */
export function engineEventSource(connection: { url: string; username: string; password: string }): KeepAwakeSource {
  const authorization = `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`
  const read = async (path: string, location: KeepAwakeLocation, signal: AbortSignal) => {
    const url = new URL(path, connection.url)
    url.searchParams.set("directory", location.directory)
    if (location.workspace) url.searchParams.set("workspace", location.workspace)
    const response = await fetch(url, { headers: { authorization }, signal })
    const body = await response.text()
    if (!response.ok) throw new Error(`The engine's ${path} route answered ${response.status}.`)
    return body
  }
  return {
    async *events(signal) {
      // However this generator ends, a consumer that stopped reading included (return() runs only this finally), the
      // connection must close, or the engine keeps queueing every event for it. Aborting the request is what closes it
      // everywhere: cancelling the body leaves the socket open under Bun.
      const done = new AbortController()
      try {
        const response = await fetch(new URL("/global/event", connection.url), {
          headers: { authorization, accept: "text/event-stream" },
          signal: AbortSignal.any([signal, done.signal]),
        })
        if (!response.ok || !response.body) throw new Error(`The engine's event stream answered ${response.status}.`)
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ""
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) return
          const blocks = (buffer + chunk.value).split("\n\n")
          buffer = blocks.pop() ?? ""
          yield* blocks.flatMap((block) => {
            const data = block
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5))
              .join("\n")
            return Option.toArray(Schema.decodeUnknownOption(Schema.fromJsonString(KeepAwakeEvent))(data))
          })
        }
      } finally {
        done.abort()
      }
    },
    statuses: async (location, signal) =>
      Schema.decodeUnknownPromise(Schema.fromJsonString(Statuses))(await read("/session/status", location, signal)),
    requests: async (location, signal) =>
      (
        await Promise.all(
          ["/permission", "/question"].map(async (path) =>
            Schema.decodeUnknownPromise(Schema.fromJsonString(Requests))(await read(path, location, signal)),
          ),
        )
      ).flat(),
  }
}

function locationKey(location: KeepAwakeLocation) {
  return `${location.workspace ?? ""}\n${location.directory}`
}
