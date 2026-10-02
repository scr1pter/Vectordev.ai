import { Catalog } from "@vectordevai/core/catalog"
import { Redaction } from "@vectordevai/core/redaction"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { ProviderNotFoundError } from "@vectordevai/protocol/errors"
import { response } from "../location"

export const ProviderHandler = HttpApiBuilder.group(Api, "server.provider", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "provider.list",
        Effect.fn(function* () {
          const catalog = yield* Catalog.Service
          // Provider settings and request headers can hold the API key from config.
          return yield* response(catalog.provider.available().pipe(Effect.map(Redaction.redact)))
        }),
      )
      .handle(
        "provider.get",
        Effect.fn(function* (ctx) {
          const catalog = yield* Catalog.Service
          const provider = yield* catalog.provider.get(ctx.params.providerID)
          if (!provider)
            return yield* new ProviderNotFoundError({
              providerID: ctx.params.providerID,
              message: `Provider not found: ${ctx.params.providerID}`,
            })
          return yield* response(Effect.succeed(Redaction.redact(provider)))
        }),
      )
  }),
)
