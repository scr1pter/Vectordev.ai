import { describe, expect } from "bun:test"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Deferred, Effect } from "effect"
import { BackgroundJob } from "@/background/job"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([BackgroundJob.node, SessionStatus.node])))

// A reload disposes the instance's state, so a job it knew about is gone afterwards.
const reloaded = (jobs: BackgroundJob.Interface, id: string) =>
  pollWithTimeout(
    jobs.get(id).pipe(Effect.map((info) => (info === undefined ? true : undefined))),
    "the instance never reloaded",
    "5 seconds",
  )

describe("global reload", () => {
  it.instance("waits for a running background subagent instead of stopping it, then reloads", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const release = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "task",
        metadata: { background: true },
        run: Deferred.await(release).pipe(Effect.as("found it")),
      })

      // What a provider key change in Settings does.
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      expect((yield* jobs.get(job.id))?.status).toBe("running")

      yield* Deferred.succeed(release, undefined)
      expect((yield* jobs.wait({ id: job.id })).info).toMatchObject({ status: "completed", output: "found it" })
      yield* reloaded(jobs, job.id)
    }),
  )

  it.instance("waits for a busy session before reloading its instance", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const statuses = yield* SessionStatus.Service
      const session = SessionID.make("ses_global_reload_busy")
      const marker = yield* jobs.start({ type: "marker", run: Effect.succeed("done") })
      yield* jobs.wait({ id: marker.id })
      yield* statuses.set(session, { type: "busy" })

      yield* disposeAllInstancesAndEmitGlobalDisposed()
      expect((yield* jobs.get(marker.id))?.status).toBe("completed")
      expect((yield* statuses.get(session)).type).toBe("busy")

      yield* statuses.set(session, { type: "idle" })
      yield* reloaded(jobs, marker.id)
    }),
  )

  it.instance("reloads an idle instance right away", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const marker = yield* jobs.start({ type: "marker", run: Effect.succeed("done") })
      yield* jobs.wait({ id: marker.id })

      yield* disposeAllInstancesAndEmitGlobalDisposed()

      expect(yield* jobs.get(marker.id)).toBeUndefined()
    }),
  )
})
