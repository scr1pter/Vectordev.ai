export * as LlamaCppServer from "./llamacpp"

import { Option, Schema } from "effect"
import type { LocalProbe } from "../probe"

// llama.cpp's llama-server: /props reports its slots (how many requests it serves at once), each slot's context
// (`default_generation_settings.n_ctx`, the total divided between the slots), its build and, in newer builds, whether
// the loaded model reads images. /v1/models names the model and the context it was trained for. Tool calls need the
// server started with --jinja, which /props does not report, so tool support stays unknown until Check models tries
// it. Port 8080 is shared with many other servers, so /props is what identifies it. Field names follow llama.cpp's
// server docs; the cassette is written from them, not recorded.

export const kind = "llamacpp"
export const name = "llama.cpp"
export const port = 8080
export const identify = "/props"

const Props = Schema.Struct({
  total_slots: Schema.Number,
  default_generation_settings: Schema.optional(Schema.Struct({ n_ctx: Schema.optional(Schema.Number) })),
  build_info: Schema.optional(Schema.String),
  modalities: Schema.optional(Schema.Struct({ vision: Schema.optional(Schema.Boolean) })),
})

const Models = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      meta: Schema.optional(Schema.Struct({ n_ctx_train: Schema.optional(Schema.Number) })),
    }),
  ),
})

export function matches(json: unknown) {
  return Option.isSome(Schema.decodeUnknownOption(Props)(json))
}

export async function inspect(read: LocalProbe.Read, identified: unknown): Promise<LocalProbe.Inspection> {
  const props = Option.getOrUndefined(Schema.decodeUnknownOption(Props)(identified))
  const data = Option.getOrUndefined(Schema.decodeUnknownOption(Models)(await read("/v1/models")))?.data ?? []
  return {
    version: props?.build_info,
    models: data.map((model) => ({
      id: model.id,
      context: props?.default_generation_settings?.n_ctx,
      trained: model.meta?.n_ctx_train,
      vision: props?.modalities?.vision,
      loaded: true,
    })),
    concurrency: props && props.total_slots > 0 ? props.total_slots : undefined,
  }
}
