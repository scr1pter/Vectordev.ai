export * as State from "./state"

import { Context, Effect, Scope, Semaphore } from "effect"

/**
 * A replayable transform applied to a draft during reload.
 *
 * Domain drafts expose readable and writable state while preserving concise
 * plugin/config code. Transforms may perform Effects before returning.
 */
type TransformCallback<DraftApi> = (draft: DraftApi) => Effect.Effect<void> | void
export type MakeDraft<State, DraftApi> = (state: State) => DraftApi

export interface Registration {
  readonly dispose: Effect.Effect<void>
}

export type Transform<DraftApi> = (
  transform: TransformCallback<DraftApi>,
) => Effect.Effect<Registration, never, Scope.Scope>

export type Reload = () => Effect.Effect<void>

export interface Transformable<DraftApi> {
  readonly transform: Transform<DraftApi>
  readonly reload: Reload
}

// `open` is false once the batch has applied its reloads. A fiber forked inside the batch keeps it in its context and may
// outlive it, so a closed batch counts as no batch at all.
type Batch = { readonly reloads: Set<Reload>; readonly settled: Effect.Effect<void>[]; open: boolean }

const CurrentBatch = Context.Reference<Batch | undefined>("@vector/State/CurrentBatch", {
  defaultValue: () => undefined,
})

export function batch<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const current = yield* CurrentBatch
    if (current?.open) return yield* effect
    const next: Batch = { reloads: new Set(), settled: [], open: true }
    return yield* Effect.gen(function* () {
      const result = yield* effect.pipe(Effect.provideService(CurrentBatch, next))
      // A reload can queue more reloads; apply them until none are left, then close in the same step.
      while (next.reloads.size > 0) {
        const pending = [...next.reloads]
        next.reloads.clear()
        yield* Effect.forEach(pending, (reload) => reload(), { discard: true })
      }
      next.open = false
      return result
    }).pipe(
      // Waiters are released however the batch ends: a failed or interrupted one never applies its reloads, but
      // leaving them waiting would hang them for good.
      Effect.ensuring(
        Effect.suspend(() => {
          next.open = false
          return Effect.forEach(next.settled, (item) => item, { discard: true })
        }),
      ),
    )
  })
}

/** Runs once the current batch has ended, after its reloads when it succeeds; immediately outside a batch. */
export function settled(effect: Effect.Effect<void>) {
  return Effect.gen(function* () {
    const current = yield* CurrentBatch
    if (!current?.open) return yield* effect
    current.settled.push(effect)
  })
}

export interface Options<State, DraftApi> {
  /** Creates the base value for initial state and every scoped-transform reload. */
  readonly initial: () => State
  /** Wraps mutable state in a domain-specific draft API. */
  readonly draft: MakeDraft<State, DraftApi>
  /** Runs after all active transforms and before the rebuilt state becomes visible. */
  readonly finalize?: (draft: DraftApi) => Effect.Effect<void>
}

export interface Interface<State, DraftApi> extends Transformable<DraftApi> {
  readonly get: () => State
  /**
   * Registers and applies a scoped transform. Closing the owning Scope removes
   * the transform and reloads the materialized state.
   */
}

export function create<State, DraftApi>(options: Options<State, DraftApi>): Interface<State, DraftApi> {
  let state = options.initial()
  let transforms: { run: TransformCallback<DraftApi> }[] = []
  const semaphore = Semaphore.makeUnsafe(1)

  const commit = Effect.fn("State.commit")(function* (next: State) {
    const api = options.draft(next)
    if (options.finalize) yield* options.finalize(api)
    state = next
  })

  const apply = (transform: TransformCallback<DraftApi>, draft: DraftApi) =>
    Effect.suspend(() => {
      const result = transform(draft)
      return Effect.isEffect(result) ? Effect.asVoid(result).pipe(Effect.orDie) : Effect.void
    })

  const materialize = Effect.fnUntraced(function* () {
    const next = options.initial()
    const api = options.draft(next)
    for (const transform of transforms) yield* apply(transform.run, api).pipe(Effect.withSpan("State.reload.update"))
    yield* commit(next)
  })

  const reload = () => semaphore.withPermit(materialize())

  const result: Interface<State, DraftApi> = {
    get: () => state,
    transform: Effect.fn("State.transform")(function* (update) {
      const scope = yield* Scope.Scope
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const transform = { run: update }
          let active = true
          const dispose = Effect.uninterruptible(
            semaphore.withPermit(
              Effect.suspend(() => {
                if (!active) return Effect.void
                active = false
                transforms = transforms.filter((item) => item !== transform)
                return Effect.gen(function* () {
                  const batch = yield* CurrentBatch
                  if (batch?.open) {
                    batch.reloads.add(reload)
                    return
                  }
                  yield* materialize()
                })
              }),
            ),
          )
          yield* semaphore.withPermit(
            Effect.sync(() => {
              transforms = [...transforms, transform]
            }),
          )
          yield* Scope.addFinalizer(scope, dispose)
          const batch = yield* CurrentBatch
          if (batch?.open) batch.reloads.add(reload)
          else yield* reload()
          return { dispose }
        }),
      )
    }),
    reload,
  }
  return result
}
