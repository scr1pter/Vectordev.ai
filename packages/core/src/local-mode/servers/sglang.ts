export * as SGLangServer from "./sglang"

import { Option, Schema } from "effect"
import type { LocalProbe } from "../probe"

// SGLang: /get_model_info names the model path it serves, /get_server_info carries its version and the context it
// was started with, and /v1/models lists the model (newer versions add `max_model_len`). Tool calls depend on its
// --tool-call-parser, which stays unknown until Check models tries it. Field names follow SGLang's docs; the cassette
// is written from them, not recorded.

export const kind = "sglang"
export const name = "SGLang"
export const port = 30000
export const identify = "/get_model_info"
// SGLang batches requests itself, like vLLM.
export const concurrency = 4

const Info = Schema.Struct({
  model_path: Schema.String,
  is_generation: Schema.optional(Schema.Boolean),
})

const ServerInfo = Schema.Struct({
  version: Schema.optional(Schema.String),
  context_length: Schema.optional(Schema.NullOr(Schema.Number)),
})

const Models = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      max_model_len: Schema.optional(Schema.Number),
    }),
  ),
})

export function matches(json: unknown) {
  return Option.isSome(Schema.decodeUnknownOption(Info)(json))
}

export async function inspect(read: LocalProbe.Read): Promise<LocalProbe.Inspection> {
  const [info, list] = await Promise.all([read("/get_server_info"), read("/v1/models")])
  const server = Option.getOrUndefined(Schema.decodeUnknownOption(ServerInfo)(info))
  const data = Option.getOrUndefined(Schema.decodeUnknownOption(Models)(list))?.data ?? []
  return {
    version: server?.version,
    models: data.map((model) => ({
      id: model.id,
      context: model.max_model_len ?? server?.context_length ?? undefined,
      loaded: true,
    })),
    concurrency,
  }
}
