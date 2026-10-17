import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Exit } from "effect"
import { TestClock } from "effect/testing"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import type { Task } from "@vectordevai/schema/task"
import { DesktopTasks } from "@/task/desktop"
import { TaskManager } from "@/task/manager"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import type { TaskPromptOps } from "@/tool/task"
import { disposeAllInstances, withTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(disposeAllInstances)
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      TaskManager.node,
      DesktopTasks.node,
      Session.node,
      Storage.node,
      BackgroundJob.node,
      EventV2Bridge.node,
    ]),
  ),
)
const observation = (parentSessionID: string, patch: Partial<Task.Info> = {}): Task.Info => ({
  id: "workspace:test",
  parentSessionID,
  source: "team",
  title: "Review parser",
  status: "running",
  startedAt: Date.now(),
  elapsedMs: 0,
  ownedPaths: ["parser.ts"],
  dependsOn: [],
  resultAvailable: false,
  attempt: 1,
  controls: { inspect: true, message: true, stop: true },
  ...patch,
})
const ops: TaskPromptOps = {
  cancel: () => Effect.void,
  resolvePromptParts: () => Effect.succeed([]),
  prompt: () => Effect.die("Unexpected model call"),
}

describe("authenticated desktop task registry", () => {
  it.effect("renewed lease expires at its new deadline and publishes disconnection without another task read", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const desktop = yield* DesktopTasks.Service
      const storage = yield* Storage.Service
      const events = yield* EventV2Bridge.Service
      const parent = yield* sessions.create()
      const registered = yield* desktop.register({ sessionID: parent.id, tasks: [observation(parent.id)] })
      const disconnected = yield* Deferred.make<void>()
      const unsubscribe = yield* events.listen((event) =>
        Effect.gen(function* () {
          if (event.type !== Session.Event.Updated.type) return
          const record = yield* storage.read<{ tasks: Task.Info[] }>(["task-bridge", parent.id])
          if (record.tasks[0]?.connection === "disconnected") yield* Deferred.succeed(disconnected, undefined)
        }).pipe(Effect.orDie),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* TestClock.adjust(40_000)
      yield* desktop.poll({ sessionID: parent.id, lease: registered.lease, timeout: 0 })
      yield* TestClock.adjust(36_000)
      const renewed = yield* storage.read<{ tasks: Task.Info[] }>(["task-bridge", parent.id])
      expect(renewed.tasks[0]?.connection).not.toBe("disconnected")
      expect(renewed.tasks[0]?.controls.message).toBe(true)
      yield* TestClock.adjust(40_000)
      yield* Deferred.await(disconnected)
      const record = yield* storage.read<{ tasks: Task.Info[] }>(["task-bridge", parent.id])
      expect(record.tasks[0]?.status).toBe("running")
      expect(record.tasks[0]?.connection).toBe("disconnected")
      expect(record.tasks[0]?.controls).toEqual({ inspect: true, message: false, stop: false })
    }).pipe(withTmpdirInstance()),
  )

  it.instance("incomplete desktop snapshots mark boards truncated and reject stop-all before admission", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const desktop = yield* DesktopTasks.Service
      const manager = yield* TaskManager.Service
      const parent = yield* sessions.create()
      const registered = yield* desktop.register({
        sessionID: parent.id,
        tasks: [observation(parent.id)],
        truncated: true,
      })
      expect((yield* manager.list({ sessionID: parent.id })).truncated).toBe(true)
      expect(
        yield* manager.stop({ sessionID: parent.id, all: true }, ops).pipe(
          Effect.match({
            onFailure: (error) => error.code,
            onSuccess: () => "unexpected success",
          }),
        ),
      ).toBe("invalid")
      expect(
        (yield* desktop.poll({ sessionID: parent.id, lease: registered.lease, timeout: 0 })).commands,
      ).toHaveLength(0)
      yield* desktop.register({
        sessionID: parent.id,
        lease: registered.lease,
        tasks: [observation(parent.id)],
        truncated: false,
      })
      expect((yield* manager.list({ sessionID: parent.id })).truncated).toBe(false)
    }),
  )

  it.instance("bounded boards prioritize active recent tasks across native descendants and desktop tasks", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const desktop = yield* DesktopTasks.Service
      const manager = yield* TaskManager.Service
      const parent = yield* sessions.create()
      const create = (parentID: typeof parent.id, status: "running" | "completed", startedAt: number) =>
        sessions.create({
          parentID,
          metadata: {
            subagent: {
              title: `Worker ${startedAt}`,
              agent: "general",
              kind: "subagent",
              custom: false,
              parentSessionID: parentID,
              parentMessageID: MessageID.ascending(),
              model: { providerID: "local-test", modelID: "fixture" },
              status,
              background: true,
              startedAt,
              attempt: 1,
              runtimeID: SubagentLifecycle.RUNTIME_ID,
            },
          },
        })
      const history = yield* create(parent.id, "completed", 2000)
      const older = yield* create(parent.id, "running", 500)
      const recent = yield* create(parent.id, "running", 1000)
      const direct = yield* manager.list({ sessionID: parent.id, limit: 2 })
      expect(direct.tasks.map((task) => task.id)).toEqual([recent.id, older.id])
      expect(direct.truncated).toBe(true)
      const descendant = yield* create(history.id, "running", 1500)
      expect(
        (yield* manager.list({ sessionID: parent.id, descendants: true, limit: 2 })).tasks.map((task) => task.id),
      ).toEqual([descendant.id, recent.id])
      yield* desktop.register({ sessionID: parent.id, tasks: [observation(parent.id, { startedAt: 1700 })] })
      const combined = yield* manager.list({ sessionID: parent.id, descendants: true, limit: 2 })
      expect(combined.tasks.map((task) => task.id)).toEqual(["workspace:test", descendant.id])
      expect(combined.truncated).toBe(true)
    }),
  )

  it.instance("keeps leases private, scopes controls, and marks abandoned observations disconnected", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const desktop = yield* DesktopTasks.Service
      const manager = yield* TaskManager.Service
      const storage = yield* Storage.Service
      const parent = yield* sessions.create()
      const stranger = yield* sessions.create()
      const registered = yield* desktop.register({ sessionID: parent.id, tasks: [observation(parent.id)] })
      expect(registered.lease.length).toBeGreaterThan(32)
      expect((yield* sessions.get(parent.id)).metadata).toBeUndefined()
      expect((yield* manager.list({ sessionID: parent.id })).tasks[0]?.id).toBe("workspace:test")
      expect((yield* manager.list({ sessionID: stranger.id })).tasks).toHaveLength(0)
      expect(
        Exit.isFailure(yield* desktop.poll({ sessionID: parent.id, lease: "wrong", timeout: 0 }).pipe(Effect.exit)),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* manager
            .stop({ sessionID: parent.id, taskIDs: ["workspace:test", "swarm:unknown"] }, ops)
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(
        (yield* desktop.poll({ sessionID: parent.id, lease: registered.lease, timeout: 0 })).commands,
      ).toHaveLength(0)
      yield* storage.update<{ runtimeID: string }>(["task-bridge", parent.id], (record) => {
        record.runtimeID = "previous-process"
      })
      const stopped = (yield* manager.list({ sessionID: parent.id })).tasks[0]!
      expect(stopped.status).toBe("running")
      expect(stopped.connection).toBe("disconnected")
      expect(stopped.controls.message).toBe(false)
      expect(
        Exit.isFailure(
          yield* desktop.poll({ sessionID: parent.id, lease: registered.lease, timeout: 0 }).pipe(Effect.exit),
        ),
      ).toBe(true)
      expect((yield* manager.wait({ sessionID: parent.id, taskIDs: [stopped.id], timeout: 0 })).timedOut).toBe(true)
      expect((yield* manager.inspect({ sessionID: parent.id, taskID: stopped.id })).truncated).toBe(true)
    }),
  )

  it.instance("rejects injected identities, expires leases, and drops commands after authenticated takeover", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const desktop = yield* DesktopTasks.Service
      const manager = yield* TaskManager.Service
      const storage = yield* Storage.Service
      const parent = yield* sessions.create()
      const other = yield* sessions.create()
      const task = observation(parent.id)
      expect(
        Exit.isFailure(
          yield* desktop.register({ sessionID: parent.id, tasks: [{ ...task, id: other.id }] }).pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* desktop
            .register({ sessionID: parent.id, tasks: [{ ...task, parentSessionID: other.id }] })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      const initial = yield* desktop.register({ sessionID: parent.id, tasks: [task] })
      const [request] = yield* Effect.all(
        [
          manager.inspect({ sessionID: parent.id, taskID: task.id }).pipe(Effect.exit),
          Effect.gen(function* () {
            expect((yield* desktop.poll({ sessionID: parent.id, lease: initial.lease })).commands).toHaveLength(1)
            const renewed = yield* desktop.register({ sessionID: parent.id, tasks: [task] })
            expect(renewed.lease).not.toBe(initial.lease)
            expect(
              Exit.isFailure(
                yield* desktop.poll({ sessionID: parent.id, lease: initial.lease, timeout: 0 }).pipe(Effect.exit),
              ),
            ).toBe(true)
            expect(
              (yield* desktop.poll({ sessionID: parent.id, lease: renewed.lease, timeout: 0 })).commands,
            ).toHaveLength(0)
            yield* storage.update<{ expiresAt: number }>(["task-bridge", parent.id], (record) => {
              record.expiresAt = 0
            })
            expect(
              Exit.isFailure(
                yield* desktop.poll({ sessionID: parent.id, lease: renewed.lease, timeout: 0 }).pipe(Effect.exit),
              ),
            ).toBe(true)
          }),
        ],
        { concurrency: "unbounded" },
      )
      expect(Exit.isFailure(request)).toBe(true)
      const result = yield* manager.wait({ sessionID: parent.id, taskIDs: [task.id], timeout: 15 })
      expect(result.timedOut).toBe(true)
      expect(result.tasks[0]?.status).toBe("running")
      expect(result.tasks[0]?.connection).toBe("disconnected")
    }),
  )

  it.instance("parent corrections travel through a bounded command and exact receipt", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const desktop = yield* DesktopTasks.Service
      const manager = yield* TaskManager.Service
      const parent = yield* sessions.create()
      const task = observation(parent.id)
      const registered = yield* desktop.register({ sessionID: parent.id, tasks: [task] })
      const results = yield* Effect.all(
        [
          manager.message(
            { sessionID: parent.id, taskID: task.id, text: "Please inspect the redirects too", delivery: "queue" },
            ops,
          ),
          Effect.gen(function* () {
            const polled = yield* desktop.poll({ sessionID: parent.id, lease: registered.lease })
            expect(polled.commands).toHaveLength(1)
            const command = polled.commands[0]!
            expect(command.sender).toBe(parent.id)
            expect(command.text).toBe("Please inspect the redirects too")
            expect(command.delivery).toBe("queue")
            const receipt = {
              sessionID: parent.id,
              lease: registered.lease,
              commandID: command.id,
              result: {
                taskID: task.id,
                messageID: "msg_accepted",
                delivery: "queue" as const,
                accepted: true as const,
              },
            }
            expect(
              Exit.isFailure(
                yield* desktop
                  .receipt({ ...receipt, result: { ...receipt.result, taskID: "workspace:unrelated" } })
                  .pipe(Effect.exit),
              ),
            ).toBe(true)
            expect((yield* desktop.receipt(receipt)).accepted).toBe(true)
            expect((yield* desktop.receipt(receipt)).accepted).toBe(true)
            expect(
              Exit.isFailure(
                yield* desktop.receipt({ ...receipt, error: "changed", result: undefined }).pipe(Effect.exit),
              ),
            ).toBe(true)
          }),
        ],
        { concurrency: "unbounded" },
      )
      expect(results[0].accepted).toBe(true)
      expect(
        (yield* desktop.poll({ sessionID: parent.id, lease: registered.lease, timeout: 0 })).commands,
      ).toHaveLength(0)
      expect(
        Exit.isFailure(
          yield* manager
            .message({ sessionID: parent.id, taskID: task.id, text: "🙂".repeat(1100) }, ops)
            .pipe(Effect.exit),
        ),
      ).toBe(true)
    }),
  )

  it.instance("native cancellation releases admission before nested cleanup finalizers", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const manager = yield* TaskManager.Service
      const parent = yield* sessions.create()
      const child = yield* sessions.create({
        parentID: parent.id,
        metadata: {
          subagent: {
            title: "Nested worker",
            agent: "general",
            kind: "subagent",
            custom: false,
            parentSessionID: parent.id,
            parentMessageID: MessageID.ascending(),
            model: { providerID: "local-test", modelID: "fixture" },
            status: "running",
            background: true,
            startedAt: Date.now(),
            attempt: 1,
            runtimeID: SubagentLifecycle.RUNTIME_ID,
          },
        },
      })
      const started = yield* Deferred.make<void>()
      const finalized = yield* Deferred.make<void>()
      yield* jobs.start({
        id: child.id,
        type: "task",
        run: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(SubagentLifecycle.controlLock.withPermits(1)(Deferred.succeed(finalized, undefined))),
        ),
      })
      yield* Deferred.await(started)
      const stopped = yield* manager
        .stop({ sessionID: parent.id, taskIDs: [child.id] }, ops)
        .pipe(Effect.timeoutOption(2000))
      expect(stopped._tag).toBe("Some")
      expect((yield* Deferred.await(finalized).pipe(Effect.timeoutOption(0)))._tag).toBe("Some")
      expect(SubagentLifecycle.stopping.has(child.id)).toBe(false)
    }),
  )

  for (const action of ["message", "stop"] as const)
    it.instance(`a pending desktop ${action} receipt does not block native cancellation`, () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const jobs = yield* BackgroundJob.Service
        const desktop = yield* DesktopTasks.Service
        const manager = yield* TaskManager.Service
        const parent = yield* sessions.create()
        const task = observation(parent.id)
        const registered = yield* desktop.register({ sessionID: parent.id, tasks: [task] })
        const child = yield* sessions.create({
          parentID: parent.id,
          metadata: {
            subagent: {
              title: "Native worker",
              agent: "general",
              kind: "subagent",
              custom: false,
              parentSessionID: parent.id,
              parentMessageID: MessageID.ascending(),
              model: { providerID: "local-test", modelID: "fixture" },
              status: "running",
              background: true,
              startedAt: Date.now(),
              attempt: 1,
              runtimeID: SubagentLifecycle.RUNTIME_ID,
            },
          },
        })
        yield* jobs.start({ id: child.id, type: "task", run: Effect.never })
        const request =
          action === "message"
            ? manager
                .message({ sessionID: parent.id, taskID: task.id, text: "Please check keyboard navigation" }, ops)
                .pipe(Effect.asVoid)
            : manager.stop({ sessionID: parent.id, taskIDs: [task.id] }, ops).pipe(Effect.asVoid)
        yield* Effect.all(
          [
            request,
            Effect.gen(function* () {
              const command = (yield* desktop.poll({ sessionID: parent.id, lease: registered.lease })).commands[0]!
              expect(command.action).toBe(action)
              const native = yield* manager
                .stop({ sessionID: parent.id, taskIDs: [child.id] }, ops)
                .pipe(Effect.timeoutOption(2000))
              expect(native._tag).toBe("Some")
              if (native._tag === "Some") expect(native.value.tasks[0]?.status).toBe("stopped")
              yield* desktop.receipt({
                sessionID: parent.id,
                lease: registered.lease,
                commandID: command.id,
                result:
                  action === "message"
                    ? { taskID: task.id, messageID: "msg_corrected", delivery: "steer", accepted: true }
                    : {
                        tasks: [
                          { ...task, status: "stopped", controls: { inspect: true, message: false, stop: false } },
                        ],
                      },
              })
            }),
          ],
          { concurrency: "unbounded" },
        )
      }),
    )

  it.instance("stop-all still stops live workers when their coordinator cannot accept stop", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const desktop = yield* DesktopTasks.Service
      const manager = yield* TaskManager.Service
      const parent = yield* sessions.create()
      const coordinator = observation(parent.id, {
        id: "swarm:review",
        groupID: "review",
        source: "swarm",
        status: "waiting_on_user",
        controls: { inspect: true, message: false, stop: false },
      })
      const worker = observation(parent.id, { id: "swarm:review:worker", groupID: "review", source: "swarm" })
      const stopped: Task.Info = {
        ...worker,
        status: "stopped",
        controls: { inspect: true, message: false, stop: false },
      }
      const registered = yield* desktop.register({ sessionID: parent.id, tasks: [coordinator, worker] })
      const [result] = yield* Effect.all(
        [
          manager.stop({ sessionID: parent.id, all: true }, ops),
          Effect.gen(function* () {
            const command = (yield* desktop.poll({ sessionID: parent.id, lease: registered.lease, timeout: 1000 }))
              .commands[0]
            expect(command?.taskID).toBe(worker.id)
            expect(command?.action).toBe("stop")
            yield* desktop.register({ sessionID: parent.id, lease: registered.lease, tasks: [coordinator, stopped] })
            yield* desktop.receipt({
              sessionID: parent.id,
              lease: registered.lease,
              commandID: command!.id,
              result: { tasks: [stopped] },
            })
          }),
        ],
        { concurrency: "unbounded" },
      )
      expect(result.tasks.find((task) => task.id === worker.id)?.status).toBe("stopped")
    }),
  )

  it.instance("wait wakes on durable desktop changes and returns truthful completion", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const desktop = yield* DesktopTasks.Service
      const manager = yield* TaskManager.Service
      const parent = yield* sessions.create()
      const task = observation(parent.id)
      const registered = yield* desktop.register({ sessionID: parent.id, tasks: [task] })
      expect((yield* manager.wait({ sessionID: parent.id, taskIDs: [task.id], timeout: 0 })).timedOut).toBe(true)
      const [finished] = yield* Effect.all(
        [
          manager.wait({ sessionID: parent.id, taskIDs: [task.id], timeout: 5000 }),
          desktop.register({
            sessionID: parent.id,
            lease: registered.lease,
            tasks: [{ ...task, status: "completed", controls: { inspect: true, message: false, stop: false } }],
          }),
        ],
        { concurrency: "unbounded" },
      )
      expect(finished.timedOut).toBe(false)
      expect(finished.tasks[0]?.status).toBe("completed")
    }),
  )
})
