export * as ModelPlans from "./model-plans"

import { createHash } from "node:crypto"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { makeGlobalNode } from "./effect/app-node"
import { Flag } from "./flag/flag"
import { ModelPlanStatus } from "./model-plan-status"

// The stable internal ID stays "vector-plan"; people see the provider as Vector Codium.
export const PROVIDER_ID = "vector-plan"
export const PROVIDER_NAME = "Vector Codium"
export const API_URL = ModelPlanStatus.API_URL
export const CATALOG_URL = `${API_URL}/models`
export const CHAT_URL = `${API_URL}/chat`
export const PURCHASE_URL = ModelPlanStatus.PURCHASE_URL

export const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  contextLength: Schema.Number,
  maxOutputTokens: Schema.Number,
  inputPrice: Schema.Number,
  outputPrice: Schema.Number,
})
export type Model = typeof Model.Type
const Catalog = Schema.Struct({ enabled: Schema.Boolean, models: Schema.Array(Model) })
/** enabled: vectordev.ai offers Codium to this signed-in account. Each chat request checks the balance itself. */
export type Catalog = typeof Catalog.Type
const OFF: Catalog = { enabled: false, models: [] }
const TTL = 60_000
const MAX_ACCOUNTS = 32

export function createClient(
  input: {
    request?: (url: string, init: RequestInit) => Promise<Response>
    now?: () => number
    disabled?: () => boolean
    timeout?: number
  } = {},
) {
  const request = input.request ?? fetch
  const now = input.now ?? Date.now
  const accounts = new Map<string, { expires: number; value: Promise<Catalog> }>()
  const remember = (digest: string, value: Promise<Catalog>) => {
    accounts.delete(digest)
    if (accounts.size >= MAX_ACCOUNTS) accounts.delete(accounts.keys().next().value!)
    accounts.set(digest, { expires: now() + TTL, value })
  }
  const catalog = (token: string | undefined, force = false): Promise<Catalog> => {
    if (!token || input.disabled?.()) return Promise.resolve(OFF)
    // Cache by digest so the account token is never kept as a map key.
    const digest = createHash("sha256").update(token).digest("hex")
    const cached = accounts.get(digest)
    if (!force && cached && cached.expires > now()) return cached.value
    const deadline = Promise.withResolvers<Catalog>()
    // This deadline settles an awaited operation; keep it alive until the race finishes.
    const timer = setTimeout(() => deadline.resolve(OFF), input.timeout ?? 1_500)
    const remote = request(CATALOG_URL, {
      headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
      .then(async (response) => (response.ok ? parse(await response.json()) : OFF))
      .catch(() => OFF)
    const value = Promise.race([remote, deadline.promise]).finally(() => clearTimeout(timer))
    remember(digest, value)
    // Provider listing never waits long on vectordev.ai; a late answer still serves the next caller.
    void remote.then((late) => {
      if (accounts.get(digest)?.value === value) remember(digest, Promise.resolve(late))
    })
    return value
  }
  return { catalog }
}

function parse(body: unknown): Catalog {
  const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(Catalog)(body))
  if (!parsed?.enabled || !parsed.models.length || parsed.models.length > 100) return OFF
  if (
    parsed.models.some(
      (model) =>
        !model.id.trim() ||
        model.id.length > 256 ||
        /\s/.test(model.id) ||
        !model.name.trim() ||
        !Number.isSafeInteger(model.contextLength) ||
        model.contextLength < 1 ||
        !Number.isSafeInteger(model.maxOutputTokens) ||
        model.maxOutputTokens < 1 ||
        model.maxOutputTokens > model.contextLength ||
        !Number.isFinite(model.inputPrice) ||
        model.inputPrice < 0 ||
        !Number.isFinite(model.outputPrice) ||
        model.outputPrice < 0,
    ) ||
    new Set(parsed.models.map((model) => model.id)).size !== parsed.models.length
  )
    return OFF
  return parsed
}

export class Service extends Context.Service<
  Service,
  {
    readonly catalog: (token: string | undefined, force?: boolean) => Effect.Effect<Catalog>
    /** The HTTP transport to the Codium gateway; createFetch fixes its destination and credential. */
    readonly request: (url: string, init: RequestInit) => Promise<Response>
  }
>()("@vector/ModelPlans") {}

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.sync(Service, () => {
    const client = createClient({ disabled: () => Flag.VECTOR_DISABLE_MODELS_FETCH })
    return Service.of({
      catalog: (token, force) => Effect.promise(() => client.catalog(token, force)),
      request: (url, init) => fetch(url, init),
    })
  }),
  deps: [],
})

export async function resolveRoute(input: {
  modelID: string
  credential: () => Promise<string | undefined>
  catalog: (token: string) => Promise<Catalog>
}) {
  const token = await input.credential()
  if (!token) throw new Error("Sign in to Vector to use Vector Codium models. Vector did not send this request.")
  const catalog = await input.catalog(token)
  if (!catalog.enabled)
    throw new Error(
      `Vector Codium is not available right now. Choose another model; see ${PURCHASE_URL}. Vector did not send this request to another provider.`,
    )
  const model = catalog.models.find((model) => model.id === input.modelID)
  if (!model) throw new Error("This model is no longer included in Vector Codium. Choose another Codium model.")
  // A missing plan or balance is left to the gateway: a purchase made a moment ago must work at once.
  return { token, model }
}

// Discard SDK/project routing and billing overrides at the last client boundary. The server also validates the body.
export function serializeRequest(body: unknown, model: Model) {
  const record = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))(body)
  if (Option.isNone(record) || !Array.isArray(record.value.messages) || !record.value.messages.length)
    throw new Error("Include conversation messages in the model request.")
  const requested =
    record.value.max_tokens ?? record.value.max_completion_tokens ?? Math.min(8192, model.maxOutputTokens)
  if (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 1)
    throw new Error("The requested response length is invalid.")
  const text = JSON.stringify({
    ...Object.fromEntries(
      Object.entries(record.value).filter(([key]) =>
        [
          "messages",
          "temperature",
          "top_p",
          "stop",
          "seed",
          "tools",
          "tool_choice",
          "parallel_tool_calls",
          "frequency_penalty",
          "presence_penalty",
          "reasoning",
          "response_format",
        ].includes(key),
      ),
    ),
    model: model.id,
    max_tokens: Math.min(requested, model.maxOutputTokens),
    stream: true,
    stream_options: { include_usage: true },
  })
  if (new TextEncoder().encode(text).byteLength > 4_500_000)
    throw new Error("Context too large for Vector Codium. Compact this conversation before continuing.")
  return text
}

export function createFetch(input: {
  modelID: string
  credential: () => Promise<string | undefined>
  catalog: (token: string) => Promise<Catalog>
  request?: (url: string, init: RequestInit) => Promise<Response>
}) {
  return Object.assign(
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      const route = await resolveRoute(input)
      const body =
        typeof init?.body === "string"
          ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(init.body))
          : undefined
      // Destination, headers and credential are fixed here; SDK or project headers never reach the gateway.
      return (input.request ?? fetch)(CHAT_URL, {
        method: "POST",
        redirect: "error",
        signal: init?.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${route.token}` },
        body: serializeRequest(body, route.model),
      })
    },
    { preconnect: fetch.preconnect },
  )
}

const GatewayError = Schema.Struct({ error: Schema.Struct({ code: Schema.String, message: Schema.String }) })

export type Failure = {
  code: string
  /** credits: buy credits or a plan. sign-in: sign in to Vector again. unavailable: choose another model. */
  kind: "credits" | "sign-in" | "unavailable"
  message: string
}

/**
 * Account, billing and availability answers from the Codium gateway. None of them improves on a retry, and none
 * may move the conversation to another paid provider, so callers fail the turn with this message at once.
 */
export function gatewayFailure(status: number | undefined, body: string | undefined): Failure | undefined {
  const parsed = body
    ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(GatewayError))(body))
    : undefined
  const code = parsed?.error.code ?? ""
  if (status === 402)
    return {
      code: code || "MODEL_PLAN_REQUIRED",
      kind: "credits",
      message: `${parsed?.error.message ?? "You have no Codium credits available."} Buy credits at ${PURCHASE_URL}`,
    }
  if (status === 401)
    return {
      code: code || "SIGN_IN_REQUIRED",
      kind: "sign-in",
      message: "Sign in to Vector again to use Vector Codium.",
    }
  if (code === "MODEL_PLANS_DISABLED")
    return { code, kind: "unavailable", message: "Vector Codium is not available yet. Choose another model." }
  if (code === "MODEL_PLANS_CONFIGURATION" || code === "MODEL_PLAN_ACCOUNT_CLOSING")
    return { code, kind: "unavailable", message: `${parsed?.error.message} Choose another model.` }
  return undefined
}

export function contextFailure(body: string | undefined) {
  if (!body) return false
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(GatewayError))(body)
  return Option.isSome(parsed) && parsed.value.error.code === "MODEL_PLAN_CONTEXT"
}

const UsageChunk = Schema.Struct({ usage: Schema.Struct({ cost: Schema.Number }) })

/** The provider-billed USD cost the gateway passes through in a usage chunk; this is what Codium credits are debited. */
export function usageCost(chunk: unknown) {
  const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(UsageChunk)(chunk))
  const cost = parsed?.usage.cost
  return cost !== undefined && Number.isFinite(cost) && cost >= 0 ? cost : undefined
}
