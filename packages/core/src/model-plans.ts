export * as ModelPlans from "./model-plans"

import { createHash } from "node:crypto"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { makeGlobalNode } from "./effect/app-node"
import { Flag } from "./flag/flag"
import { ModelPlanStatus } from "./model-plan-status"

export const PROVIDER_ID = ModelPlanStatus.PROVIDER_ID
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
// A refresh that got no answer is tried again sooner than an answered one.
const RETRY = 10_000
const MAX_ACCOUNTS = 32

export type CatalogOptions = {
  /** Read vectordev.ai now and wait for its answer. */
  force?: boolean
  /** A chat request: wait for vectordev.ai when this account has no catalog yet, instead of answering OFF. */
  wait?: boolean
}

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
  const accounts = new Map<string, { value?: Catalog; expires: number; pending?: Promise<Catalog> }>()
  const account = (token: string) => {
    // Keyed by digest so the account token is never kept as a map key.
    const digest = createHash("sha256").update(token).digest("hex")
    const current = accounts.get(digest) ?? { expires: 0 }
    accounts.delete(digest)
    if (accounts.size >= MAX_ACCOUNTS) accounts.delete(accounts.keys().next().value!)
    accounts.set(digest, current)
    return current
  }
  const load = (token: string, current: { value?: Catalog; expires: number; pending?: Promise<Catalog> }) =>
    request(CATALOG_URL, {
      headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
      .then(async (response) =>
        response.status === 401 || response.status === 403
          ? OFF
          : response.ok
            ? parse(await response.json().catch(() => undefined))
            : undefined,
      )
      .catch(() => undefined)
      .then((answer) => {
        // Only an answer replaces the catalog: a refused token, enabled:false or a valid list. A slow, failed or
        // garbled refresh keeps serving the last catalog this account received, so a paid turn never fails on it.
        current.pending = undefined
        current.expires = now() + (answer ? TTL : RETRY)
        if (answer) current.value = answer
        return current.value ?? OFF
      })
  const catalog = (token: string | undefined, options: CatalogOptions = {}): Promise<Catalog> => {
    if (!token || input.disabled?.()) return Promise.resolve(OFF)
    const current = account(token)
    if (!options.force && current.value && current.expires > now()) return Promise.resolve(current.value)
    current.pending ??= load(token, current)
    if (options.force || (options.wait && !current.value)) return current.pending
    // Provider listing never waits long on vectordev.ai: it answers with the last catalog seen, or OFF on a first
    // read, and the refresh lands for the next caller.
    const fallback = Promise.withResolvers<Catalog>()
    // This deadline settles an awaited operation; keep it alive until the race finishes.
    const timer = setTimeout(() => fallback.resolve(current.value ?? OFF), input.timeout ?? 1_500)
    return Promise.race([current.pending, fallback.promise]).finally(() => clearTimeout(timer))
  }
  return { catalog }
}

// undefined: no usable answer. OFF: vectordev.ai says Codium is not offered to this account.
function parse(body: unknown): Catalog | undefined {
  const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(Catalog)(body))
  if (!parsed) return undefined
  if (!parsed.enabled || !parsed.models.length) return OFF
  if (
    parsed.models.length > 100 ||
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
    return undefined
  return parsed
}

export class Service extends Context.Service<
  Service,
  {
    readonly catalog: (token: string | undefined, options?: CatalogOptions) => Effect.Effect<Catalog>
    /** The HTTP transport to the Codium gateway; createFetch fixes its destination and credential. */
    readonly request: (url: string, init: RequestInit) => Promise<Response>
  }
>()("@vector/ModelPlans") {}

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.sync(Service, () => {
    const client = createClient({ disabled: () => Flag.VECTOR_DISABLE_MODELS_FETCH })
    return Service.of({
      catalog: (token, options) => Effect.promise(() => client.catalog(token, options)),
      request: (url, init) => fetch(url, init),
    })
  }),
  deps: [],
})

/**
 * The account token and catalog model for one chat request. When the request cannot be sent, it returns the answer
 * the gateway would give instead, so every caller reports a pre-request failure exactly like a gateway answer.
 */
export async function resolveRoute(input: {
  modelID: string
  credential: () => Promise<string | undefined>
  /** The chat path's catalog: the account's last known one, or vectordev.ai's answer awaited in full. */
  catalog: (token: string) => Promise<Catalog>
}) {
  const token = await input.credential()
  if (!token) return { refused: localAnswer(401, "SIGN_IN_REQUIRED") }
  const catalog = await input.catalog(token)
  if (!catalog.enabled) return { refused: localAnswer(503, "CODIUM_UNAVAILABLE") }
  const model = catalog.models.find((model) => model.id === input.modelID)
  if (!model) return { refused: localAnswer(400, "MODEL_PLAN_MODEL") }
  // A missing plan or balance is left to the gateway: a purchase made a moment ago must work at once.
  return { token, model }
}

function localAnswer(status: number, code: string) {
  return {
    status,
    body: JSON.stringify({ error: { code, message: "Vector did not send this request." } }),
  }
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
      // Nothing is sent; the SDK reads this answer as the gateway's, so the turn gets the same message and action.
      if (route.refused)
        return new Response(route.refused.body, {
          status: route.refused.status,
          headers: { "content-type": "application/json" },
        })
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
  /**
   * credits: buy credits or a plan. sign-in: sign in to Vector again. unavailable: choose another model.
   * capacity: Vector's model capacity is short for a moment; the turn is retried and nothing asks for a purchase.
   */
  kind: ModelPlanStatus.Action | "capacity"
  message: string
}

// The account's own pools cannot cover the request; buying credits or a plan fixes these.
const CREDIT_CODES = [
  "MODEL_PLAN_REQUIRED",
  "MODEL_PLAN_PAYMENT_REQUIRED",
  "MODEL_PLAN_EXHAUSTED",
  "MODEL_TOPUP_EXHAUSTED",
]
// Codium cannot serve this account or model right now; another model can.
const UNAVAILABLE: Record<string, string> = {
  MODEL_PLANS_DISABLED: "Vector Codium is not available yet.",
  MODEL_PLANS_CONFIGURATION: "Vector Codium is temporarily unavailable.",
  MODEL_PLAN_ACCOUNT_CLOSING: "This account is being deleted, so Vector Codium is closed for it.",
  MODEL_PLAN_MODEL: "This model is no longer included in Vector Codium.",
  CODIUM_UNAVAILABLE: "Vector Codium is not available right now.",
}

/**
 * Account, billing and availability answers from the Codium gateway, or the same answers given locally before a
 * request. Only capacity improves on a retry; none may move the conversation to another paid provider.
 */
export function gatewayFailure(status: number | undefined, body: string | undefined): Failure | undefined {
  const parsed = body
    ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(GatewayError))(body))
    : undefined
  const code = parsed?.error.code ?? ""
  if (status === 401)
    return { code: code || "SIGN_IN_REQUIRED", kind: "sign-in", message: "Sign in to Vector to use Vector Codium." }
  if (status === 402 && code === "MODEL_PLAN_CAPACITY")
    return {
      code,
      kind: "capacity",
      message: "Vector Codium is short of model capacity for a moment. Vector will try again shortly.",
    }
  if (status === 402 && parsed && CREDIT_CODES.includes(code))
    return { code, kind: "credits", message: `${parsed.error.message} Buy credits at ${PURCHASE_URL}` }
  if (Object.hasOwn(UNAVAILABLE, code))
    return { code, kind: "unavailable", message: `${UNAVAILABLE[code]} Choose another model.` }
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
