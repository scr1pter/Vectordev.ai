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
  return Effect.raceFirst(
    effect,
    Effect.callback<void>((resume) => {
      const interrupt = () => {
        process.exitCode = 130
        cleanup()
        resume(Effect.void)
      }
      const terminate = () => {
        process.exitCode = 143
        cleanup()
        resume(Effect.void)
      }
      const cleanup = () => {
        process.removeListener("SIGINT", interrupt)
        process.removeListener("SIGTERM", terminate)
      }
      process.once("SIGINT", interrupt)
      process.once("SIGTERM", terminate)
      return Effect.sync(cleanup)
    }),
  )
}
