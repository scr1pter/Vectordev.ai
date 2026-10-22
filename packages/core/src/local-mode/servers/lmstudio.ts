export * as LMStudioServer from "./lmstudio"

import { Option, Schema } from "effect"
import type { LocalProbe } from "../probe"

// LM Studio's REST API: /api/v0/models lists every model it has, with its type (llm, vlm for one that reads images,
// embeddings), whether it is loaded, the context it is loaded with and the largest it supports, and `tool_use` among
// its capabilities. LM Studio answers 200 with an "Unexpected endpoint" error body for paths it does not know, so it
// is recognised by the shape of this answer, never by a status. Its API does not report its version. Field names
// follow LM Studio's docs; the cassette is written from them, not recorded.

export const kind = "lmstudio"
export const name = "LM Studio"
export const port = 1234
export const identify = "/api/v0/models"
// LM Studio answers one request at a time by default.
export const concurrency = 1

const Models = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      type: Schema.optional(Schema.String),
      arch: Schema.optional(Schema.String),
      quantization: Schema.optional(Schema.String),
      state: Schema.optional(Schema.String),
      max_context_length: Schema.optional(Schema.Number),
      loaded_context_length: Schema.optional(Schema.Number),
      capabilities: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
})

export function matches(json: unknown) {
  return Option.isSome(Schema.decodeUnknownOption(Models)(json))
}

export async function inspect(_read: LocalProbe.Read, identified: unknown): Promise<LocalProbe.Inspection> {
  const data = Option.getOrUndefined(Schema.decodeUnknownOption(Models)(identified))?.data ?? []
  return {
    models: data
      .filter((model) => model.type !== "embeddings")
      .map((model) => {
        const loaded = model.state === "loaded"
        return {
          id: model.id,
          // One not loaded yet loads with the context set in LM Studio, which the API does not report.
          context: loaded ? model.loaded_context_length : undefined,
          trained: model.max_context_length,
          tools: model.capabilities ? model.capabilities.includes("tool_use") : undefined,
          vision: model.type === "vlm",
          loaded,
          quantization: model.quantization,
          family: model.arch,
        }
      }),
    concurrency,
  }
}
