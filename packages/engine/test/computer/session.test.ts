import { expect } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Result } from "effect"
import { TestClock } from "effect/testing"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { EventV2 } from "@vectordevai/core/event"
import { Computer } from "@vectordevai/schema/computer"
import { SessionStatusEvent } from "@vectordevai/schema/session-status-event"
import { ComputerSession } from "@/computer/session"
import { ComputerTransport } from "@/computer/transport"
import { MessageID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(EventV2.node))
const input: ComputerSession.Input = {
  rootSessionID: SessionID.make("ses_computer_root"),
  sessionID: SessionID.make("ses_computer_root"),
  directory: "/computer-fixture",
}
const frame = (id: string): Computer.Frame => ({
  id,
  scope: "display",
  display: "main",
  bounds: { x: 0, y: 0, w: 1920, h: 1080 },
  scale: 1,
  image: { w: 1440, h: 810 },
  at: 1,
  hash: "0123456789abcdef",
})

function fixture<A, E, R>(
  body: (service: ComputerSession.Interface, calls: Computer.BridgeRequest[]) => Effect.Effect<A, E, R>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const calls: Computer.BridgeRequest[] = []
      const transport = ComputerTransport.Service.of({
        request: <Q extends Computer.BridgeRequest>(request: Q) =>
          Effect.sync(() => {
            if (request.command !== "cancel" && request.command !== "release")
              throw new Error("Unexpected session cleanup command")
            calls.push(request)
            return { ok: true } as ComputerTransport.Response<Q["command"]>
          }),
      })
      const context = yield* Layer.build(
        ComputerSession.layer.pipe(Layer.provide(Layer.succeed(ComputerTransport.Service, transport))),
      )
      return yield* body(Context.get(context, ComputerSession.Service), calls)
    }),
  )
}

it.effect("a root keeps task state until idle, preserving conversation denials for the next task", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const deniedAt = MessageID.make("msg_denied")
      const state = yield* sessions.serialized(input, (state) =>
        Effect.sync(() => {
          state.lease = 7
          state.grants.set("macos:com.example.App", "interact")
          state.denied.add("macos:com.example.Denied")
          state.denyMentions.set("macos:com.example.Denied", deniedAt)
          state.actions = 10
          state.activeMs = 1000
          state.screenshots = 2
          state.failedMessageID = deniedAt
          for (let index = 0; index < 6; index++) ComputerSession.remember(state, frame(String(index)))
          return state
        }),
      )
      expect(state.frames.map((frame) => frame.id)).toEqual(["2", "3", "4", "5"])
      expect(yield* sessions.serialized(input, Effect.succeed)).toBe(state)
      yield* events.publish(SessionStatusEvent.Status, { sessionID: input.sessionID, status: { type: "busy" } })
      expect(calls).toHaveLength(0)
      yield* events.publish(SessionStatusEvent.Status, { sessionID: input.sessionID, status: { type: "idle" } })
      expect(calls.map((call) => call.command)).toEqual(["cancel", "release"])
      expect(calls).toMatchObject([{ lease: 7 }, { lease: 7 }])
      expect(state.signal.aborted).toBe(true)
      expect(state.lease).toBeUndefined()
      expect(state.frames).toHaveLength(0)
      expect(state.grants.size).toBe(0)
      expect(state.actions).toBe(0)
      expect(state.activeMs).toBe(0)
      expect(state.screenshots).toBe(0)
      expect(state.failedMessageID).toBeUndefined()
      const next = yield* sessions.serialized(input, Effect.succeed)
      expect(next).not.toBe(state)
      expect([...next.denied]).toEqual(["macos:com.example.Denied"])
      expect(next.denyMentions.get("macos:com.example.Denied")).toBe(deniedAt)
      expect(next.grants.size).toBe(0)
      expect(next.frames).toHaveLength(0)
      yield* sessions.release(input.rootSessionID)
    }),
  ),
)

it.effect("the deprecated idle event cannot end a successor task", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      yield* sessions.serialized(input, (state) =>
        Effect.sync(() => {
          state.lease = 1
        }),
      )
      yield* events.publish(SessionStatusEvent.Status, { sessionID: input.sessionID, status: { type: "idle" } })
      const next = yield* sessions.serialized(input, (state) =>
        Effect.sync(() => {
          state.lease = 2
          return state
        }),
      )
      yield* events.publish(SessionStatusEvent.Idle, { sessionID: input.sessionID })
      expect(next.signal.aborted).toBe(false)
      expect(next.lease).toBe(2)
      expect(calls.map((call) => call.command)).toEqual(["cancel", "release"])
      yield* sessions.release(input.rootSessionID)
    }),
  ),
)

it.effect("same-root callbacks run in FIFO order while another root can proceed", () =>
  fixture((sessions) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const order: number[] = []
      const first = yield* sessions
        .serialized(input, () =>
          Effect.gen(function* () {
            order.push(1)
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const second = yield* sessions
        .serialized(input, () =>
          Effect.sync(() => {
            order.push(2)
          }),
        )
        .pipe(Effect.forkChild)
      const third = yield* sessions
        .serialized(input, () =>
          Effect.sync(() => {
            order.push(3)
          }),
        )
        .pipe(Effect.forkChild)
      yield* TestClock.adjust(0)
      expect(order).toEqual([1])
      const other = SessionID.make("ses_other_root")
      yield* sessions.serialized({ ...input, rootSessionID: other, sessionID: other }, () =>
        Effect.sync(() => {
          order.push(9)
        }),
      )
      yield* Deferred.succeed(release, undefined)
      // Arriving immediately after release must not barge ahead of the two reserved queue positions.
      const fourth = yield* sessions
        .serialized(input, () =>
          Effect.sync(() => {
            order.push(4)
          }),
        )
        .pipe(Effect.forkChild)
      yield* Effect.all([Fiber.join(first), Fiber.join(second), Fiber.join(third), Fiber.join(fourth)])
      expect(order).toEqual([1, 9, 2, 3, 4])
      yield* sessions.release(input.rootSessionID)
      yield* sessions.release(other)
    }),
  ),
)

it.effect("idle interrupts an unanswered callback and fails queued calls from that generation", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const entered = yield* Deferred.make<ComputerSession.State>()
      const first = yield* sessions
        .serialized(input, (state) =>
          Effect.gen(function* () {
            state.lease = 11
            state.grants.set("app", "interact")
            ComputerSession.remember(state, frame("old"))
            yield* Deferred.succeed(entered, state)
            return yield* Effect.never
          }),
        )
        .pipe(Effect.result, Effect.forkChild)
      const state = yield* Deferred.await(entered)
      let queuedRan = false
      const queued = yield* sessions
        .serialized(input, () =>
          Effect.sync(() => {
            queuedRan = true
          }),
        )
        .pipe(Effect.result, Effect.forkChild)
      yield* TestClock.adjust(0)
      yield* events.publish(SessionStatusEvent.Status, { sessionID: input.sessionID, status: { type: "idle" } })
      expect(Result.isFailure(yield* Fiber.join(first))).toBe(true)
      expect(Result.isFailure(yield* Fiber.join(queued))).toBe(true)
      expect(queuedRan).toBe(false)
      expect(state.frames).toHaveLength(0)
      expect(state.grants.size).toBe(0)
      expect(calls).toMatchObject([
        { command: "cancel", lease: 11 },
        { command: "release", lease: 11 },
      ])
      expect(ComputerSession.remember(state, frame("late"))).toBe(false)
      const next = yield* sessions.serialized(input, Effect.succeed)
      expect(next.signal.aborted).toBe(false)
      expect(next.frames).toHaveLength(0)
      expect(next.lease).toBeUndefined()
      yield* sessions.release(input.rootSessionID)
    }),
  ),
)

it.effect("abort during a queued acquire cancels only that root without inventing a lease", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      const controller = new AbortController()
      const entered = yield* Deferred.make<void>()
      const fiber = yield* sessions
        .serialized({ ...input, signal: controller.signal }, () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            return yield* Effect.never
          }),
        )
        .pipe(Effect.result, Effect.forkChild)
      yield* Deferred.await(entered)
      controller.abort()
      expect(Result.isFailure(yield* Fiber.join(fiber))).toBe(true)
      expect(calls).toEqual([{ v: Computer.PROTOCOL, ...input, command: "cancel" }])
    }),
  ),
)

it.effect("fiber interruption ends its root task and releases a known lease", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<ComputerSession.State>()
      const fiber = yield* sessions
        .serialized(input, (state) =>
          Effect.gen(function* () {
            state.lease = 13
            yield* Deferred.succeed(entered, state)
            return yield* Effect.never
          }),
        )
        .pipe(Effect.forkChild)
      const state = yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)
      yield* TestClock.adjust(0)
      expect(state.signal.aborted).toBe(true)
      expect(calls).toMatchObject([
        { command: "cancel", lease: 13 },
        { command: "release", lease: 13 },
      ])
    }),
  ),
)

it.effect("release captures a lease assigned while an in-flight callback unwinds", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<ComputerSession.State>()
      const response = yield* Deferred.make<void>()
      const fiber = yield* sessions
        .serialized(input, (state) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, state)
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                yield* Deferred.await(response)
                state.lease = 21
                expect(ComputerSession.remember(state, frame("late"))).toBe(false)
              }),
            )
          }),
        )
        .pipe(Effect.result, Effect.forkChild)
      const state = yield* Deferred.await(entered)
      const release = yield* sessions.release(input.rootSessionID).pipe(Effect.forkChild)
      yield* TestClock.adjust(0)
      expect(state.signal.aborted).toBe(true)
      yield* Deferred.succeed(response, undefined)
      yield* Fiber.join(release)
      expect(Result.isFailure(yield* Fiber.join(fiber))).toBe(true)
      expect(calls).toMatchObject([
        { command: "cancel", lease: 21 },
        { command: "release", lease: 21 },
      ])
      expect(state.lease).toBeUndefined()
    }),
  ),
)

it.effect("abort between completed computer calls releases the task without another call", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      const controller = new AbortController()
      const state = yield* sessions.serialized({ ...input, signal: controller.signal }, (state) =>
        Effect.sync(() => {
          state.lease = 23
          state.grants.set("app", "interact")
          return state
        }),
      )
      controller.abort()
      yield* TestClock.adjust(0)
      expect(state.signal.aborted).toBe(true)
      expect(state.grants.size).toBe(0)
      expect(state.lease).toBeUndefined()
      expect(calls).toMatchObject([
        { command: "cancel", lease: 23 },
        { command: "release", lease: 23 },
      ])
    }),
  ),
)

it.effect("a pre-aborted call and a child session cannot start a task", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      const controller = new AbortController()
      controller.abort()
      let ran = false
      const callback = () =>
        Effect.sync(() => {
          ran = true
        })
      const aborted = yield* sessions.serialized({ ...input, signal: controller.signal }, callback).pipe(Effect.result)
      const child = yield* sessions
        .serialized({ ...input, sessionID: SessionID.make("ses_child") }, callback)
        .pipe(Effect.result)
      expect(Result.isFailure(aborted)).toBe(true)
      expect(Result.isFailure(child)).toBe(true)
      expect(ran).toBe(false)
      expect(calls).toHaveLength(0)
    }),
  ),
)

it.effect("a root cannot move a live lease into another workspace", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      const state = yield* sessions.serialized(input, (state) =>
        Effect.sync(() => {
          state.lease = 25
          return state
        }),
      )
      const result = yield* sessions
        .serialized({ ...input, directory: "/other-workspace" }, () => Effect.die("must not enter"))
        .pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      expect(state.lease).toBe(25)
      expect(state.signal.aborted).toBe(false)
      yield* sessions.release(input.rootSessionID)
      expect(calls).toMatchObject([{ directory: input.directory }, { directory: input.directory }])
    }),
  ),
)

it.effect("closing the service releases task state and its desktop lease", () =>
  Effect.gen(function* () {
    const result = yield* fixture((sessions, calls) =>
      Effect.gen(function* () {
        const state = yield* sessions.serialized(input, (state) =>
          Effect.sync(() => {
            state.lease = 31
            return state
          }),
        )
        return { state, calls }
      }),
    )
    expect(result.state.signal.aborted).toBe(true)
    expect(result.state.lease).toBeUndefined()
    expect(result.calls).toMatchObject([
      { command: "cancel", lease: 31 },
      { command: "release", lease: 31 },
    ])
  }),
)

it.effect("frame invalidation clears screen observations without waiting for FIFO or ending the task", () =>
  fixture((sessions, calls) =>
    Effect.gen(function* () {
      yield* sessions.invalidate(SessionID.make("ses_unknown"))
      yield* sessions.serialized(input, (state) =>
        Effect.gen(function* () {
          ComputerSession.remember(state, frame("full"))
          state.lastScreenText = "Screen instructions"
          state.lastInspect = {
            app: {
              platform: "macos",
              bundleId: "com.example.App",
              apple: false,
              system: false,
              verified: true,
              name: "App",
            },
            category: "general",
            pid: 1,
            window: { id: "window", title: "Screen window" },
            clipboard: { agentOwned: true },
          }
          state.lease = 33
          state.visible.push(state.lastInspect.app)
          state.grants.set("app", "interact")
          // The callback still holds the FIFO; processor invalidation must never wait for it.
          yield* sessions.invalidate(input.rootSessionID)
          expect(state.frames).toHaveLength(0)
          expect(state.visible).toHaveLength(0)
          expect(state.lastScreenText).toBeUndefined()
          expect(state.lastInspect).toBeUndefined()
          expect(state.signal.aborted).toBe(false)
          expect(state.lease).toBe(33)
          expect(state.grants.get("app")).toBe("interact")
          expect(calls).toHaveLength(0)
        }),
      )
      yield* sessions.release(input.rootSessionID)
    }),
  ),
)
