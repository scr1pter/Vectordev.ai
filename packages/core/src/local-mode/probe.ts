export * as LocalProbe from "./probe"

import { Context, Layer, Option, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Hash } from "../util/hash"
import { ConfigLocalV1 } from "../v1/config/local"
import { LocalErrors } from "./errors"
import { LocalPolicy } from "./policy"
import { LlamaCppServer } from "./servers/llamacpp"
import { LMStudioServer } from "./servers/lmstudio"
import { OllamaServer } from "./servers/ollama"
import { OpenAIServer } from "./servers/openai"
import { SGLangServer } from "./servers/sglang"
import { VLLMServer } from "./servers/vllm"

// One model server, at an address: what kind it is, which models it has and how they run there, and the identity it
// had when the user added it. `probe` reads a server at any address, but only when someone asks for that address (a
// typed URL, or Detect's fixed list of ports on this computer); nothing here scans a network. `check` runs a model
// through the requests Vector's agent makes, with that role's real tools, and says what to fix. `patch` turns what
// was found into the global config it writes; a repository's config is never written.
//
// Requests to a server use `redirect: "error"`, so a server cannot send Vector somewhere else, and the text a server
// writes into an error is shown as plain text (LocalErrors.plain).

export const Kind = Schema.Literals(["ollama", "lmstudio", "vllm", "llamacpp", "sglang", "openai"]).annotate({
  identifier: "LocalServerKind",
})
export type Kind = typeof Kind.Type

export const Model = Schema.Struct({
  id: Schema.String,
  /** The context the server runs it with, in tokens, when the server says. */
  context: Schema.optional(Schema.Number),
  /** The largest context the model supports, which a server may load less of. */
  trained: Schema.optional(Schema.Number),
  /** The reply limit Vector writes for it: min(8192, context / 4). */
  output: Schema.optional(Schema.Number),
  /** Whether the server says it calls tools. Unknown until Check models when the server does not say. */
  tools: Schema.optional(Schema.Boolean),
  vision: Schema.optional(Schema.Boolean),
  loaded: Schema.optional(Schema.Boolean),
  /** Its size on disk in bytes, which is about what loading it takes. */
  size: Schema.optional(Schema.Number),
  parameters: Schema.optional(Schema.String),
  quantization: Schema.optional(Schema.String),
  family: Schema.optional(Schema.String),
  /** It runs on the server maker's cloud, not on this server: an Ollama cloud model. */
  cloud: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "LocalServerModel" })
export type Model = typeof Model.Type

/** Why a server may pass prompts on to services it is set up with. */
export const Forwards = Schema.Literals(["ollama-cloud", "litellm"]).annotate({ identifier: "LocalServerForwards" })
export type Forwards = typeof Forwards.Type

export const Server = Schema.Struct({
  kind: Kind,
  name: Schema.String,
  origin: Schema.String,
  /** The OpenAI-compatible address a provider uses, such as http://127.0.0.1:11434/v1. */
  baseURL: Schema.String,
  version: Schema.optional(Schema.String),
  class: Schema.Literals(["this-computer", "your-network", "internet"]),
  encrypted: Schema.Boolean,
  /** How many requests it serves at once, which Vector writes as the provider's `concurrency`. */
  concurrency: Schema.optional(Schema.Number),
  forwards: Schema.optional(Forwards),
  models: Schema.Array(Model),
  pin: ConfigLocalV1.Pin,
}).annotate({ identifier: "LocalServer" })
export type Server = typeof Server.Type
export type Pin = typeof ConfigLocalV1.Pin.Type

/** Reads a JSON answer from the server: undefined when nothing answers, it answers with an error, or not with JSON. */
export type Read = (path: string, body?: unknown) => Promise<unknown>

export type Inspection = {
  readonly version?: string
  readonly models: readonly Model[]
  readonly concurrency?: number
  readonly forwards?: Forwards
}

type Spec = {
  readonly kind: Kind
  readonly name: string
  readonly identify: string
  readonly matches: (json: unknown) => boolean
  readonly inspect: (read: Read, identified: unknown) => Promise<Inspection>
}

// In the order a server is recognised: an LM Studio server answers every path with 200, and most servers also answer
// /v1/models, so the specific answers win over the generic one. llama.cpp comes before anything else that may sit
// on its shared port 8080.
export const SPECS: readonly Spec[] = [
  OllamaServer,
  LlamaCppServer,
  SGLangServer,
  VLLMServer,
  LMStudioServer,
  OpenAIServer,
]

/** How long to wait for a server on this computer to answer the first request, and for one elsewhere. */
export const IDENTIFY_TIMEOUT = { loopback: 400, remote: 3_000 }
const INSPECT_TIMEOUT = 5_000
// The most a server's answer to one read may be; a model list is a few hundred kilobytes at most.
const MAX_BYTES = 4 * 1024 * 1024

export type Options = {
  readonly headers?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
  /** How long the first request may take, in milliseconds. */
  readonly timeout?: number
}

/**
 * Where a typed address points: its origin, the root its paths hang off (an address may have a path prefix in front
 * of `/v1`) and the OpenAI-compatible base address. Undefined for anything that is not a plain http or https URL.
 */
export function locate(input: string) {
  const text = input.trim()
  const url = URL.canParse(text) ? new URL(text) : undefined
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return undefined
  // Credentials belong in the provider's key or headers, never in an address Vector logs and pins.
  if (url.username || url.password) return undefined
  const origin = LocalPolicy.origin(url)
  if (!origin) return undefined
  const root = `${origin}${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}`
  return { origin, root, baseURL: `${root}/v1` }
}

/** The server at `input`, or undefined when nothing Vector recognises answers there. */
export async function probe(input: string, options: Options = {}): Promise<Server | undefined> {
  const place = locate(input)
  if (!place) return undefined
  const hostname = new URL(place.origin).hostname
  const timeout =
    options.timeout ?? (LocalPolicy.loopback(hostname) ? IDENTIFY_TIMEOUT.loopback : IDENTIFY_TIMEOUT.remote)
  const identify = reader(place.root, { ...options, timeout })
  const answers = await Promise.all(SPECS.map(async (spec) => ({ spec, json: await identify(spec.identify) })))
  const found = answers.find((answer) => answer.json !== undefined && answer.spec.matches(answer.json))
  if (!found) return undefined
  const inspection = await found.spec.inspect(reader(place.root, { ...options, timeout: INSPECT_TIMEOUT }), found.json)
  const models = inspection.models
    .map((model) => (model.context ? { ...model, output: output(model.context) } : model))
    .toSorted((left, right) => left.id.localeCompare(right.id))
  const encrypted = place.origin.startsWith("https:")
  // The server writes its version, and Vector shows it ("Ollama 0.12.6 on this computer") and pins it, so it is kept
  // as plain text like a server's error.
  const version = inspection.version === undefined ? undefined : LocalErrors.plain(inspection.version)
  return {
    kind: found.spec.kind,
    name: found.spec.name,
    origin: place.origin,
    baseURL: place.baseURL,
    version,
    class: LocalPolicy.hostClass(hostname),
    encrypted,
    concurrency: inspection.concurrency,
    forwards: inspection.forwards,
    models,
    pin: {
      kind: found.spec.kind,
      version,
      models: modelSet(models),
      spki: encrypted ? await spki(place.origin, options.timeout ?? IDENTIFY_TIMEOUT.remote) : null,
    },
  }
}

/** The reply limit Vector writes for a model with this context: at most 8,192 tokens and a quarter of the context. */
export function output(context: number) {
  return Math.max(1, Math.min(8192, Math.floor(context / 4)))
}

function reader(root: string, options: Options & { readonly timeout: number }): Read {
  return async (path, body) => {
    const response = await fetch(`${root}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: signal(options.signal, options.timeout),
    }).catch(() => undefined)
    if (!response) return undefined
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return undefined
    }
    const text = await limited(response, MAX_BYTES).catch(() => undefined)
    if (text === undefined) return undefined
    return Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text))
  }
}

function signal(outer: AbortSignal | undefined, timeout: number) {
  return outer ? AbortSignal.any([outer, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
}

// The body as text, or undefined once it passes `max` bytes.
async function limited(response: Response, max: number) {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  const state = { size: 0 }
  while (true) {
    const next = await reader.read()
    if (next.done) break
    state.size += next.value.byteLength
    if (state.size > max) {
      await reader.cancel()
      return undefined
    }
    chunks.push(next.value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/** A hash of a model list, so a pin notices when a server answers with a different set of models. */
export function modelSet(models: readonly { readonly id: string }[]) {
  return `sha256:${Hash.sha256(
    models
      .map((model) => model.id)
      .toSorted()
      .join("\n"),
  )}`
}

/**
 * The SHA-256 of an https server's public key (its SubjectPublicKeyInfo, base64), as certificate pins write it, or
 * null when no certificate came back. The connection only reads the certificate, so it does not require one the
 * system trusts; requests to the server still check its certificate as usual.
 */
export async function spki(origin: string, timeout = IDENTIFY_TIMEOUT.remote): Promise<string | null> {
  const { connect } = await import("node:tls")
  const { createHash, X509Certificate } = await import("node:crypto")
  const { isIP } = await import("node:net")
  const url = new URL(origin)
  const host = url.hostname.replace(/^\[|\]$/g, "")
  return new Promise((resolve) => {
    const socket = connect({
      host,
      port: Number(url.port || 443),
      servername: isIP(host) ? undefined : host,
      rejectUnauthorized: false,
    })
    const finish = (value: string | null) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeout)
    socket.once("error", () => finish(null))
    socket.once("secureConnect", () => {
      const raw = socket.getPeerCertificate()?.raw
      if (!raw) return finish(null)
      const key = new X509Certificate(raw).publicKey.export({ type: "spki", format: "der" })
      finish(createHash("sha256").update(key).digest("base64"))
    })
  })
}

export const Change = Schema.Literals(["kind", "version", "models", "spki"])
export type Change = typeof Change.Type

/** What differs between the identity a server was added with and the one it has now. */
export function changes(pin: Pin, server: Server): readonly Change[] {
  const differs: Record<Change, boolean> = {
    kind: pin.kind !== server.pin.kind,
    version: pin.version !== undefined && pin.version !== server.pin.version,
    models: pin.models !== undefined && pin.models !== server.pin.models,
    spki: (pin.spki ?? null) !== (server.pin.spki ?? null),
  }
  return Change.literals.filter((change) => differs[change])
}

/** The warning when a server's identity changed: "gpu-box:8000 now answers as a different server. …" */
export function changedMessage(origin: string) {
  return `${new URL(origin).host} now answers as a different server. Check it before sending prompts.`
}

/** The note for a server on this computer, which anyone signed in to it could have started. */
export const SHARED_MACHINE = "Another user on this computer could run a server on this port."

export type Verified =
  | { readonly status: "same"; readonly server: Server }
  | {
      readonly status: "changed"
      readonly server: Server
      readonly changes: readonly Change[]
      readonly message: string
    }
  | { readonly status: "unreachable" }

/**
 * Reads the server at `origin` again and compares it with its pin. A change holds the server in `holds`, so its
 * requests are refused until the user confirms it; a server that matches is not released by this, only by confirm.
 */
export async function verify(input: {
  readonly origin: string
  readonly pin: Pin
  readonly holds?: Holds
  readonly options?: Options
}): Promise<Verified> {
  const server = await probe(input.origin, input.options)
  if (!server) return { status: "unreachable" }
  const changed = changes(input.pin, server)
  if (changed.length === 0) return { status: "same", server }
  const message = changedMessage(server.origin)
  input.holds?.hold(server.origin, message)
  return { status: "changed", server, changes: changed, message }
}

/** A request to a server whose identity changed, refused until the user confirms the server. */
export class IdentityChanged extends Error {
  override readonly name = "IdentityChanged"
  constructor(
    readonly origin: string,
    message: string,
  ) {
    super(message)
  }
}

export interface Holds {
  /** Holds the server's requests until `confirm`. */
  readonly hold: (origin: string, message: string) => void
  /** The warning for a held server, or undefined. */
  readonly held: (origin: string) => string | undefined
  /** The user checked the server: its requests go again. The caller writes the server's new pin. */
  readonly confirm: (origin: string) => void
  /** Throws IdentityChanged while the server at `url` is held. Model requests call this before they are sent. */
  readonly gate: (url: string | URL) => void
}

export class HoldsService extends Context.Service<HoldsService, Holds>()("@vector/LocalProbeHolds") {}

export function makeHolds(): Holds {
  const held = new Map<string, string>()
  const key = (url: string | URL) => LocalPolicy.origin(url) ?? String(url)
  return {
    hold: (origin, message) => {
      held.set(key(origin), message)
    },
    held: (origin) => held.get(key(origin)),
    confirm: (origin) => {
      held.delete(key(origin))
    },
    gate: (url) => {
      const origin = key(url)
      const message = held.get(origin)
      if (message) throw new IdentityChanged(origin, message)
    },
  }
}

export const holdsLayer = Layer.sync(HoldsService, () => HoldsService.of(makeHolds()))

export const holdsNode = makeGlobalNode({ service: HoldsService, layer: holdsLayer, deps: [] })

// Check models ----------------------------------------------------------------------------------------------------

/** One of the role's tools as a model sees it: an OpenAI function with a JSON schema for its parameters. */
export type Tool = {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
}

export const CheckResult = Schema.Literals([
  "works",
  "no-tools",
  "schema-rejected",
  "context-too-small",
  "failed",
  // Not a result: the check stopped before loading the model to ask the user first.
  "ask",
])
export type CheckResult = typeof CheckResult.Type

export type Checked = {
  readonly model: string
  readonly result: CheckResult
  /** What happened and what to do, in Vector's words. */
  readonly message?: string
  /** The context the model ran with, when the server said. */
  readonly context?: number
  /** Milliseconds from sending the first request to the first token. */
  readonly ttft_ms?: number
  readonly requests: number
  readonly checked_at: number
  readonly server_version?: string
  /** For an Ollama model whose context is too small: the copy the user may ask Vector to create. Never automatic. */
  readonly offer?: OllamaServer.Copy
}

export type CheckInput = {
  readonly server: Server
  readonly model: string
  /** The role's tools, as the agent sends them. */
  readonly tools: readonly Tool[]
  /** The context the role needs, in tokens (its fixed prompt plus headroom). */
  readonly required?: number
  /** Who needs the context, for the message: "Vector's agent" unless said. */
  readonly role?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly apiKey?: string
  /** Memory this computer has free, in bytes, for a server on this computer. */
  readonly free?: number
  /** The user already accepted the memory warning. */
  readonly confirmed?: boolean
  readonly signal?: AbortSignal
  /** How long each request may take; a model's first load can take minutes. Default 600 s. */
  readonly timeout?: number
}

const CHECK_TIMEOUT = 600_000
// What loading a model takes beyond its file: room for its context. An estimate, so the warning says "about".
const LOAD_MARGIN = 1.1
const GB = 1024 ** 3

const SYSTEM =
  "Vector is checking that you can call tools. When asked to call a tool, call it with the arguments given and write nothing else."

/**
 * Runs a model through 2 or 3 requests with the role's tools: a call to a simple tool (which also times the first
 * token), a call to the tool with the most nested parameters, and a reply to a tool result. Never runs on its own:
 * Check models is a button. Before loading a model too big for this computer's free memory it stops and asks.
 */
export async function check(input: CheckInput): Promise<Checked> {
  const info = input.server.models.find((model) => model.id === input.model)
  const base = {
    model: input.model,
    checked_at: Date.now(),
    server_version: input.server.version,
    requests: 0,
  }
  // A model the user typed may not be on the server's list, so an Ollama cloud model is also told by its name.
  if (info?.cloud || (input.server.kind === "ollama" && OllamaServer.cloud({ name: input.model })))
    return {
      ...base,
      result: "failed",
      message: `${input.model} runs on ollama.com, not on this server, so Vector does not check it here.`,
    }
  const ask = memoryWarning(input, info)
  if (ask) return { ...base, result: "ask", message: ask }
  const small = tooSmall(input, info?.context)
  if (small) return { ...base, ...small }
  // Every tool goes with each request, as the agent sends them, but the check asks for a call only to tools its own
  // example fits, which leaves out one whose parameters refer to themselves too deeply to write out.
  const callable = input.tools.filter((tool) => fits(tool.parameters, example(tool.parameters)))
  if (callable.length === 0) return { ...base, result: "failed", message: "There are no tools to check with." }

  const simple = simplest(callable)
  const first = await complete(input, call(simple))
  const done = { ...base, ttft_ms: first.ttft }
  if (first.error !== undefined) return { ...done, requests: 1, ...failure(input, first.error) }

  // Ollama and LM Studio load a model on its first request, so only now is the context it runs with known.
  const loads =
    input.server.kind === "ollama"
      ? OllamaServer.loadedContext
      : input.server.kind === "lmstudio"
        ? LMStudioServer.loadedContext
        : undefined
  const context =
    (loads ? await loads(reader(root(input.server), readOptions(input)), input.model) : undefined) ?? info?.context
  const loaded = tooSmall(input, context)
  if (loaded) return { ...done, requests: 1, context, ...loaded }
  const wrong = mismatch(input, simple, first)
  if (wrong) return { ...done, requests: 1, context, ...wrong }

  const nested = deepest(callable)
  const separate = nested.name !== simple.name
  const second = separate ? await complete(input, call(nested)) : first
  const asked = separate ? 2 : 1
  if (second.error !== undefined) return { ...done, requests: asked, context, ...failure(input, second.error, nested) }
  const nestedWrong = mismatch(input, nested, second)
  if (nestedWrong) return { ...done, requests: asked, context, ...nestedWrong }

  const reply = await complete(input, answer(simple, first))
  if (reply.error !== undefined) return { ...done, requests: asked + 1, context, ...failure(input, reply.error) }
  return { ...done, requests: asked + 1, context, result: "works" }
}

// The root a server's own paths hang off: its OpenAI-compatible address without /v1.
function root(server: Server) {
  return server.baseURL.replace(/\/v1$/, "")
}

function readOptions(input: CheckInput) {
  return { headers: headers(input), signal: input.signal, timeout: INSPECT_TIMEOUT }
}

function headers(input: CheckInput) {
  return { ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}), ...input.headers }
}

function memoryWarning(input: CheckInput, info: Model | undefined) {
  if (input.confirmed || input.server.class !== "this-computer") return undefined
  if (!info?.size || info.loaded !== false || input.free === undefined) return undefined
  const needed = info.size * LOAD_MARGIN
  if (needed <= input.free) return undefined
  return `Loading this model needs about ${Math.ceil(needed / GB)} GB; this computer has ${Math.floor(input.free / GB)} GB free. It may slow the computer down.`
}

function tooSmall(input: CheckInput, context: number | undefined) {
  if (!input.required || !context || context >= input.required) return undefined
  const about = (Math.ceil(input.required / 1_000) * 1_000).toLocaleString("en-US")
  const role = input.role ?? "Vector's agent"
  const offer = input.server.kind === "ollama" ? OllamaServer.copy(input.model, input.required) : undefined
  return {
    result: "context-too-small" as const,
    message: `${input.model} has a ${context.toLocaleString("en-US")}-token context. ${role} needs about ${about}. Raise the context size or pick another model.`,
    offer,
  }
}

type Completion = {
  readonly calls: readonly { readonly id: string; readonly name: string; readonly arguments: string }[]
  readonly text: string
  readonly ttft?: number
  /** The server's error text, or the connection error's message. */
  readonly error?: string
  /** The reply stopped at its token limit (finish_reason "length"). */
  readonly cut?: boolean
}

// The most a check's reply may take. A reasoning model (Qwen3 thinking, gpt-oss, Kimi K2 Thinking) reasons before it
// calls the tool, which can take several hundred tokens even for this request, so the room is larger than the call
// needs; a reply that still runs out says so rather than counting as a model that cannot call tools.
const CHECK_REPLY = 2048

// The error a check records for an answer larger than MAX_BYTES.
const TOO_LARGE = "More than 4 MB, which Vector stopped reading."

type Messages = readonly Readonly<Record<string, unknown>>[]

function call(tool: Tool): Messages {
  return [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `Call the ${tool.name} tool with these arguments: ${JSON.stringify(example(tool.parameters))}`,
    },
  ]
}

function answer(tool: Tool, first: Completion): Messages {
  const made = first.calls[0]
  return [
    ...call(tool),
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: made.id, type: "function", function: { name: made.name, arguments: made.arguments } }],
    },
    { role: "tool", tool_call_id: made.id, content: "Done." },
  ]
}

async function complete(input: CheckInput, messages: Messages): Promise<Completion> {
  const started = performance.now()
  const response = await fetch(`${input.server.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", ...headers(input) },
    body: JSON.stringify({
      model: input.model,
      messages,
      tools: input.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
      tool_choice: "auto",
      stream: true,
      max_tokens: CHECK_REPLY,
      temperature: 0,
    }),
    redirect: "error",
    signal: signal(input.signal, input.timeout ?? CHECK_TIMEOUT),
  }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
  if (typeof response === "string") return { calls: [], text: "", error: response }
  // A server someone else runs writes these answers, so no more than MAX_BYTES of one is read.
  const text = () =>
    limited(response, MAX_BYTES)
      .then((value) => value ?? TOO_LARGE)
      .catch(() => "")
  if (!response.ok) return { calls: [], text: "", error: (await text()) || `${response.status}` }
  if (!(response.headers.get("content-type") ?? "").includes("event-stream")) {
    const ttft = Math.round(performance.now() - started)
    return { ...whole(await text()), ttft }
  }
  return stream(response, started)
}

const Delta = Schema.Struct({
  error: Schema.optional(Schema.Unknown),
  choices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        finish_reason: Schema.optional(Schema.NullOr(Schema.String)),
        delta: Schema.optional(
          Schema.Struct({
            content: Schema.optional(Schema.NullOr(Schema.String)),
            // Servers send a reasoning model's thinking under either name, depending on the server and its version.
            reasoning: Schema.optional(Schema.NullOr(Schema.String)),
            reasoning_content: Schema.optional(Schema.NullOr(Schema.String)),
            tool_calls: Schema.optional(
              Schema.Array(
                Schema.Struct({
                  index: Schema.optional(Schema.Number),
                  id: Schema.optional(Schema.String),
                  function: Schema.optional(
                    Schema.Struct({ name: Schema.optional(Schema.String), arguments: Schema.optional(Schema.String) }),
                  ),
                }),
              ),
            ),
          }),
        ),
      }),
    ),
  ),
})

const Whole = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      finish_reason: Schema.optional(Schema.NullOr(Schema.String)),
      message: Schema.Struct({
        content: Schema.optional(Schema.NullOr(Schema.String)),
        tool_calls: Schema.optional(
          Schema.Array(
            Schema.Struct({
              id: Schema.optional(Schema.String),
              function: Schema.Struct({ name: Schema.String, arguments: Schema.optional(Schema.String) }),
            }),
          ),
        ),
      }),
    }),
  ),
})

const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

function whole(text: string): Completion {
  const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(Whole)(Option.getOrUndefined(json(text))))
  if (!parsed) return { calls: [], text: "", error: text }
  const choice = parsed.choices[0]
  return {
    text: choice?.message.content ?? "",
    calls: (choice?.message.tool_calls ?? []).map((item, index) => ({
      id: item.id ?? `call_${index}`,
      name: item.function.name,
      arguments: item.function.arguments ?? "",
    })),
    cut: choice?.finish_reason === "length",
  }
}

async function stream(response: Response, started: number): Promise<Completion> {
  const calls = new Map<number, { id: string; name: string; arguments: string }>()
  const state: { text: string; ttft?: number; error?: string; rest: string; size: number; finish?: string } = {
    text: "",
    rest: "",
    size: 0,
  }
  const decoder = new TextDecoder()
  const reader = response.body?.getReader()
  if (!reader) return { calls: [], text: "" }
  const take = (line: string) => {
    if (!line.startsWith("data:")) return
    const payload = line.slice(5).trim()
    if (!payload || payload === "[DONE]") return
    const delta = Option.getOrUndefined(Schema.decodeUnknownOption(Delta)(Option.getOrUndefined(json(payload))))
    if (!delta) return
    if (delta.error !== undefined) {
      state.error = payload
      return
    }
    const choice = delta.choices?.[0]
    if (choice?.finish_reason) state.finish = choice.finish_reason
    const part = choice?.delta
    if (!part) return
    if (
      state.ttft === undefined &&
      (part.content || part.reasoning || part.reasoning_content || part.tool_calls?.length)
    )
      state.ttft = Math.round(performance.now() - started)
    state.text += part.content ?? ""
    part.tool_calls?.forEach((item, position) => {
      const index = item.index ?? position
      const current = calls.get(index) ?? { id: item.id ?? `call_${index}`, name: "", arguments: "" }
      calls.set(index, {
        id: item.id ?? current.id,
        name: current.name + (item.function?.name ?? ""),
        arguments: current.arguments + (item.function?.arguments ?? ""),
      })
    })
  }
  while (true) {
    const next = await reader.read().catch((error: unknown) => {
      state.error = error instanceof Error ? error.message : String(error)
      return undefined
    })
    if (!next || next.done) break
    state.size += next.value.byteLength
    if (state.size > MAX_BYTES) {
      await reader.cancel().catch(() => undefined)
      state.error = TOO_LARGE
      break
    }
    const lines = (state.rest + decoder.decode(next.value, { stream: true })).split(/\r?\n/)
    state.rest = lines.pop() ?? ""
    lines.forEach(take)
  }
  if (state.error !== TOO_LARGE) take(state.rest)
  return {
    calls: [...calls.values()],
    text: state.text,
    ttft: state.ttft,
    error: state.error,
    cut: state.finish === "length",
  }
}

function failure(input: CheckInput, text: string, tool?: Tool) {
  const explained = LocalErrors.explain({ text, model: input.model, origin: input.server.origin })
  if (explained && ["tools-unsupported", "auto-tool-choice", "jinja"].includes(explained.kind))
    return { result: "no-tools" as const, message: explained.fix }
  if (explained?.kind === "context-overflow") return { result: "context-too-small" as const, message: explained.fix }
  const rejected = rejection(input.server, text, tool)
  if (rejected) return { result: "schema-rejected" as const, message: rejected }
  if (explained) return { result: "failed" as const, message: explained.fix }
  return { result: "failed" as const, message: `${input.server.name} answered: ${LocalErrors.plain(text)}` }
}

// How servers say they could not read a tool's JSON schema. Written from each server's source and issue tracker, not
// yet confirmed against recorded responses, so an error that matches none keeps the server's words.
const REJECTIONS: readonly RegExp[] = [
  // llama.cpp: "JSON schema conversion failed", "Unrecognized schema: …", "Unsupported ref …".
  /json schema conversion failed|unrecognized schema|unsupported ref|failed to parse grammar/i,
  // Ollama: "json: cannot unmarshal array into Go struct field .tools.function.parameters.properties.type of type string".
  /cannot unmarshal .*(?:tools|parameters|properties)/i,
  // vLLM and others: "… is not supported by xgrammar", "Invalid JSON schema".
  /not supported by (?:xgrammar|outlines|guidance)|invalid (?:json )?schema|unsupported (?:json )?schema|schema .*not supported/i,
]

const UPDATE: Record<Kind, string> = {
  ollama: "Update Ollama: older versions refuse some tool parameter types.",
  llamacpp: "Update llama.cpp: older builds cannot turn some tool schemas into a grammar.",
  vllm: "Update vLLM, or start it with another --guided-decoding-backend.",
  sglang: "Update SGLang, or start it with another --grammar-backend.",
  lmstudio: "Update LM Studio and the model's runtime.",
  openai: "Update the server, or ask whoever runs it which tool schemas it accepts.",
}

/** The message for a server that refused the shape of a tool's parameters, or undefined when it said something else. */
export function rejection(server: Pick<Server, "kind" | "name">, text: string, tool?: Pick<Tool, "name">) {
  if (!REJECTIONS.some((pattern) => pattern.test(text))) return undefined
  const which = tool ? `the ${tool.name} tool's parameters` : "the parameters of Vector's tools"
  return `${server.name} could not read ${which}. ${UPDATE[server.kind]} The server said: ${LocalErrors.plain(text)}`
}

function mismatch(input: CheckInput, tool: Tool, completion: Completion) {
  const made = completion.calls[0]
  // A reply that ran out of tokens before any call says nothing about tool calling, so it does not mark the model as
  // one without tools.
  if (!made && completion.cut)
    return {
      result: "failed" as const,
      message: `${input.model} used its whole ${CHECK_REPLY.toLocaleString("en-US")}-token reply before it called a tool, so Vector could not tell whether it calls tools. Lower its reasoning effort, or pick another model.`,
    }
  if (!made)
    return {
      result: "no-tools" as const,
      message: `${input.model} answered without calling a tool. Vector's agent works through tools, so pick a model that supports tool calling.`,
    }
  const parsed = Option.getOrUndefined(json(made.arguments || "{}"))
  if (made.name !== tool.name || !fits(tool.parameters, parsed, tool.parameters))
    return {
      result: "failed" as const,
      // The model wrote the name it called, so it is shown as plain text like a server's error.
      message: `${input.model} called ${LocalErrors.plain(made.name) || "a tool"} with arguments that do not match the ${tool.name} tool's parameters, so its tool calls may fail in Vector.`,
    }
  return undefined
}

type JsonSchema = Readonly<Record<string, unknown>>

function record(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const MAX_HOPS = 16

// A schema with its $ref followed, against the tool's own $defs. A chain of refs that comes back to itself resolves to
// an empty schema.
function resolve(schema: unknown, root: JsonSchema, hops = 0): JsonSchema {
  if (!record(schema)) return {}
  const ref = schema["$ref"]
  if (typeof ref !== "string") return schema
  if (hops >= MAX_HOPS) return {}
  const name = ref.replace(/^#\/(?:\$defs|definitions)\//, "")
  const defs = record(root["$defs"]) ? root["$defs"] : record(root["definitions"]) ? root["definitions"] : {}
  return resolve(defs[name], root, hops + 1)
}

function choice(schema: JsonSchema, root: JsonSchema) {
  const options = [schema["anyOf"], schema["oneOf"]].find(Array.isArray) ?? []
  return options.map((item) => resolve(item, root)).find((item) => item["type"] !== "null")
}

function kindOf(schema: JsonSchema) {
  const type = schema["type"]
  if (Array.isArray(type)) return type.find((item) => item !== "null")
  return type
}

// How far example and fits follow a schema into itself. A tool's parameters can refer back to themselves (a filter
// made of filters, as some MCP tools have), and with a required field on the way an example would never end. Vector's
// own tools nest a few levels, far inside these.
const EXAMPLE_DEPTH = 12
const FITS_DEPTH = 64

/**
 * Arguments that satisfy a JSON schema: every required field, the first of each enum, one item of each list. Past
 * EXAMPLE_DEPTH a list is empty and an object has no fields, so a schema that refers to itself still gets an example,
 * which may then not fit it.
 */
export function example(
  input: unknown,
  root: JsonSchema = record(input) ? input : {},
  budget = EXAMPLE_DEPTH,
): unknown {
  const schema = resolve(input, root)
  const alternative = budget > 0 ? choice(schema, root) : undefined
  if (alternative) return example(alternative, root, budget - 1)
  if (Array.isArray(schema["enum"]) && schema["enum"].length > 0) return schema["enum"][0]
  if ("const" in schema) return schema["const"]
  const type = kindOf(schema)
  if (type === "object" || record(schema["properties"])) {
    if (budget <= 0) return {}
    const properties = record(schema["properties"]) ? schema["properties"] : {}
    const required = Array.isArray(schema["required"])
      ? schema["required"].filter((key) => typeof key === "string")
      : []
    return Object.fromEntries(required.map((key) => [key, example(properties[key], root, budget - 1)]))
  }
  if (type === "array") {
    if (budget <= 0) return []
    const count = Math.max(1, typeof schema["minItems"] === "number" ? schema["minItems"] : 1)
    return Array.from({ length: count }, () => example(schema["items"], root, budget - 1))
  }
  if (type === "integer" || type === "number") return typeof schema["minimum"] === "number" ? schema["minimum"] : 1
  if (type === "boolean") return false
  if (type === "string") return "check.txt"
  return "check"
}

/**
 * Whether a value has the shape a JSON schema asks for: types and required fields, nested. Formats are not checked. A
 * value nested past FITS_DEPTH does not fit, and neither does any value for a schema whose alternatives only lead back
 * to itself.
 */
export function fits(
  input: unknown,
  value: unknown,
  root: JsonSchema = record(input) ? input : {},
  budget = FITS_DEPTH,
): boolean {
  if (budget <= 0) return false
  const schema = resolve(input, root)
  const options = [schema["anyOf"], schema["oneOf"]].find(Array.isArray)
  if (options) return options.some((item) => fits(item, value, root, budget - 1))
  if (Array.isArray(schema["enum"])) return schema["enum"].some((item) => item === value)
  const types = Array.isArray(schema["type"]) ? schema["type"] : schema["type"] === undefined ? [] : [schema["type"]]
  if (types.length > 0 && !types.some((type) => typed(type, value))) return false
  if (record(value) && (types.includes("object") || record(schema["properties"]))) {
    const properties = record(schema["properties"]) ? schema["properties"] : {}
    const required = Array.isArray(schema["required"]) ? schema["required"] : []
    if (!required.every((key) => typeof key === "string" && key in value)) return false
    return Object.entries(value).every(
      ([key, item]) => !(key in properties) || fits(properties[key], item, root, budget - 1),
    )
  }
  if (Array.isArray(value) && schema["items"] !== undefined)
    return value.every((item) => fits(schema["items"], item, root, budget - 1))
  return true
}

function typed(type: unknown, value: unknown) {
  if (type === "null") return value === null
  if (type === "array") return Array.isArray(value)
  if (type === "object") return record(value)
  if (type === "integer") return Number.isInteger(value)
  if (type === "number") return typeof value === "number"
  return typeof value === type
}

/** How deeply a schema nests objects and lists. */
export function depth(
  input: unknown,
  root: JsonSchema = record(input) ? input : {},
  seen = new Set<unknown>(),
): number {
  const schema = resolve(input, root)
  if (seen.has(schema)) return 0
  const inner = new Set([...seen, schema])
  const children = [
    ...(record(schema["properties"]) ? Object.values(schema["properties"]) : []),
    ...(schema["items"] === undefined ? [] : [schema["items"]]),
    ...([schema["anyOf"], schema["oneOf"]].find(Array.isArray) ?? []),
  ]
  const nests = kindOf(schema) === "object" || kindOf(schema) === "array" || record(schema["properties"]) ? 1 : 0
  return nests + Math.max(0, ...children.map((child) => depth(child, root, inner)))
}

function required(tool: Tool) {
  return Array.isArray(tool.parameters["required"]) ? tool.parameters["required"].length : 0
}

// The tool a model can most easily call: the flattest, with the fewest required fields but at least one, so the
// call carries arguments to check.
function simplest(tools: readonly Tool[]) {
  return tools.toSorted(
    (left, right) =>
      depth(left.parameters) - depth(right.parameters) ||
      Number(required(left) === 0) - Number(required(right) === 0) ||
      required(left) - required(right),
  )[0]
}

function deepest(tools: readonly Tool[]) {
  return tools.toSorted((left, right) => depth(right.parameters) - depth(left.parameters))[0]
}

// What Check models writes -----------------------------------------------------------------------------------------

export type Patch = {
  readonly provider: Readonly<Record<string, ProviderPatch>>
  readonly local: {
    readonly endpoints?: readonly string[]
    readonly pins: Readonly<Record<string, Pin>>
    readonly checked?: Readonly<Record<string, typeof ConfigLocalV1.Checked.Type>>
  }
}

type ProviderPatch = {
  readonly options?: { readonly concurrency?: number; readonly headerTimeout?: number; readonly forwards?: boolean }
  readonly models: Readonly<Record<string, ModelPatch>>
}

type ModelPatch = {
  readonly tool_call?: boolean
  readonly limit?: { readonly context: number; readonly output: number }
  readonly modalities?: { readonly input: ("text" | "image")[]; readonly output: "text"[] }
}

// A model's first load can take minutes. Servers on this computer, on the user's network and on the model server list
// get this wait already (provider.ts); one at an internet address, such as a company's https endpoint, gets it written
// too, since it can be added without being listed.
const HEADER_TIMEOUT = 600_000

/**
 * The global config that records a server: the provider's concurrency (unless one is set) and each model's tool
 * calling, limits and image input, and Vector Local's pin for the server, its place on the model server list and each
 * check's result. Lists and records keep what `current` (the global `local` block now) has, since a config update
 * replaces lists. Cloud models and checks that only asked are left out.
 */
export function patch(input: {
  readonly providerID: string
  readonly server: Server
  readonly checks?: readonly Checked[]
  readonly current?: ConfigLocalV1.Info
  /**
   * The `concurrency` the provider's global config sets now. A count someone chose stays, such as 4 for an Ollama
   * started with OLLAMA_NUM_PARALLEL=4, which its API does not report; the server's count is written only where none
   * is set.
   */
  readonly concurrency?: number
  /** Put the server on the model server list. Default true: adding a server lists it. */
  readonly list?: boolean
}): Patch {
  const checks = new Map(
    (input.checks ?? [])
      .filter((item): item is Checked & { readonly result: Exclude<CheckResult, "ask"> } => item.result !== "ask")
      .map((item) => [item.model, item]),
  )
  const models = Object.fromEntries(
    input.server.models
      .filter((model) => !model.cloud)
      .map((model): [string, ModelPatch] => {
        const checked = checks.get(model.id)
        const context = checked?.context ?? model.context
        const tools =
          checked?.result === "works" ? true : checked?.result === "no-tools" ? false : (model.tools ?? undefined)
        return [
          model.id,
          {
            ...(tools === undefined ? {} : { tool_call: tools }),
            ...(context ? { limit: { context, output: output(context) } } : {}),
            ...(model.vision === undefined
              ? {}
              : { modalities: { input: model.vision ? ["text", "image"] : ["text"], output: ["text"] } }),
          },
        ]
      }),
  )
  const options = {
    ...(input.concurrency === undefined && input.server.concurrency ? { concurrency: input.server.concurrency } : {}),
    ...(input.server.class === "internet" ? { headerTimeout: HEADER_TIMEOUT } : {}),
    // A LiteLLM proxy passes every prompt on, so its steps are never counted as free local ones. An Ollama server
    // forwards only its cloud models, which are told apart by name.
    ...(input.server.forwards === "litellm" ? { forwards: true } : {}),
  }
  const endpoints = input.current?.endpoints ?? []
  const checked = Object.fromEntries(
    [...checks.values()].map((item) => [
      `${input.providerID}/${item.model}`,
      {
        server_version: item.server_version,
        checked_at: item.checked_at,
        result: item.result,
        message: item.message,
        ttft_ms: item.ttft_ms,
      },
    ]),
  )
  return {
    provider: {
      [input.providerID]: { ...(Object.keys(options).length ? { options } : {}), models },
    },
    local: {
      ...(input.list === false || endpoints.includes(input.server.origin)
        ? {}
        : { endpoints: [...endpoints, input.server.origin] }),
      pins: { ...input.current?.pins, [input.server.origin]: input.server.pin },
      ...(checks.size ? { checked: { ...input.current?.checked, ...checked } } : {}),
    },
  }
}
