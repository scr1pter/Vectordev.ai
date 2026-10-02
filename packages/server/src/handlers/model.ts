import { Catalog } from "@vectordevai/core/catalog"
import { Redaction } from "@vectordevai/core/redaction"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const ModelHandler = HttpApiBuilder.group(Api, "server.model", (handlers) =>
  Effect.gen(function* () {
    return handlers.handle(
      "model.list",
      Effect.fn(function* () {
        const catalog = yield* Catalog.Service
        // Model settings and request headers can hold the API key from config.
        return yield* response(catalog.model.available().pipe(Effect.map(Redaction.redact)))
      }),
    )
  }),
)
