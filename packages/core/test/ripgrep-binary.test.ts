import { expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FSUtil } from "@vectordevai/core/fs-util"
import { RipgrepBinary } from "@vectordevai/core/ripgrep/binary"

test("ripgrep preparation retries after its first caller is interrupted", async () => {
  const entered = Deferred.makeUnsafe<void>()
  const state = { calls: 0, path: "" }
  const filesystem = withFileLookup((path) =>
    Effect.gen(function* () {
      state.calls++
      state.path = path
      if (state.calls === 1) {
        yield* Deferred.succeed(entered, undefined)
        yield* Effect.never
      }
      return true
    }),
  )

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const binary = yield* RipgrepBinary.Service
        const first = yield* binary.filepath.pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const waiting = yield* binary.filepath.pipe(Effect.forkChild)
        yield* Fiber.interrupt(first)
        const interrupted = yield* Fiber.await(first)
        expect(Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause)).toBe(true)

        const retry = yield* Fiber.await(waiting)
        expect(Exit.isSuccess(retry)).toBe(true)
        if (Exit.isSuccess(retry)) expect(retry.value).toBe(state.path)
        expect(yield* binary.filepath).toBe(state.path)
        expect(state.calls).toBe(2)
      }),
    ).pipe(
      Effect.provide(LayerNode.compile(RipgrepBinary.node, [[FSUtil.node, filesystem]])),
      Effect.timeout("3 seconds"),
    ),
  )
})

test("ripgrep preparation deduplicates success while a waiting caller cancels", async () => {
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const state = { calls: 0, path: "" }
  const filesystem = withFileLookup((path) =>
    Effect.gen(function* () {
      state.calls++
      state.path = path
      yield* Deferred.succeed(entered, undefined)
      yield* Deferred.await(release)
      return true
    }),
  )

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const binary = yield* RipgrepBinary.Service
        const first = yield* binary.filepath.pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const canceled = yield* binary.filepath.pipe(Effect.forkChild)
        const waiting = yield* binary.filepath.pipe(Effect.forkChild)
        yield* Fiber.interrupt(canceled)
        const interrupted = yield* Fiber.await(canceled)
        expect(Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause)).toBe(true)
        yield* Deferred.succeed(release, undefined)

        expect(yield* Fiber.join(first)).toBe(state.path)
        expect(yield* Fiber.join(waiting)).toBe(state.path)
        expect(yield* binary.filepath).toBe(state.path)
        expect(state.calls).toBe(1)
      }),
    ).pipe(
      Effect.provide(LayerNode.compile(RipgrepBinary.node, [[FSUtil.node, filesystem]])),
      Effect.timeout("3 seconds"),
    ),
  )
})

function withFileLookup(isFile: FSUtil.Interface["isFile"]) {
  return Layer.effect(
    FSUtil.Service,
    Effect.map(FSUtil.Service, (fs) => FSUtil.Service.of({ ...fs, isFile })),
  ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
}
