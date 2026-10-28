import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Result } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerTransport } from "@/computer/transport"
import { FakeBridge } from "../lib/fake-bridge"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(ComputerTransport.node))
const envelope = { v: Computer.PROTOCOL, rootSessionID: "root", sessionID: "root", directory: "/project" } as const
const acquire = { ...envelope, command: "acquire", title: "Test task" } as const
const act = {
  ...envelope,
  command: "act",
  lease: 1,
  steps: [{ kind: "wait", ms: 0 }],
  settleMs: 0,
} as const satisfies Computer.BridgeRequest
const waiting: Computer.ComputerState = {
  phase: "waiting",
  backend: "local-macos",
  mode: "background",
  apps: [],
  queue: [],
  escStops: false,
  stopChord: "Control+Option+Escape",
  lease: 1,
  reduceMotion: false,
}

function bridge() {
  return Effect.acquireRelease(
    Effect.sync(() => FakeBridge.startComputer()),
    (server) => Effect.promise(() => server.close()),
  )
}

it.live("computer bridge authenticates the dedicated route and keeps one root-family lease", () =>
  Effect.gen(function* () {
    const server = yield* bridge()
    const transport = yield* ComputerTransport.Service
    yield* FakeBridge.withinComputer(
      server,
      Effect.gen(function* () {
        expect(yield* transport.request(acquire)).toEqual({ lease: 1 })
        expect(yield* transport.request({ ...acquire, sessionID: "child" })).toEqual({ lease: 1 })
        const other = { ...acquire, rootSessionID: "other", sessionID: "other" }
        expect(yield* transport.request(other)).toMatchObject({ code: "busy" })
        yield* transport.request({ ...envelope, rootSessionID: "other", sessionID: "other", command: "cancel" })
        expect(yield* transport.request(other)).toMatchObject({ code: "busy" })
        yield* transport.request({ ...envelope, command: "release", lease: 1 })
        expect(yield* transport.request(other)).toEqual({ lease: 2 })
        expect(server.commands()).toEqual(["acquire", "acquire", "acquire", "cancel", "acquire", "release", "acquire"])
      }),
    )
  }),
)

it.live("the fake computer capability route has reduced actions and requires its token and protocol", () =>
  Effect.gen(function* () {
    const server = yield* bridge()
    const url = `${server.url}${Computer.BRIDGE.capabilitiesPath}`
    const unauthorized = yield* Effect.promise(() => fetch(url))
    expect(unauthorized.status).toBe(401)
    const incompatible = yield* Effect.promise(() =>
      fetch(url, {
        headers: { authorization: `Bearer ${server.token}`, [Computer.BRIDGE.protocolHeader]: "2" },
      }),
    )
    expect(incompatible.status).toBe(426)
    const response = yield* Effect.promise(() =>
      fetch(url, {
        headers: { authorization: `Bearer ${server.token}`, [Computer.BRIDGE.protocolHeader]: "1" },
      }),
    )
    expect(response.status).toBe(200)
    expect(yield* Effect.promise(() => response.json())).toMatchObject({
      backend: "fake",
      actions: ["screenshot", "read_ui", "click"],
      features: { locked: false },
    })
  }),
)

it.live("a cancel without a lease removes only its queued root and never the active holder", () =>
  Effect.gen(function* () {
    const server = yield* bridge()
    const transport = yield* ComputerTransport.Service
    yield* FakeBridge.withinComputer(
      server,
      Effect.gen(function* () {
        expect(yield* transport.request(acquire)).toEqual({ lease: 1 })
        for (const rootSessionID of ["second", "third"]) {
          const response = yield* Effect.promise(() =>
            fetch(`${server.url}${Computer.BRIDGE.commandPath}`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${server.token}`,
                [Computer.BRIDGE.protocolHeader]: String(Computer.PROTOCOL),
                "content-type": "application/json",
              },
              body: JSON.stringify({ ...acquire, rootSessionID, sessionID: rootSessionID, wait: true }),
            }),
          )
          expect(response.status).toBe(200)
          expect(yield* Effect.promise(() => response.json())).toMatchObject({ code: "busy" })
        }
        yield* transport.request({ ...envelope, command: "cancel" })
        expect(server.queued()).toEqual(["second", "third"])
        expect(yield* transport.request(acquire)).toEqual({ lease: 1 })
        yield* transport.request({ ...envelope, command: "cancel", rootSessionID: "second", sessionID: "second" })
        expect(server.queued()).toEqual(["third"])
        yield* transport.request({ ...envelope, command: "release", lease: 1 })
        expect(yield* transport.request({ ...acquire, rootSessionID: "third", sessionID: "third" })).toEqual({
          lease: 2,
        })
        expect(server.queued()).toEqual([])
      }),
    )
  }),
)

for (const status of [404, 426] as const) {
  it.live(`a missing or incompatible computer route is unavailable (${status})`, () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => FakeBridge.startComputer({ status })),
        (server) => Effect.promise(() => server.close()),
      )
      const transport = yield* ComputerTransport.Service
      const result = yield* FakeBridge.withinComputer(server, transport.request(acquire).pipe(Effect.result))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure.code).toBe("unavailable")
        expect(result.failure.message).not.toContain(server.token)
      }
      expect(server.calls()).toHaveLength(0)
    }),
  )
}

for (const status of [200, 409]) {
  it.live(`a computer refusal retains its typed code and message (HTTP ${status})`, () =>
    Effect.gen(function* () {
      const server = yield* bridge()
      server.answer(() => Response.json({ ok: false, code: "protected", error: "This app is protected." }, { status }))
      const transport = yield* ComputerTransport.Service
      const result = yield* FakeBridge.withinComputer(server, transport.request(act).pipe(Effect.result))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result))
        expect(result.failure).toMatchObject({ code: "protected", message: "This app is protected." })
    }),
  )
}

it.live("a pointer wait returns from act immediately, then awaitControl re-polls pending replies", () =>
  Effect.gen(function* () {
    const server = yield* bridge()
    const polls = { count: 0 }
    server.answer((call) => {
      if (call.body.command === "act")
        return { done: 0, state: waiting, waiting: { waitId: "pointer-1", reason: "pointer" } }
      if (call.body.command === "awaitControl") return { result: ++polls.count < 3 ? "pending" : "resumed" }
      throw new Error(`Unexpected command: ${call.body.command}`)
    })
    const transport = yield* ComputerTransport.Service
    yield* FakeBridge.withinComputer(
      server,
      Effect.gen(function* () {
        const response = yield* transport.request(act)
        expect(response.waiting).toEqual({ waitId: "pointer-1", reason: "pointer" })
        expect(server.commands()).toEqual(["act"])
        expect(
          yield* transport.request({ ...envelope, command: "awaitControl", lease: 1, waitId: "pointer-1" }),
        ).toEqual({ result: "resumed" })
        expect(polls.count).toBe(3)
      }),
    )
  }),
)

it.live("a waiting acquire re-polls busy replies until the desktop gives it a lease", () =>
  Effect.gen(function* () {
    const server = yield* bridge()
    const polls = { count: 0 }
    server.answer(() => (++polls.count < 3 ? { code: "busy", holder: { title: "First task" } } : { lease: 7 }))
    const transport = yield* ComputerTransport.Service
    expect(yield* FakeBridge.withinComputer(server, transport.request({ ...acquire, wait: true }))).toEqual({
      lease: 7,
    })
    expect(server.commands()).toEqual(["acquire", "acquire", "acquire"])
  }),
)

it.live("aborting an in-flight act sends cancel through the real HTTP client (INV-R4)", () =>
  Effect.gen(function* () {
    const server = yield* bridge()
    const entered = yield* Deferred.make<void>()
    server.answer((call) => {
      if (call.body.command === "cancel") return { ok: true }
      Deferred.doneUnsafe(entered, Effect.void)
      return new Promise<Response>((resolve) => {
        call.signal.addEventListener("abort", () => resolve(new Response(null, { status: 499 })), { once: true })
      })
    })
    const transport = yield* ComputerTransport.Service
    const controller = new AbortController()
    yield* FakeBridge.withinComputer(
      server,
      Effect.gen(function* () {
        const task = yield* transport.request(act, { signal: controller.signal }).pipe(Effect.result, Effect.forkChild)
        yield* awaitWithTimeout(Deferred.await(entered), "fake bridge never received act", "5 seconds")
        controller.abort()
        const result = yield* awaitWithTimeout(Fiber.join(task), "act did not cancel", "5 seconds")
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure.code).toBe("stopped")
        expect(server.commands()).toEqual(["act", "cancel"])
        expect(server.calls()[1].body).toMatchObject({ ...envelope, command: "cancel", lease: 1 })
      }),
    )
  }),
)
