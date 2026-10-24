export * as OpenAIServer from "./openai"

import { Option, Schema } from "effect"
import type { LocalProbe } from "../probe"

// Any other server that speaks the OpenAI API: /v1/models lists its models and little else, so context and tools stay
// unknown until Check models or the user sets them. A LiteLLM proxy is recognised by /health/readiness, which reports
// `litellm_version`, and is labelled as one that forwards: it usually passes prompts on to the services it is set up
// with, and Vector cannot see past it. Generic servers are only probed at an address the user typed.

export const kind = "openai"
export const name = "OpenAI-compatible server"
export const identify = "/v1/models"

const Models = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      max_model_len: Schema.optional(Schema.Number),
      context_length: Schema.optional(Schema.Number),
    }),
  ),
})

const LiteLLM = Schema.Struct({ litellm_version: Schema.String })

export function matches(json: unknown) {
  return Option.isSome(Schema.decodeUnknownOption(Models)(json))
}

export async function inspect(read: LocalProbe.Read, identified: unknown): Promise<LocalProbe.Inspection> {
  const data = Option.getOrUndefined(Schema.decodeUnknownOption(Models)(identified))?.data ?? []
  const litellm = Option.getOrUndefined(Schema.decodeUnknownOption(LiteLLM)(await read("/health/readiness")))
  return {
    version: litellm?.litellm_version,
    models: data.map((model) => ({ id: model.id, context: model.max_model_len ?? model.context_length })),
    forwards: litellm ? "litellm" : undefined,
  }
}
