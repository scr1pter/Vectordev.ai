import { Effect, Fiber } from "effect"
import { EffectBridge } from "@/effect/bridge"

type CallbackRunner = <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>

/** Promise callbacks still belong to the job: drain their Git/model fibers before revoking its token. */
export function withGithubCallbacks<A, E, R>(use: (run: CallbackRunner) => Effect.Effect<A, E, R>) {
  return Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const bridge = yield* EffectBridge.make()
      const run: CallbackRunner = (effect) =>
        bridge
          .promise(effect.pipe(Effect.forkIn(scope, { startImmediately: true })))
          // Fiber.join's observer cleanup in this Effect beta can stall an async child finalizer.
          .then((fiber) => Effect.runPromise(Fiber.await(fiber).pipe(Effect.flatMap((exit) => exit))))
      return yield* use(run)
    }),
  )
}

/** Actions cancellation must interrupt the Effect so credential finalizers finish before CLI exit. */
export function withGithubSignals<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const signal = Promise.withResolvers<void>()
      let received = false
      const stop = (code: 130 | 143) => {
        if (received) return
        received = true
        process.exitCode = code
        signal.resolve()
      }
      const interrupt = () => stop(130)
      const terminate = () => stop(143)
      const cleanup = () => {
        process.removeListener("SIGINT", interrupt)
        process.removeListener("SIGTERM", terminate)
      }
      process.on("SIGINT", interrupt)
      process.on("SIGTERM", terminate)
      return { wait: signal.promise, cleanup }
    }),
    // Install both listeners before the job can acquire credentials or announce readiness.
    (signal) => Effect.raceFirst(effect, Effect.promise(() => signal.wait)),
    (signal) => Effect.sync(signal.cleanup),
  )
}
