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

  it.live("keeps what every run wrote when a job is extended, not just the last", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const first = yield* Deferred.make<void>()
      const job = yield* jobs.start({ type: "test", run: Deferred.await(first).pipe(Effect.as("first report")) })
      yield* jobs.extend({ id: job.id, run: Effect.succeed("second report") })

      yield* Deferred.succeed(first, undefined)
      expect((yield* jobs.wait({ id: job.id })).info).toMatchObject({
        status: "completed",
        output: "second report",
        outputs: ["first report", "second report"],
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("a concurrent extension starts alongside the running run and the job settles after both", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const first = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const second = yield* Deferred.make<void>()
      const job = yield* jobs.start({ type: "test", run: Deferred.await(first).pipe(Effect.as("first report")) })
      yield* jobs.extend({
        id: job.id,
        concurrent: true,
        run: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(second)),
          Effect.as("second report"),
        ),
      })

      // It started while the first run is still going.
      yield* Deferred.await(started).pipe(Effect.timeout("1 second"))
      yield* Deferred.succeed(first, undefined)
      expect((yield* jobs.wait({ id: job.id, timeout: 50 })).info?.status).toBe("running")

      yield* Deferred.succeed(second, undefined)
      expect((yield* jobs.wait({ id: job.id })).info).toMatchObject({
        status: "completed",
        outputs: ["first report", "second report"],
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("a failed run leaves the runs added after it, or alongside it, to finish", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const failing = yield* Deferred.make<void>()
      const queued = yield* jobs.start({
        type: "test",
        run: Deferred.await(failing).pipe(
          Effect.andThen(Effect.fail(new BackgroundJob.RunFailed({ message: "rate limited", output: "partial notes" }))),
        ),
      })
      yield* jobs.extend({ id: queued.id, run: Effect.succeed("follow-up report") })
      yield* Deferred.succeed(failing, undefined)
      expect((yield* jobs.wait({ id: queued.id })).info).toMatchObject({
        status: "completed",
        output: "follow-up report",
        outputs: ["partial notes", "follow-up report"],
      })

      // A run added alongside that fails does not stop the run already going; the job ends as that latest run did.
      const first = yield* Deferred.make<void>()
      const running = yield* jobs.start({ type: "test", run: Deferred.await(first).pipe(Effect.as("first report")) })
      yield* jobs.extend({ id: running.id, concurrent: true, run: Effect.fail(new Error("could not deliver")) })
      expect((yield* jobs.wait({ id: running.id, timeout: 50 })).info?.status).toBe("running")
      yield* Deferred.succeed(first, undefined)
      expect((yield* jobs.wait({ id: running.id })).info).toMatchObject({
        status: "error",
        error: "could not deliver",
        output: "first report",
      })
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
