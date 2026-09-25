import { FreeModelsResume } from "../free-model-resume"
import { Cause, Effect, Layer } from "effect"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const coordinator = yield* SessionRunCoordinator.make<
      SessionSchema.ID,
      SessionRunner.RunError | FreeModelsResume.Rejected
    >({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        return yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force })).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
        )
      }),
    })

    return SessionExecution.Service.of({
      active: coordinator.active,
      interrupt: coordinator.interrupt,
      resume: coordinator.run,
      resumeFreeModels: (input) =>
        coordinator.runExclusive(
          input.sessionID,
          Effect.gen(function* () {
            const session = yield* store.get(input.sessionID)
            if (!session) return yield* new FreeModelsResume.Rejected({ message: "Session not found." })
            yield* FreeModelsResume.Service.use((service) => service.prepare(input)).pipe(
              Effect.provide(locations.get(session.location)),
            )
          }),
          new FreeModelsResume.Rejected({ message: "This session is busy. Wait for the current turn to finish." }),
        ),
      wake: coordinator.wake,
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [SessionStore.node, LocationServiceMap.node],
})

export * as SessionExecutionLocal from "./local"
