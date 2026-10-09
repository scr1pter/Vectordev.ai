import { describe, expect } from "bun:test"
import { BackgroundJob } from "@vectordevai/core/background-job"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { it } from "./lib/effect"

const jobsLayer = LayerNode.compile(BackgroundJob.node)

describe("BackgroundJob", () => {
  it.live("tracks process-local work through explicit observation", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        metadata: { durable: false },
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      expect(job).toMatchObject({ type: "test", status: "running", metadata: { durable: false } })
      expect(yield* jobs.wait({ id: job.id, timeout: 0 })).toMatchObject({
        timedOut: true,
        info: { status: "running" },
      })

      yield* Deferred.succeed(latch, undefined)
      expect(yield* jobs.wait({ id: job.id })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "done" },
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("a run that fails with output settles as an error and keeps what it wrote", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        type: "test",
        run: Effect.fail(new BackgroundJob.RunFailed({ message: "rate limited", output: "partial notes" })),
      })

      expect(yield* jobs.wait({ id: job.id })).toMatchObject({
        timedOut: false,
        info: { status: "error", error: "rate limited", output: "partial notes" },
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("settles a running job as cancelled when its service shuts down", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const jobs = Context.get(yield* Layer.buildWithScope(jobsLayer, scope), BackgroundJob.Service)
      const job = yield* jobs.start({ type: "test", run: Effect.never })
      const waiter = yield* jobs.wait({ id: job.id }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Scope.close(scope, Exit.void)
      const settled = yield* Fiber.join(waiter).pipe(Effect.timeout("1 second"))
      expect(settled.info).toMatchObject({ id: job.id, status: "cancelled" })
    }),
  )

  it.live("publishes jobs before starting immediately settling work", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) => {
        const id = `job_immediate_start_${index}`
        return Effect.gen(function* () {
          const job = yield* jobs.start({
            id,
            type: "test",
            run: jobs
              .get(id)
              .pipe(
                Effect.flatMap((info) =>
                  info?.status === "running"
                    ? Effect.succeed(`done-${index}`)
                    : Effect.fail("job started before publish"),
                ),
              ),
          })

          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `done-${index}` },
          })
        })
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("increments pending work before starting immediately settling extensions", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) =>
        Effect.gen(function* () {
          const first = yield* Deferred.make<void>()
          const job = yield* jobs.start({
            type: "test",
            run: Deferred.await(first).pipe(Effect.as(`first-${index}`)),
          })

          expect(yield* jobs.extend({ id: job.id, run: Effect.succeed(`second-${index}`) })).toBe(true)
          expect((yield* jobs.get(job.id))?.status).toBe("running")

          yield* Deferred.succeed(first, undefined)
          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `second-${index}` },
          })
        }),
      )
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("an extension racing the job's completion is either refused or runs before the job settles", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 200 }), (_, index) =>
        Effect.gen(function* () {
          const first = yield* Deferred.make<void>()
          let extensionRan = false
          const job = yield* jobs.start({
            type: "test",
            run: Deferred.await(first).pipe(Effect.as(`first-${index}`)),
          })

          // Release the first run and extend at the same moment, so settle and extend contend for the registry.
          const [, extended] = yield* Effect.all(
            [
              Deferred.succeed(first, undefined),
              jobs.extend({
                id: job.id,
                run: Effect.sync(() => {
                  extensionRan = true
                  return `second-${index}`
                }),
              }),
            ],
            { concurrency: "unbounded" },
          )

          // The pending count is raised atomically with the status check, so the job cannot settle without the
          // extension it accepted, and a refused extension never runs.
          const settled = yield* jobs.wait({ id: job.id }).pipe(Effect.timeout("2 seconds"))
          expect(settled.info?.status).toBe("completed")
          expect(extensionRan).toBe(extended)
          expect(settled.info?.output).toBe(extended ? `second-${index}` : `first-${index}`)
        }),
      )
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("interrupts live work and settles it as cancelled when the owning process-local scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const interrupted = yield* Deferred.make<void>()
      const jobs = yield* BackgroundJob.make.pipe(Scope.provide(scope))
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })

      yield* Scope.close(scope, Exit.void)

      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      // Waiters, such as the task that reports a background subagent, are told the job was stopped.
      expect((yield* jobs.get(job.id))?.status).toBe("cancelled")
    }),
  )
})
