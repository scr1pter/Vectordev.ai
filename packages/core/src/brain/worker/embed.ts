export * as BrainWorkerEmbed from "./embed"

import type { InferenceSession } from "onnxruntime-web/wasm"
import type { BrainWorkerProtocol } from "./protocol"

// The local embedding model, inside the brain's background reader. ONNX Runtime's WASM build runs it on one thread
// with no proxy worker, from the wasm bytes the host sends (the copy shipped inside the app or the CLI), so it never
// fetches or imports anything itself. The host sends the model's files once per worker, and every load embeds the
// canary sentences, whose cosines against the pinned vectors the host checks before any vector is used. Requests are
// answered one at a time, in the order they arrive: the host sends a request's query ahead of the background queue, so
// a query waits for at most the one passage being embedded.

type Loaded = {
  readonly key: string
  readonly session: InferenceSession
  readonly encode: (text: string) => readonly number[]
  readonly settings: BrainWorkerProtocol.EmbedSettings
  readonly tensor: (ids: readonly number[]) => unknown
}

const state: { loaded?: Loaded; queue: Promise<unknown> } = { queue: Promise.resolve() }

/** Load a model (replacing the one loaded before) and embed its canaries, for the host to check. */
export function load(request: BrainWorkerProtocol.Load) {
  return serial(async () => {
    const started = performance.now()
    const { InferenceSession, Tensor, env } = await import("onnxruntime-web/wasm")
    const { Tokenizer } = await import("@huggingface/tokenizers")
    env.wasm.numThreads = 1
    env.wasm.proxy = false
    env.wasm.wasmBinary = request.wasm
    env.logLevel = "error"
    await state.loaded?.session.release().catch(() => undefined)
    state.loaded = undefined
    const session = await InferenceSession.create(request.model, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
      ...(request.data && request.dataName ? { externalData: [{ path: request.dataName, data: request.data }] } : {}),
    })
    const tokenizer = new Tokenizer(JSON.parse(request.tokenizer), JSON.parse(request.config))
    state.loaded = {
      key: request.key,
      session,
      encode: (text) => tokenizer.encode(text).ids,
      settings: request.settings,
      tensor: (ids) =>
        new Tensor(
          "int64",
          BigInt64Array.from(ids, (id) => BigInt(id)),
          [1, ids.length],
        ),
    }
    const canaries: number[] = []
    for (const canary of request.canaries) {
      const vector = await one(state.loaded, canary.text, canary.role)
      canaries.push(cosine(vector, Float32Array.from(canary.vector)))
    }
    return { cosines: canaries, ms: performance.now() - started, dims: request.settings.dims }
  })
}

/** Vectors for texts, L2-normalised, one after another in one flat array. */
export function embed(request: BrainWorkerProtocol.Embed) {
  return serial(async () => {
    const loaded = state.loaded
    if (!loaded || loaded.key !== request.key) throw new Error("The search model is not loaded.")
    const vectors = new Float32Array(request.texts.length * loaded.settings.dims)
    for (const [index, text] of request.texts.entries())
      vectors.set(await one(loaded, text, request.role), index * loaded.settings.dims)
    return { vectors, dims: loaded.settings.dims }
  })
}

/** Which model is loaded now, if any. */
export function loaded() {
  return state.loaded?.key
}

// One at a time: ONNX Runtime's WASM session runs one request at once.
function serial<A>(run: () => Promise<A>): Promise<A> {
  const next = state.queue.then(run, run)
  state.queue = next.catch(() => undefined)
  return next
}

async function one(loaded: Loaded, text: string, role: "query" | "passage") {
  const settings = loaded.settings
  const ids = cut(
    loaded.encode(role === "query" ? `${settings.query}${text}` : text),
    role === "query" ? settings.queryTokens : settings.maxTokens,
    role,
  )
  const names = loaded.session.inputNames
  const feeds = Object.fromEntries(
    [
      ["input_ids", ids],
      ["attention_mask", ids.map(() => 1)],
      ["token_type_ids", ids.map(() => 0)],
    ].flatMap(([name, values]) =>
      names.includes(name as string) ? [[name as string, loaded.tensor(values as number[])]] : [],
    ),
  )
  const output = await loaded.session.run(feeds as Parameters<InferenceSession["run"]>[0])
  const hidden =
    output[
      loaded.session.outputNames.includes("last_hidden_state") ? "last_hidden_state" : loaded.session.outputNames[0]!
    ]!
  const data = hidden.data as Float32Array
  const dims = settings.dims
  // [batch, sequence, dims] holds a vector per token; [batch, dims] one for the text.
  const pooled =
    hidden.dims.length === 2
      ? data.slice(0, dims)
      : settings.pooling === "cls"
        ? data.slice(0, dims)
        : Float32Array.from({ length: dims }, (_, at) => {
            const tokens = Number(hidden.dims[1])
            return (
              Array.from({ length: tokens }, (_, token) => data[token * dims + at]!).reduce(
                (sum, value) => sum + value,
                0,
              ) / tokens
            )
          })
  if (pooled.length !== dims) throw new Error(`The search model gave ${pooled.length} dimensions, not ${dims}.`)
  return normalize(pooled)
}

/**
 * A text's wordpieces cut to `max`, keeping its first token and last (the tokenizer's [CLS] and [SEP]): a passage keeps
 * its head, a request its head and its tail, since a long request often ends with what it asks.
 */
export function cut(ids: readonly number[], max: number, role: "query" | "passage") {
  if (ids.length <= max) return ids
  const inner = ids.slice(1, -1)
  const room = max - 2
  const head = role === "query" ? Math.ceil(room / 2) : room
  return [ids[0]!, ...inner.slice(0, head), ...inner.slice(inner.length - (room - head)), ids.at(-1)!].slice(0, max)
}

function normalize(vector: Float32Array) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return norm > 0 ? vector.map((value) => value / norm) : vector
}

function cosine(a: Float32Array, b: Float32Array) {
  if (a.length !== b.length) return 0
  const dot = a.reduce((sum, value, index) => sum + value * b[index]!, 0)
  const norms = Math.sqrt(
    a.reduce((sum, value) => sum + value * value, 0) * b.reduce((sum, value) => sum + value * value, 0),
  )
  return norms > 0 ? dot / norms : 0
}
