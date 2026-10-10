import { describe, expect, test } from "bun:test"

import {
  engineEventSource,
  startKeepAwake,
  type KeepAwakeEvent,
  type KeepAwakeLocation,
  type KeepAwakeSource,
} from "./keep-awake"

// An engine with the global event stream and per-directory status route the desktop's keep-awake reads. Every
// connection opens with server.connected, as the real one does.
function engine() {
  const statuses = new Map<string, Record<string, { type: string }>>()
  const requests = new Map<string, { id: string; sessionID: string }[]>()
  const failing = new Set<string>()
  const streams: ReturnType<typeof stream>[] = []
  const asked: KeepAwakeLocation[] = []
  const state = { refuse: false, unreadable: false }
  const source: KeepAwakeSource = {
    events(signal) {
      if (state.refuse) return refused()
      const next = stream(signal)
      next.push({ payload: { type: "server.connected", properties: {} } })
      streams.push(next)
      return next.events
    },
    async statuses(location) {
      asked.push(location)
      if (state.unreadable || failing.has(location.directory)) throw new Error("status route failed")
      return statuses.get(location.directory) ?? {}
    },
    async requests(location) {
      return requests.get(location.directory) ?? []
    },
  }
  return {
    source,
    statuses,
    requests,
    failing,
    streams,
    asked,
    state,
    current: () => streams[streams.length - 1]!,
    status: (sessionID: string, type: string, directory = "/repo") =>
      ({ directory, payload: { type: "session.status", properties: { sessionID, status: { type } } } }) as const,
    event: (type: string, properties: Record<string, unknown>, directory = "/repo") =>
      ({ directory, payload: { type, properties } }) as const,
  }
}

function stream(signal: AbortSignal) {
  const queue: KeepAwakeEvent[] = []
  const state = { ended: false, wake: undefined as (() => void) | undefined }
  const notify = () => {
    state.wake?.()
    state.wake = undefined
  }
  signal.addEventListener("abort", notify)
  return {
    signal,
    push(event: KeepAwakeEvent) {
      queue.push(event)
      notify()
    },
    end() {
      state.ended = true
      notify()
    },
    events: (async function* () {
      while (true) {
        if (signal.aborted) throw new DOMException("The connection was aborted.", "AbortError")
        const next = queue.shift()
        if (next) {
          yield next
          continue
        }
        if (state.ended) return
        await new Promise<void>((resolve) => {
          state.wake = resolve
        })
      }
    })(),
  }
}

async function* refused(): AsyncGenerator<KeepAwakeEvent> {
  throw new Error("connection refused")
}

function power() {
  const active = new Set<number>()
  const counts = { started: 0 }
  return {
    active,
    counts,
    blocker: {
      start() {
        counts.started += 1
        active.add(counts.started)
        return counts.started
      },
      stop(id: number) {
        active.delete(id)
      },
    },
  }
}

async function until(condition: () => boolean, ms = 2_000) {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) throw new Error("condition never held")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("startKeepAwake", () => {
  test("holds the blocker while any session is busy or retrying and releases it once none is", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker })
    await until(() => fake.streams.length === 1)

    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)
    fake.current().push(fake.status("ses_b", "retry", "/other"))
    fake.current().push(fake.status("ses_a", "idle"))
    await pause(20)
    expect(blocker.active.size).toBe(1)

    fake.current().push(fake.status("ses_b", "idle", "/other"))
    await until(() => blocker.active.size === 0)
    expect(blocker.counts.started).toBe(1)
    keepAwake.stop()
  })

  test("keeps holding through a short drop, then releases once the stream has been down past the limit", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker, silenceMs: 300, retryMs: 10 })
    await until(() => fake.streams.length === 1)
    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)

    fake.state.refuse = true
    fake.current().end()
    await pause(100)
    expect(blocker.active.size).toBe(1)
    await until(() => blocker.active.size === 0)
    keepAwake.stop()
  })

  test("drops a connection that has gone silent and releases what it last said", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker, silenceMs: 200, retryMs: 10 })
    await until(() => fake.streams.length === 1)
    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)

    fake.state.unreadable = true
    await until(() => fake.streams[0]!.signal.aborted)
    await until(() => fake.streams.length > 1)
    await until(() => blocker.active.size === 0)
    keepAwake.stop()
  })

  test("reseeds on reconnect from the status of every directory sessions ran in", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker, retryMs: 10 })
    await until(() => fake.streams.length === 1)
    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)

    // ses_a finished while the stream was down, so its idle event never arrived.
    fake.current().end()
    await until(() => fake.streams.length === 2)
    await until(() => blocker.active.size === 0)
    expect(fake.asked).toEqual([{ directory: "/repo" }])

    // ses_b started in the same directory during the next drop.
    fake.statuses.set("/repo", { ses_b: { type: "busy" }, ses_c: { type: "idle" } })
    fake.current().end()
    await until(() => fake.streams.length === 3)
    await until(() => blocker.active.size === 1)
    fake.current().push(fake.status("ses_b", "idle"))
    await until(() => blocker.active.size === 0)
    keepAwake.stop()
  })

  test("a reconnect whose directory cannot report never holds the blocker on old news", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker, retryMs: 10 })
    await until(() => fake.streams.length === 1)
    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)

    fake.state.unreadable = true
    fake.current().end()
    await until(() => fake.streams.length === 2)
    await until(() => blocker.active.size === 0)
    keepAwake.stop()
  })

  test("a directory that cannot report is left out, and neither fails the connection nor hides the others", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker, retryMs: 10 })
    await until(() => fake.streams.length === 1)
    fake.current().push(fake.status("ses_a", "idle", "/broken"))
    fake.current().push(fake.status("ses_b", "busy", "/repo"))
    await until(() => blocker.active.size === 1)

    fake.failing.add("/broken")
    fake.statuses.set("/repo", { ses_b: { type: "busy" } })
    fake.current().end()
    await until(() => fake.streams.length === 2)
    await pause(100)
    expect(fake.streams.length).toBe(2)
    expect(fake.streams[1]!.signal.aborted).toBe(false)
    expect(blocker.active.size).toBe(1)

    // The broken directory is asked again next time, and counts as soon as it reports a status.
    fake.current().push(fake.status("ses_a", "busy", "/broken"))
    fake.current().push(fake.status("ses_b", "idle", "/repo"))
    await pause(20)
    expect(blocker.active.size).toBe(1)
    keepAwake.stop()
  })

  test("does not count a session waiting on a permission or question prompt", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker })
    await until(() => fake.streams.length === 1)
    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)

    fake.current().push(fake.event("permission.asked", { id: "per_1", sessionID: "ses_a", permission: "bash" }))
    await until(() => blocker.active.size === 0)
    fake.current().push(fake.event("permission.replied", { sessionID: "ses_a", requestID: "per_1", reply: "once" }))
    await until(() => blocker.active.size === 1)

    fake.current().push(fake.event("question.asked", { id: "que_1", sessionID: "ses_a", questions: [] }))
    await until(() => blocker.active.size === 0)
    fake.current().push(fake.event("question.rejected", { sessionID: "ses_a", requestID: "que_1" }))
    await until(() => blocker.active.size === 1)

    fake.current().push(fake.event("question.asked", { id: "que_2", sessionID: "ses_a", questions: [] }))
    await until(() => blocker.active.size === 0)
    fake.current().push(fake.event("question.replied", { sessionID: "ses_a", requestID: "que_2", answers: [] }))
    await until(() => blocker.active.size === 1)
    keepAwake.stop()
  })

  test("a prompt that ended without an answer does not hide the session's next run", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker })
    await until(() => fake.streams.length === 1)
    fake.current().push(fake.status("ses_a", "busy"))
    fake.current().push(fake.event("permission.asked", { id: "per_1", sessionID: "ses_a", permission: "bash" }))
    await until(() => blocker.active.size === 0)

    // Disposing the directory ends its prompts without announcing an answer.
    fake.current().push(fake.event("server.instance.disposed", { directory: "/repo" }))
    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)

    fake.current().push(fake.event("question.asked", { id: "que_1", sessionID: "ses_a", questions: [] }))
    await until(() => blocker.active.size === 0)
    fake.current().push(fake.status("ses_a", "idle"))
    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)
    keepAwake.stop()
  })

  test("reads the prompts already waiting on the user when it reconnects", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker, retryMs: 10 })
    await until(() => fake.streams.length === 1)
    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)

    // The prompt was asked while the stream was down.
    fake.statuses.set("/repo", { ses_a: { type: "busy" } })
    fake.requests.set("/repo", [{ id: "per_1", sessionID: "ses_a" }])
    fake.current().end()
    await until(() => fake.streams.length === 2)
    await until(() => blocker.active.size === 0)

    // It was answered during the next drop.
    fake.requests.set("/repo", [])
    fake.current().end()
    await until(() => fake.streams.length === 3)
    await until(() => blocker.active.size === 1)
    keepAwake.stop()
  })

  test("a parent waiting on a subagent's unanswered prompt is held only until nothing has moved for a while", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker, stalledMs: 200 })
    await until(() => fake.streams.length === 1)
    fake.current().push(fake.status("ses_parent", "busy"))
    fake.current().push(fake.status("ses_child", "busy"))
    fake.current().push(fake.event("permission.asked", { id: "per_1", sessionID: "ses_child", permission: "bash" }))
    await until(() => blocker.active.size === 1)

    await until(() => blocker.active.size === 0)
    // Progress anywhere, such as a background subagent writing its reply, counts again.
    fake.current().push(fake.event("message.part.updated", { sessionID: "ses_other" }))
    await until(() => blocker.active.size === 1)
    await until(() => blocker.active.size === 0)

    fake.current().push(fake.event("permission.replied", { sessionID: "ses_child", requestID: "per_1", reply: "once" }))
    await until(() => blocker.active.size === 1)
    await pause(300)
    expect(blocker.active.size).toBe(1)
    keepAwake.stop()
  })

  test("forgets a disposed directory and does not ask it for statuses again", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker, retryMs: 10 })
    await until(() => fake.streams.length === 1)
    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)

    fake.current().push({
      directory: "/repo",
      payload: { type: "server.instance.disposed", properties: { directory: "/repo" } },
    })
    await until(() => blocker.active.size === 0)
    fake.current().end()
    await until(() => fake.streams.length === 2)
    await pause(20)
    expect(fake.asked).toEqual([])
    keepAwake.stop()
  })

  test("stop releases the blocker and closes the stream", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker })
    await until(() => fake.streams.length === 1)
    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)

    keepAwake.stop()
    expect(blocker.active.size).toBe(0)
    expect(fake.current().signal.aborted).toBe(true)
  })
})

describe("engineEventSource", () => {
  test("reads the engine's authenticated event stream and status route", async () => {
    const encoder = new TextEncoder()
    const requests: { path: string; authorization: string | null; directory: string | null }[] = []
    const sse: { controller?: ReadableStreamDefaultController<Uint8Array> } = {}
    // Framed as the engine's SSE encoder frames them, and split mid-event the way a socket may deliver them.
    const send = (data: unknown) => {
      const frame = encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
      sse.controller?.enqueue(frame.slice(0, 7))
      sse.controller?.enqueue(frame.slice(7))
    }
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url)
        requests.push({
          path: url.pathname,
          authorization: request.headers.get("authorization"),
          directory: url.searchParams.get("directory"),
        })
        if (url.pathname === "/session/status") return Response.json({ ses_b: { type: "busy" } })
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              sse.controller = controller
              send({ payload: { id: "evt_1", type: "server.connected", properties: {} } })
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const blocker = power()
    const keepAwake = startKeepAwake({
      source: engineEventSource({ url: server.url.href, username: "vector", password: "placeholder-password" }),
      blocker: blocker.blocker,
    })

    await until(() => sse.controller !== undefined)
    send({
      directory: "/repo",
      payload: { id: "evt_2", type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } },
    })
    await until(() => blocker.active.size === 1)
    send({
      directory: "/repo",
      payload: { id: "evt_3", type: "session.status", properties: { sessionID: "ses_a", status: { type: "idle" } } },
    })
    await until(() => blocker.active.size === 0)
    keepAwake.stop()

    expect(requests).toEqual([
      {
        path: "/global/event",
        authorization: `Basic ${Buffer.from("vector:placeholder-password").toString("base64")}`,
        directory: null,
      },
    ])
  })

  test("asks each known directory for its statuses and the prompts waiting on the user", async () => {
    const seen: { path: string; directory: string | null; workspace: string | null }[] = []
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url)
        seen.push({
          path: url.pathname,
          directory: url.searchParams.get("directory"),
          workspace: url.searchParams.get("workspace"),
        })
        if (url.pathname === "/permission")
          return Response.json([{ id: "per_1", sessionID: "ses_a", permission: "bash", patterns: ["ls"] }])
        if (url.pathname === "/question") return Response.json([{ id: "que_1", sessionID: "ses_b", questions: [] }])
        return Response.json({ ses_a: { type: "retry", attempt: 1, message: "rate limited", next: 2 } })
      },
    })
    const source = engineEventSource({ url: server.url.href, username: "vector", password: "placeholder-password" })
    const location = { directory: "/repo", workspace: "wrk_1" }
    expect(await source.statuses(location, new AbortController().signal)).toEqual({ ses_a: { type: "retry" } })
    expect(await source.requests(location, new AbortController().signal)).toEqual([
      { id: "per_1", sessionID: "ses_a" },
      { id: "que_1", sessionID: "ses_b" },
    ])
    expect(seen).toEqual(
      ["/session/status", "/permission", "/question"].map((path) => ({ path, directory: "/repo", workspace: "wrk_1" })),
    )
  })

  test("closes the connection when the reader stops early", async () => {
    const state = { opened: 0, closed: 0 }
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        state.opened += 1
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ payload: { type: "x" } })}\n\n`))
            },
            cancel() {
              state.closed += 1
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const source = engineEventSource({ url: server.url.href, username: "vector", password: "placeholder-password" })
    for await (const event of source.events(new AbortController().signal)) {
      expect(event.payload.type).toBe("x")
      break
    }
    await until(() => state.closed === 1)
    expect(state.opened).toBe(1)
  })

  test("a directory whose status route keeps failing leaves no connection open", async () => {
    const state = { opened: 0, closed: 0 }
    const encoder = new TextEncoder()
    const frame = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        if (new URL(request.url).pathname !== "/global/event") return new Response("broken", { status: 500 })
        state.opened += 1
        const first = state.opened === 1
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(frame({ payload: { type: "server.connected", properties: {} } }))
              if (!first) return
              // The first connection teaches keep-awake a directory, then drops.
              controller.enqueue(
                frame({
                  directory: "/repo",
                  payload: { type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } },
                }),
              )
              controller.close()
            },
            cancel() {
              state.closed += 1
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const blocker = power()
    const keepAwake = startKeepAwake({
      source: engineEventSource({ url: server.url.href, username: "vector", password: "placeholder-password" }),
      blocker: blocker.blocker,
      retryMs: 10,
    })

    await until(() => state.opened === 2)
    await pause(300)
    expect(state.opened).toBe(2)
    expect(blocker.active.size).toBe(0)

    keepAwake.stop()
    await until(() => state.closed === 1)
  })
})
