import { GlobalBus } from "@/bus/global"
import { InstanceStore } from "@/project/instance-store"
import { Effect, Option, RcMap } from "effect"
import { LocationServiceMap } from "@vectordevai/core/location-service-map"
import { Event } from "./event"

export const emitGlobalDisposed = Effect.sync(() =>
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Event.Disposed.type,
      properties: {},
    },
  }),
)

export const disposeAllInstancesAndEmitGlobalDisposed = Effect.fn("Server.disposeAllInstancesAndEmitGlobalDisposed")(
  function* (options?: { swallowErrors?: boolean }) {
    const store = yield* InstanceStore.Service
    yield* Effect.gen(function* () {
      const locations = yield* Effect.serviceOption(LocationServiceMap.Service)
      if (Option.isSome(locations)) {
        const keys = yield* RcMap.keys(locations.value.rcMap)
        yield* Effect.forEach(keys, (ref) => locations.value.invalidate(ref))
      }
      yield* options?.swallowErrors
        ? store.disposeAll().pipe(Effect.catchCause((cause) => Effect.logWarning("global disposal failed", { cause })))
        : store.disposeAll()
      yield* emitGlobalDisposed
    }).pipe(Effect.uninterruptible)
  },
)

export * as GlobalLifecycle from "./global-lifecycle"
