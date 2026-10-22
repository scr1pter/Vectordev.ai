export * as OllamaServer from "./ollama"

import { Option, Schema } from "effect"
import { LocalErrors } from "../errors"
import type { LocalProbe } from "../probe"

// Ollama's own API: /api/version names it, /api/tags lists the models it has, /api/show describes one (its tools and
// vision support, the context it was trained for, and any num_ctx its Modelfile sets) and /api/ps lists the loaded
// ones with the context Ollama loaded them with, which is the one requests get. Field names follow Ollama's API docs;
// the cassette in test/fixture/local-servers is written from those docs, not recorded.
//
// Cloud models (`gpt-oss:120b-cloud`, or a tag with `remote_host`) run on ollama.com: the local daemon forwards the
// prompt there. They are marked `cloud` so Vector Local can keep them off, and their details are never read, since
// asking the daemon about one may make it call out.

export const kind = "ollama"
export const name = "Ollama"
export const port = 11434
export const identify = "/api/version"
// Ollama answers one request at a time unless OLLAMA_NUM_PARALLEL says more, which its API does not report.
export const concurrency = 1

const Version = Schema.Struct({ version: Schema.String })

const Details = Schema.Struct({
  family: Schema.optional(Schema.String),
  parameter_size: Schema.optional(Schema.String),
  quantization_level: Schema.optional(Schema.String),
})

const Tags = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      size: Schema.optional(Schema.Number),
      remote_model: Schema.optional(Schema.String),
      remote_host: Schema.optional(Schema.String),
      details: Schema.optional(Details),
    }),
  ),
})

const Show = Schema.Struct({
  parameters: Schema.optional(Schema.String),
  model_info: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  capabilities: Schema.optional(Schema.Array(Schema.String)),
  remote_model: Schema.optional(Schema.String),
  remote_host: Schema.optional(Schema.String),
})

const Running = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      context_length: Schema.optional(Schema.Number),
    }),
  ),
})

export function matches(json: unknown) {
  return Option.isSome(Schema.decodeUnknownOption(Version)(json))
}

export async function inspect(read: LocalProbe.Read, identified: unknown): Promise<LocalProbe.Inspection> {
  const [tags, running] = await Promise.all([read("/api/tags"), read("/api/ps")])
  const loaded = new Map(
    (Option.getOrUndefined(Schema.decodeUnknownOption(Running)(running))?.models ?? []).map((item) => [
      item.name,
      item.context_length,
    ]),
  )
  const listed = Option.getOrUndefined(Schema.decodeUnknownOption(Tags)(tags))?.models ?? []
  const answered = await Promise.all(
    listed.map(async (tag): Promise<LocalProbe.Model | undefined> => {
      const base = {
        id: tag.name,
        size: tag.size,
        parameters: tag.details?.parameter_size,
        quantization: tag.details?.quantization_level,
        family: tag.details?.family,
      }
      if (cloud(tag)) return { ...base, cloud: true }
      const show = Option.getOrUndefined(Schema.decodeUnknownOption(Show)(await read("/api/show", { model: tag.name })))
      if (show && cloud(show)) return { ...base, cloud: true }
      // An embedding model, such as nomic-embed-text, lists no `completion` capability and cannot answer a chat, so it
      // is left out like LM Studio's embedding models. Older servers that list no capabilities keep every model.
      if (show?.capabilities && !show.capabilities.includes("completion")) return undefined
      const architecture = show?.model_info?.["general.architecture"]
      const trained =
        typeof architecture === "string" ? show?.model_info?.[`${architecture}.context_length`] : undefined
      return {
        ...base,
        // A loaded model runs with the context Ollama loaded it with. One not loaded yet gets its Modelfile's num_ctx,
        // or the server's default, which the API does not report: Check models loads it and reads the real number.
        context: loaded.get(tag.name) ?? numCtx(show?.parameters),
        trained: typeof trained === "number" ? trained : undefined,
        tools: show?.capabilities ? show.capabilities.includes("tools") : undefined,
        vision: show?.capabilities ? show.capabilities.includes("vision") : undefined,
        loaded: loaded.has(tag.name),
      }
    }),
  )
  const models = answered.filter((model): model is LocalProbe.Model => model !== undefined)
  return {
    version: Option.getOrUndefined(Schema.decodeUnknownOption(Version)(identified))?.version,
    models,
    concurrency,
    forwards: models.some((model) => model.cloud) ? "ollama-cloud" : undefined,
  }
}

/** The context Ollama has loaded a model with, from /api/ps, or undefined when it is not loaded. */
export async function loadedContext(read: LocalProbe.Read, model: string) {
  const running = Option.getOrUndefined(Schema.decodeUnknownOption(Running)(await read("/api/ps")))
  return running?.models.find((item) => item.name === model)?.context_length
}

/** Whether a tag or a model's details name a model that runs on ollama.com rather than on this server. */
export function cloud(model: {
  readonly name?: string
  readonly remote_host?: string
  readonly remote_model?: string
}) {
  if (model.remote_host || model.remote_model) return true
  return /[-:]cloud$/i.test(model.name ?? "")
}

function numCtx(parameters: string | undefined) {
  const match = parameters?.match(/^num_ctx\s+(\d+)\s*$/m)
  return match ? Number(match[1]) : undefined
}

/**
 * The offer to make a copy of a model that loads with a larger context: the copy Ollama would create and the
 * server-wide setting that does the same for every model. Vector only offers it; `create` runs it when the user asks.
 */
export type Copy = {
  readonly from: string
  readonly model: string
  readonly context: number
  /** The other way, for the Ollama server as a whole. */
  readonly guidance: string
}

export function copy(model: string, required: number): Copy {
  // The next power of two at or above what is needed, so a 19K requirement gets a 32K copy.
  const context = 2 ** Math.ceil(Math.log2(Math.max(required, 2048)))
  // The tag follows the last colon after the last slash, so a registry with a port (localhost:5000/coder:q4) keeps it.
  const colon = model.lastIndexOf(":")
  const [repository, tag] =
    colon > model.lastIndexOf("/") ? [model.slice(0, colon), model.slice(colon + 1)] : [model, "latest"]
  return {
    from: model,
    model: `${repository}:${tag}-${Math.round(context / 1024)}k`,
    context,
    guidance: `Or set OLLAMA_CONTEXT_LENGTH=${context} where the Ollama server runs and restart it, which raises the context for every model.`,
  }
}

/**
 * Creates the copy on the Ollama server at `origin`. Only the user's click calls this: Check models offers the copy and
 * never makes it itself. Resolves with the server's error as plain text when it refuses.
 */
export async function create(origin: string, offer: Copy, signal?: AbortSignal) {
  const response = await fetch(`${origin}/api/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: offer.model,
      from: offer.from,
      parameters: { num_ctx: offer.context },
      stream: false,
    }),
    redirect: "error",
    signal,
  })
  if (response.ok) {
    await response.body?.cancel()
    return { created: offer.model }
  }
  return { error: LocalErrors.plain(await response.text()) }
}
