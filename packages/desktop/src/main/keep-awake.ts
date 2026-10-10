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
 */

const SILENCE_MS = 5 * 60_000
const RETRY_MS = 1_000
const RETRY_MAX_MS = 30_000
const WATCHDOG_MAX_MS = 15_000
const SEED_TIMEOUT_MS = 10_000
const BUSY = new Set(["busy", "retry"])

const KeepAwakeEvent = Schema.Struct({
  directory: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  payload: Schema.Struct({ type: Schema.String, properties: Schema.optional(Schema.Unknown) }),
})
export type KeepAwakeEvent = typeof KeepAwakeEvent.Type

const Status = Schema.Struct({ type: Schema.String })
const Statuses = Schema.Record(Schema.String, Status)
const StatusProperties = Schema.Struct({ sessionID: Schema.String, status: Status })
const DisposedProperties = Schema.Struct({ directory: Schema.String })

export type KeepAwakeLocation = { directory: string; workspace?: string }

export type KeepAwakeSource = {
  /** The engine's global event stream. It ends or throws when the connection drops, and stops when `signal` aborts. */
  events(signal: AbortSignal): AsyncIterable<KeepAwakeEvent>
  /** The status of each session the engine has for one directory; sessions missing from it are idle. */
  statuses(location: KeepAwakeLocation, signal: AbortSignal): Promise<Readonly<Record<string, { type: string }>>>
}

export type PowerBlocker = { start(): number; stop(id: number): void }

export function startKeepAwake(input: {
  source: KeepAwakeSource
  blocker: PowerBlocker
  /** How long the stream may be down or silent before what it last said stops holding the blocker. */
  silenceMs?: number
  /** The first reconnect delay; it doubles after each failed attempt, up to 30 seconds. */
  retryMs?: number
  log?: (message: string, meta?: Record<string, unknown>) => void
}) {
  const silenceMs = input.silenceMs ?? SILENCE_MS
  const retryMs = input.retryMs ?? RETRY_MS
  // Each busy or retrying session, with the key of the location its status came from.
  const busy = new Map<string, string>()
  const locations = new Map<string, KeepAwakeLocation>()
  let held: number | undefined
  // When a seeded connection was last heard from; only that keeps the blocker held.
  let heardAt = Date.now()
  // When the current connection attempt was last heard from, seeded or not.
  let activeAt = Date.now()
  let seeded = 0
  let stopped = false
  let attempt: AbortController | undefined

  const apply = () => {
    const hold = !stopped && busy.size > 0 && Date.now() - heardAt <= silenceMs
    if (hold && held === undefined) {
      held = input.blocker.start()
      input.log?.("keep awake: holding off idle sleep", { sessions: busy.size })
    }
    if (!hold && held !== undefined) {
      input.blocker.stop(held)
      held = undefined
      input.log?.("keep awake: released", { sessions: busy.size })
    }
  }

  const handle = (event: KeepAwakeEvent) => {
    if (event.payload.type === "session.status") {
      const change = Option.getOrUndefined(Schema.decodeUnknownOption(StatusProperties)(event.payload.properties))
      if (!change || !event.directory) return
      const location = { directory: event.directory, ...(event.workspace ? { workspace: event.workspace } : {}) }
      const key = locationKey(location)
      locations.set(key, location)
      busy.delete(change.sessionID)
      if (BUSY.has(change.status.type)) busy.set(change.sessionID, key)
      return
    }
    if (event.payload.type !== "server.instance.disposed") return
    const disposed = Option.getOrUndefined(Schema.decodeUnknownOption(DisposedProperties)(event.payload.properties))
    if (!disposed) return
    // A disposed directory runs nothing, and asking it for statuses on the next connection would start it again.
    for (const entry of locations) if (entry[1].directory === disposed.directory) locations.delete(entry[0])
    for (const entry of busy) if (!locations.has(entry[1])) busy.delete(entry[0])
  }

  // Events that arrive while the seed is in flight wait in the stream and apply after it, in order, so the newest
  // word on each session wins.
  const seed = async (signal: AbortSignal) => {
    const answers = await Promise.all(
      [...locations].map((entry) =>
        input.source
          .statuses(entry[1], AbortSignal.any([signal, AbortSignal.timeout(SEED_TIMEOUT_MS)]))
          .then((statuses) => ({ key: entry[0], statuses })),
      ),
    )
    busy.clear()
    answers.forEach((answer) =>
      Object.entries(answer.statuses)
        .filter((entry) => BUSY.has(entry[1].type))
        .forEach((entry) => busy.set(entry[0], answer.key)),
    )
  }

  const connect = async () => {
    const controller = new AbortController()
    attempt = controller
    activeAt = Date.now()
    let ready = false
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
    Math.min(silenceMs / 4, WATCHDOG_MAX_MS),
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

/** The local engine's event stream and session statuses, over its authenticated loopback HTTP server. */
export function engineEventSource(connection: { url: string; username: string; password: string }): KeepAwakeSource {
  const authorization = `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`
  return {
    async *events(signal) {
      const response = await fetch(new URL("/global/event", connection.url), {
        headers: { authorization, accept: "text/event-stream" },
        signal,
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
    },
    async statuses(location, signal) {
      const url = new URL("/session/status", connection.url)
      url.searchParams.set("directory", location.directory)
      if (location.workspace) url.searchParams.set("workspace", location.workspace)
      const response = await fetch(url, { headers: { authorization }, signal })
      if (!response.ok) throw new Error(`The engine's session status answered ${response.status}.`)
      const statuses = Option.getOrUndefined(
        Schema.decodeUnknownOption(Schema.fromJsonString(Statuses))(await response.text()),
      )
      if (!statuses) throw new Error("The engine's session status could not be read.")
      return statuses
    },
  }
}

function locationKey(location: KeepAwakeLocation) {
  return `${location.workspace ?? ""}\n${location.directory}`
}
