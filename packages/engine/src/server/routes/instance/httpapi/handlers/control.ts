import { Auth } from "@/auth"

import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { LogInput } from "../groups/control"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ConflictError } from "../errors"

export const controlHandlers = HttpApiBuilder.group(RootHttpApi, "control", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service

    const authExists = Effect.fn("ControlHttpApi.authExists")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
    }) {
      return yield* auth.exists(ctx.params.providerID).pipe(Effect.orDie)
    })

    const authSet = Effect.fn("ControlHttpApi.authSet")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      query: { ifAbsent?: boolean }
      payload: Auth.Info
    }) {
      const save = ctx.query.ifAbsent ? auth.create : auth.set
      yield* save(ctx.params.providerID, ctx.payload).pipe(
        Effect.catchTag("AuthError", Effect.die),
        Effect.mapError((error) => new ConflictError({ message: error.message, resource: error.providerID })),
      )
      return true
    })

    const authRemove = Effect.fn("ControlHttpApi.authRemove")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
    }) {
      yield* auth.remove(ctx.params.providerID).pipe(Effect.orDie)
      return true
    })

    const log = Effect.fn("ControlHttpApi.log")(function* (ctx: { payload: typeof LogInput.Type }) {
      const write =
        ctx.payload.level === "debug"
          ? Effect.logDebug
          : ctx.payload.level === "info"
            ? Effect.logInfo
            : ctx.payload.level === "warn"
              ? Effect.logWarning
              : Effect.logError
      yield* write(ctx.payload.message).pipe(Effect.annotateLogs(ctx.payload.extra ?? {}))
      return true
    })

    return handlers
      .handle("authExists", authExists)
      .handle("authSet", authSet)
      .handle("authRemove", authRemove)
      .handle("log", log)
  }),
)
