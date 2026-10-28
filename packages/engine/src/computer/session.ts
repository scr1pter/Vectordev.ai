import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { makeGlobalNode } from "@vectordevai/core/effect/app-node"
import { EventV2 } from "@vectordevai/core/event"
import { serviceUse } from "@vectordevai/core/effect/service-use"
import { Computer } from "@vectordevai/schema/computer"
import { SessionStatusEvent } from "@vectordevai/schema/session-status-event"
import type { MessageID, SessionID } from "@/session/schema"
import { ComputerTransport } from "./transport"

export type Input = {
  rootSessionID: SessionID
  sessionID: SessionID
  directory: string
  signal?: AbortSignal
}

/** One task generation. Only the callback holding this root's FIFO may change its live state. */
export type State = {
  lease?: number
  frames: Computer.Frame[]
  /** Observed identities in the latest full frame, including desktop Always grants absent from the local cache. */
  visible: Computer.AppIdentity[]
  grants: Map<string, Computer.AskLevel>
  /** Conversation lifetime, shared by successive task generations. */
  denied: Set<string>
  denyMentions: Map<string, MessageID>
  actions: number
  activeMs: number
  screenshots: number
  failedMessageID?: MessageID
  lastScreenText?: string
  lastInspect?: Computer.InspectResult
  readonly signal: AbortSignal
}

export interface Interface {
  readonly serialized: <A, E, R>(
    input: Input,
    use: (state: State) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ComputerTransport.ComputerError, R>
  /** Drop remembered coordinates immediately without creating a task or waiting behind its FIFO. */
  readonly invalidate: (rootSessionID: SessionID) => Effect.Effect<void>
  /** Call outside serialized: it aborts and waits for the current callback to unwind. */
  readonly release: (rootSessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@vector/ComputerSession") {}
export const use = serviceUse(Service)

type Task = {
  state: State
  controller: AbortController
  input: Omit<Input, "signal">
  signals: Set<AbortSignal>
  workers: Set<Fiber.Fiber<unknown, unknown>>
  abort: () => void
  closing?: Deferred.Deferred<void>
}
type Root = {
  queue: Deferred.Deferred<void>[]
  denied: Set<string>
  denyMentions: Map<string, MessageID>
  task?: Task
  closing?: Deferred.Deferred<void>
}

/** Zoom images never enter this full-frame ring. A stopped generation cannot install a late frame. */
export function remember(state: State, frame: Computer.Frame) {
  if (state.signal.aborted) return false
  state.frames.push(frame)
  if (state.frames.length > 4) state.frames.splice(0, state.frames.length - 4)
  return true
}

export function invalidate(state: State) {
  state.frames.length = 0
  state.visible.length = 0
  state.lastScreenText = undefined
  state.lastInspect = undefined
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const transport = yield* ComputerTransport.Service
    const events = yield* EventV2.Service
    const scope = yield* Scope.Scope
    // The desktop lock belongs to a root conversation across directories, not to an InstanceState scope.
    const roots = new Map<SessionID, Root>()

    const finish = Effect.fn("ComputerSession.finish")(function* (root: Root, task: Task) {
      if (task.closing) return yield* Deferred.await(task.closing)
      if (root.task !== task) return
      const closing = yield* Deferred.make<void>()
      task.closing = closing
      root.closing = closing
      root.task = undefined
      for (const signal of task.signals) signal.removeEventListener("abort", task.abort)
      task.signals.clear()
      task.controller.abort()
      task.state.grants.clear()
      invalidate(task.state)
      yield* Fiber.interruptAll(task.workers)
      // Aborting the generation interrupts an unanswered ask or acquire before waiting for its FIFO holder.
      // Wait for that holder to unwind so a response already received cannot install a lease after cleanup.
      yield* exclusive(
        root,
        Effect.gen(function* () {
          const envelope = { v: Computer.PROTOCOL, ...task.input } as const
          const lease = task.state.lease
          yield* transport.request({ ...envelope, command: "cancel", ...(lease === undefined ? {} : { lease }) }).pipe(
            Effect.interruptible,
            Effect.timeout("5 seconds"),
            Effect.catchCause(() => Effect.void),
          )
          if (lease !== undefined)
            yield* transport.request({ ...envelope, command: "release", lease }).pipe(
              Effect.interruptible,
              Effect.timeout("5 seconds"),
              Effect.catchCause(() => Effect.void),
            )
          task.state.lease = undefined
          task.state.grants.clear()
          invalidate(task.state)
          task.state.actions = 0
          task.state.activeMs = 0
          task.state.screenshots = 0
          task.state.failedMessageID = undefined
        }),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            root.closing = undefined
            Deferred.doneUnsafe(closing, Effect.void)
          }),
        ),
      )
    }, Effect.uninterruptible)

    const release = Effect.fn("ComputerSession.release")(function* (rootSessionID: SessionID) {
      const root = roots.get(rootSessionID)
      if (!root) return
      if (root.task) return yield* finish(root, root.task)
      if (root.closing) yield* Deferred.await(root.closing)
    })

    const invalidateRoot = Effect.fn("ComputerSession.invalidate")((rootSessionID: SessionID) =>
      Effect.sync(() => {
        const task = roots.get(rootSessionID)?.task
        if (task) invalidate(task.state)
      }),
    )

    const serialized: Interface["serialized"] = Effect.fn("ComputerSession.serialized")(function* <A, E, R>(
      input: Input,
      run: (state: State) => Effect.Effect<A, E, R>,
    ) {
      if (input.rootSessionID !== input.sessionID)
        return yield* new ComputerTransport.ComputerError({
          code: "unavailable",
          message: "Computer use requires the attended root conversation.",
        })
      if (input.signal?.aborted) return yield* stopped()
      const root: Root =
        roots.get(input.rootSessionID) ??
        ({
          queue: [],
          denied: new Set<string>(),
          denyMentions: new Map<string, MessageID>(),
        } satisfies Root)
      roots.set(input.rootSessionID, root)
      if (root.closing) yield* Deferred.await(root.closing)
      if (input.signal?.aborted) return yield* stopped()
      const fresh = !root.task
      if (!root.task) {
        const controller = new AbortController()
        root.task = {
          controller,
          abort: () => controller.abort(),
          signals: new Set(),
          workers: new Set(),
          input: { rootSessionID: input.rootSessionID, sessionID: input.sessionID, directory: input.directory },
          state: {
            frames: [],
            visible: [],
            grants: new Map(),
            denied: root.denied,
            denyMentions: root.denyMentions,
            actions: 0,
            activeMs: 0,
            screenshots: 0,
            signal: controller.signal,
          },
        }
      }
      const task = root.task
      // A turn may abort while the model is thinking between computer calls. Keep watching until task cleanup.
      if (fresh)
        yield* aborted(task.state.signal).pipe(
          Effect.catch(() => finish(root, task)),
          Effect.forkIn(scope),
        )
      if (task.input.directory !== input.directory)
        return yield* new ComputerTransport.ComputerError({
          code: "failed",
          message: "The computer task belongs to another workspace.",
        })
      // Capture the generation before queueing. A call already queued when the task ends cannot join its successor.
      if (input.signal && !task.signals.has(input.signal)) {
        task.signals.add(input.signal)
        input.signal.addEventListener("abort", task.abort, { once: true })
      }
      if (input.signal?.aborted) task.abort()
      return yield* Effect.acquireUseRelease(
        exclusive(
          root,
          Effect.suspend(
            (): Effect.Effect<A, E | ComputerTransport.ComputerError, R> =>
              task.state.signal.aborted ? stopped() : run(task.state),
          ),
        ).pipe(
          // acquireUseRelease masks its acquisition; the callback itself must remain interruptible.
          Effect.interruptible,
          Effect.forkChild,
          Effect.tap((worker) =>
            Effect.sync(() => {
              task.workers.add(worker)
            }),
          ),
        ),
        (worker) =>
          Effect.gen(function* () {
            const result = yield* Fiber.await(worker)
            if (task.state.signal.aborted) return yield* stopped()
            return yield* result
          }),
        (worker, exit) =>
          Effect.gen(function* () {
            if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) task.abort()
            yield* Fiber.interrupt(worker)
            task.workers.delete(worker)
            if (task.state.signal.aborted) yield* finish(root, task)
          }),
      )
    })

    const unsubscribe = yield* events.listen((event) => {
      // SessionStatus publishes a deprecated Idle event after Status; consuming both could stop a new task.
      if (event.type !== SessionStatusEvent.Status.type) return Effect.void
      const data = event.data
      if (
        typeof data !== "object" ||
        data === null ||
        !("status" in data) ||
        typeof data.status !== "object" ||
        data.status === null ||
        !("type" in data.status) ||
        data.status.type !== "idle"
      )
        return Effect.void
      if (!("sessionID" in data) || typeof data.sessionID !== "string") return Effect.void
      return release(data.sessionID as SessionID)
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...roots.values()],
        (root) => (root.task ? finish(root, root.task) : root.closing ? Deferred.await(root.closing) : Effect.void),
        { discard: true },
      ),
    )
    return Service.of({ serialized, invalidate: invalidateRoot, release })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [ComputerTransport.node, EventV2.node] })

/** Tickets reserve their position until exit, including the interval before an awakened waiter runs. */
function exclusive<A, E, R>(root: Root, effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const ticket = Deferred.makeUnsafe<void>()
      root.queue.push(ticket)
      if (root.queue.length === 1) Deferred.doneUnsafe(ticket, Effect.void)
      return ticket
    }),
    (ticket) => Deferred.await(ticket).pipe(Effect.andThen(effect)),
    (ticket) =>
      Effect.sync(() => {
        const index = root.queue.indexOf(ticket)
        if (index < 0) return
        root.queue.splice(index, 1)
        if (index === 0 && root.queue[0]) Deferred.doneUnsafe(root.queue[0], Effect.void)
      }),
  )
}

function stopped() {
  return new ComputerTransport.ComputerError({ code: "stopped", message: "The computer task was stopped." })
}

function aborted(signal: AbortSignal) {
  return Effect.callback<never, ComputerTransport.ComputerError>((resume) => {
    const stop = () => resume(stopped())
    if (signal.aborted) return stop()
    signal.addEventListener("abort", stop, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", stop))
  })
}

export * as ComputerSession from "./session"
