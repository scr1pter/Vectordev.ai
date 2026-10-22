export * as VLLMServer from "./vllm"

import { Option, Schema } from "effect"
import type { LocalProbe } from "../probe"

// vLLM: /version names it and /v1/models lists the model it serves with `max_model_len`, the context it runs with.
// Whether it calls tools depends on how it was started (--enable-auto-tool-choice and a --tool-call-parser), which no
// endpoint reports, so tool support stays unknown until Check models tries it. Field names follow vLLM's docs; the
// cassette is written from them, not recorded.

export const kind = "vllm"
export const name = "vLLM"
export const port = 8000
export const identify = "/version"
// vLLM batches requests itself; four at once keeps a shared server responsive without queueing in Vector.
export const concurrency = 4

const Version = Schema.Struct({ version: Schema.String })

const Models = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      max_model_len: Schema.optional(Schema.Number),
    }),
  ),
})

export function matches(json: unknown) {
  return Option.isSome(Schema.decodeUnknownOption(Version)(json))
}

export async function inspect(read: LocalProbe.Read, identified: unknown): Promise<LocalProbe.Inspection> {
  const data = Option.getOrUndefined(Schema.decodeUnknownOption(Models)(await read("/v1/models")))?.data ?? []
  return {
    version: Option.getOrUndefined(Schema.decodeUnknownOption(Version)(identified))?.version,
    models: data.map((model) => ({ id: model.id, context: model.max_model_len, loaded: true })),
    concurrency,
  }
}
