import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import { define } from "@vectordevai/plugin/v2/effect"
import { AgentV2 } from "@vectordevai/core/agent"
import { PluginV2 } from "@vectordevai/core/plugin"
import { State } from "@vectordevai/core/state"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

describe("PluginV2", () => {
  it.effect("waits for a plugin and returns immediately once active", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const id = PluginV2.ID.make("waited")
      const waiting = yield* plugins.wait(id).pipe(Effect.forkChild)

      yield* plugins.add(id, () => Effect.void)
      yield* Fiber.join(waiting)
      yield* plugins.wait(id)
    }),
  )

  it.effect("a waiter sees the plugin's state even while the batch that added it is still running", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      const id = PluginV2.ID.make("batched")
      const seen = yield* plugins.wait(id).pipe(
        Effect.andThen(agents.get(AgentV2.ID.make("from-batched"))),
        Effect.forkChild,
      )
      // Boot adds every built-in plugin inside one batch, which applies their state only when it ends. A waiter
      // released while the batch is still adding plugins must not read the state before that.
      yield* State.batch(
        Effect.gen(function* () {
          yield* plugins.add(id, (ctx) =>
            ctx.agent
              .transform((draft) =>
                draft.update("from-batched", (agent) => {
                  agent.description = "ready"
                }),
              )
              .pipe(Effect.asVoid),
          )
          yield* Effect.yieldNow
          yield* Effect.yieldNow
        }),
      )
      expect((yield* Fiber.join(seen))?.description).toBe("ready")
    }),
  )

  it.live("releases waiters even when the batch that added the plugin fails while applying its state", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const good = PluginV2.ID.make("released-good")
      const waiting = yield* plugins.wait(good).pipe(Effect.timeout("2 seconds"), Effect.exit, Effect.forkChild)
      // The transform runs only when the batch applies its reloads at the end, and there it throws.
      const batch = yield* State.batch(
        Effect.gen(function* () {
          yield* plugins.add(good, () => Effect.void)
          yield* plugins.add(PluginV2.ID.make("released-bad"), (ctx) =>
            ctx.agent
              .transform(() => {
                throw new Error("boom")
              })
              .pipe(Effect.asVoid),
          )
        }),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(batch)).toBe(true)
      expect(Exit.isSuccess(yield* Fiber.join(waiting))).toBe(true)
      expect(Exit.isSuccess(yield* plugins.wait(good).pipe(Effect.timeout("2 seconds"), Effect.exit))).toBe(true)
    }),
  )

  it.live("a plugin added after its batch ended, as external plugins are, is ready and applied", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      const inner = PluginV2.ID.make("late-inner")
      // The same shape as an external config plugin: fork inside the batch, finish loading after it has ended.
      yield* State.batch(
        plugins.add(PluginV2.ID.make("late-outer"), (ctx) =>
          Effect.sleep("50 millis").pipe(
            Effect.andThen(
              ctx.plugin.add({
                id: inner,
                effect: (late) =>
                  late.agent
                    .transform((draft) =>
                      draft.update("from-late", (agent) => {
                        agent.description = "late"
                      }),
                    )
                    .pipe(Effect.asVoid),
              }),
            ),
            Effect.forkScoped,
            Effect.asVoid,
          ),
        ),
      )
      expect(Exit.isSuccess(yield* plugins.wait(inner).pipe(Effect.timeout("2 seconds"), Effect.exit))).toBe(true)
      expect((yield* agents.get(AgentV2.ID.make("from-late")))?.description).toBe("late")
    }),
  )

  it.effect("propagates plugin activation defects to waiters", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const id = PluginV2.ID.make("failed")
      const waiting = yield* plugins.wait(id).pipe(Effect.exit, Effect.forkChild)

      const added = yield* plugins.add(id, () => Effect.die("boom")).pipe(Effect.exit)
      const pending = yield* Fiber.join(waiting)
      const later = yield* plugins.wait(id).pipe(Effect.exit)

      expect(Exit.isFailure(added)).toBe(true)
      expect(Exit.isFailure(pending)).toBe(true)
      expect(Exit.isFailure(later)).toBe(true)
    }),
  )

  it.effect("adds, replaces, and removes plugins", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      let description = "first"

      const managed = () =>
        define({
          id: "managed",
          effect: (ctx) =>
            ctx.agent
              .transform((agents) =>
                agents.update("configured", (agent) => {
                  agent.description = description
                }),
              )
              .pipe(Effect.asVoid),
        })

      yield* plugins.add(PluginV2.ID.make("managed"), managed().effect)

      expect((yield* agents.get(AgentV2.ID.make("configured")))?.description).toBe("first")

      description = "second"
      yield* plugins.add(PluginV2.ID.make("managed"), managed().effect)
      expect((yield* agents.get(AgentV2.ID.make("configured")))?.description).toBe("second")

      yield* plugins.remove(PluginV2.ID.make("managed"))
      expect(yield* agents.get(AgentV2.ID.make("configured"))).toBeUndefined()
    }),
  )
})
