import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ProjectID } from "@vectordevai/schema/project-id"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { registerDisposer } from "../../../src/effect/instance-registry"
import { InstanceBootstrap } from "../../../src/project/bootstrap-service"
import { InstanceStore } from "../../../src/project/instance-store"
import { Project } from "../../../src/project/project"

const mode = process.argv[2]
if (!["load", "reload-bootstrap", "reload-wait", "reload-dispose"].includes(mode))
  throw new Error("Invalid scope probe")

await Effect.runPromise(
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const directory = process.argv[3]
    const input = {
      directory,
      worktree: directory,
      project: {
        id: ProjectID.make("fixture"),
        worktree: directory,
        time: { created: 0, updated: 0 },
        sandboxes: [],
      },
    }
    let attempts = 0
    const layer = LayerNode.compile(InstanceStore.node, [
      [
        InstanceStore.bootstrapNode,
        Layer.succeed(
          InstanceBootstrap.Service,
          InstanceBootstrap.Service.of({
            run: Effect.suspend(() => {
              attempts++
              if (mode === "reload-dispose" || (mode === "reload-bootstrap" && attempts === 1)) return Effect.void
              return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
            }),
          }),
        ),
      ],
      // Explicit context must keep this lifetime regression independent of Git and database services.
      [Project.node, Layer.mock(Project.Service, {})],
    ])
    const scope = yield* Scope.make()
    const context = yield* Layer.buildWithMemoMap(layer, Layer.makeMemoMapUnsafe(), scope)
    const store = Context.get(context, InstanceStore.Service)
    if (mode === "reload-bootstrap" || mode === "reload-dispose") yield* store.load(input)
    if (mode === "reload-dispose") {
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          registerDisposer(() => {
            Deferred.doneUnsafe(entered, Effect.void)
            return new Promise<void>(() => {})
          }),
        ),
        (off) => Effect.sync(off),
      )
    }
    const first = yield* (
      mode.startsWith("reload-") && mode !== "reload-wait" ? store.reload(input) : store.load(input)
    ).pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Deferred.await(entered)
    const second =
      mode === "reload-wait"
        ? yield* store.reload(input).pipe(Effect.forkScoped({ startImmediately: true }))
        : undefined
    console.log("pending worker reached")
    yield* Scope.close(scope, Exit.void)
    const exits = yield* Effect.forEach(second ? [first, second] : [first], Fiber.await)
    console.log(
      JSON.stringify({
        closed: true,
        interrupted: exits.map((exit) => Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)),
        attempts,
      }),
    )
  }).pipe(Effect.scoped),
)
