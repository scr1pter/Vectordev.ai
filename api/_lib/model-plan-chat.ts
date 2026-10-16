import { createHash } from "node:crypto"
import { once } from "node:events"
import { Option, Schema } from "effect"
import { enforceRateLimit, requireTrustedJsonRequest } from "./abuse.js"
import { verifyCliToken } from "./cli-token.js"
import { modelPlanCredential } from "./model-plan-account.js"
import {
  configuredPlanModels,
  MODEL_PLAN_OPTIONS,
  MODEL_PLAN_ROOT,
  requireModelPlans,
  type ModelPlanModel,
} from "./model-plan-config.js"
import { stripeRecord } from "./model-plan-stripe.js"
import { ApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "./http.js"
import { requireUnrevokedAccount } from "./revocation.js"

const MAX_BYTES = 4_500_000
export async function requireModelPlanUser(request: ApiRequest, fetcher: typeof fetch = fetch, now = Date.now()) {
  const token = /^Bearer (vct_[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)$/.exec(String(request.headers.authorization ?? ""))?.[1]
  const account = verifyCliToken(token ?? "", now)
  await requireUnrevokedAccount(account.id, fetcher)
  return account
}

export function modelPlanRequest(body: unknown, models: readonly ModelPlanModel[]) {
  if (!stripeRecord(body) || !Array.isArray(body.messages) || !body.messages.length)
    throw new ApiError(400, "MODEL_PLAN_REQUEST", "Include conversation messages and an available model.")
  const model = models.find((model) => model.id === body.model)
  if (!model) throw new ApiError(400, "MODEL_PLAN_MODEL", "Choose a model available in Vector Codium.")
  if (
    body.plugins !== undefined ||
    body.preset !== undefined ||
    body.modalities !== undefined ||
    body.models !== undefined
  )
    throw new ApiError(400, "MODEL_PLAN_ADDONS", "Vector Codium supports text and local tools without paid add-ons.")
  const messages = body.messages.map((message) => {
    if (!stripeRecord(message) || !["system", "developer", "user", "assistant", "tool"].includes(String(message.role)))
      throw new ApiError(400, "MODEL_PLAN_MESSAGE", "A conversation message is invalid.")
    if (
      message.content !== undefined &&
      message.content !== null &&
      typeof message.content !== "string" &&
      (!Array.isArray(message.content) ||
        message.content.some((part) => !stripeRecord(part) || part.type !== "text" || typeof part.text !== "string"))
    )
      throw new ApiError(400, "MODEL_PLAN_ATTACHMENT", "Vector Codium accepts text and local tool messages.")
    if (
      message.tool_calls !== undefined &&
      (!Array.isArray(message.tool_calls) ||
        message.tool_calls.some(
          (call) => !stripeRecord(call) || call.type !== "function" || !stripeRecord(call.function),
        ))
    )
      throw new ApiError(400, "MODEL_PLAN_TOOL", "A tool message is invalid.")
    // Vector's clients send earlier reasoning as reasoning_content, OpenRouter's alias for reasoning. Thinking models
    // such as DeepSeek refuse a tool-call turn whose reasoning is missing, and signed reasoning stays in its details.
    const reasoning = message.reasoning ?? message.reasoning_content
    if (
      (reasoning !== undefined && reasoning !== null && typeof reasoning !== "string") ||
      (message.reasoning_details !== undefined &&
        (!Array.isArray(message.reasoning_details) || !message.reasoning_details.every(stripeRecord)))
    )
      throw new ApiError(400, "MODEL_PLAN_MESSAGE", "A conversation message is invalid.")
    return {
      ...Object.fromEntries(
        Object.entries(message).filter(([key]) =>
          ["role", "content", "name", "tool_calls", "tool_call_id"].includes(key),
        ),
      ),
      // Only an assistant's own turn carries reasoning.
      ...(message.role === "assistant" && typeof reasoning === "string" ? { reasoning } : {}),
      ...(message.role === "assistant" && message.reasoning_details !== undefined
        ? { reasoning_details: message.reasoning_details }
        : {}),
      // A text part keeps only its text, so a client cannot add cache markers or other per-part options.
      ...(Array.isArray(message.content)
        ? { content: message.content.map((part) => ({ type: "text", text: String(part.text) })) }
        : {}),
    }
  })
  if (
    body.tools !== undefined &&
    (!Array.isArray(body.tools) ||
      body.tools.some(
        (tool) =>
          !stripeRecord(tool) ||
          tool.type !== "function" ||
          !stripeRecord(tool.function) ||
          typeof tool.function.name !== "string",
      ))
  )
    throw new ApiError(400, "MODEL_PLAN_TOOL", "Only local function tools are supported.")
  const maximum = body.max_tokens ?? body.max_completion_tokens ?? Math.min(8192, model.maxOutputTokens)
  if (typeof maximum !== "number" || !Number.isSafeInteger(maximum) || maximum < 1)
    throw new ApiError(400, "MODEL_PLAN_OUTPUT", "The requested response length is invalid.")
  // With require_parameters, OpenRouter routes only to endpoints that accept every option sent, so a model whose
  // endpoints refuse some options keeps only the ones they accept.
  const options = model.options ?? MODEL_PLAN_OPTIONS
  return {
    ...Object.fromEntries(Object.entries(body).filter(([key]) => options.some((option) => option === key))),
    // A tool keeps only its definition, so a client cannot add cache markers or other per-tool options.
    ...(Array.isArray(body.tools) && options.some((option) => option === "tools")
      ? {
          tools: body.tools.flatMap((tool) =>
            stripeRecord(tool) && stripeRecord(tool.function)
              ? [
                  {
                    type: "function",
                    function: {
                      name: String(tool.function.name),
                      ...(typeof tool.function.description === "string"
                        ? { description: tool.function.description }
                        : {}),
                      ...(stripeRecord(tool.function.parameters) ? { parameters: tool.function.parameters } : {}),
                      ...(typeof tool.function.strict === "boolean" ? { strict: tool.function.strict } : {}),
                    },
                  },
                ]
              : [],
          ),
        }
      : {}),
    model: model.id,
    messages: model.explicitCache ? cacheBreakpoints(messages) : messages,
    // Forcing a tool call, or one named tool, skips the model's reasoning on these endpoints, which refuse it while
    // reasoning is pinned on, so the model decides between tools itself.
    ...(model.explicitCache && (body.tool_choice === "required" || stripeRecord(body.tool_choice))
      ? { tool_choice: "auto" }
      : {}),
    // Catalog policy owns effort; client overrides cannot silently increase spend or change reviewed quality.
    reasoning: model.reasoningEffort ? { effort: model.reasoningEffort } : undefined,
    max_tokens: Math.min(maximum, model.maxOutputTokens),
    stream: true,
    stream_options: { include_usage: true },
    plugins: ["web", "file-parser", "response-healing", "context-compression", "auto-router", "pareto-router"].map(
      (id) => ({ id, enabled: false }),
    ),
    provider: {
      data_collection: "deny",
      zdr: true,
      require_parameters: true,
      ...(model.quantizations ? { quantizations: model.quantizations } : {}),
      max_price: { prompt: model.inputPrice, completion: model.outputPrice, request: 0, image: 0 },
    },
  }
}

/**
 * Explicit five-minute breakpoints for endpoints without implicit caching: the end of the system prompt, which tools
 * and instructions share across a session, the latest user message, and the end of the conversation, which moves
 * with every tool result. When the system prompt comes as several messages, Vector's stable block of tools and
 * instructions first, the end of that first message is marked too, so a new session reads it from the cache. Four
 * is the most a request may mark, and the gateway drops every client marker, including any on tools.
 */
function cacheBreakpoints(messages: Record<string, unknown>[]) {
  const text = (message: Record<string, unknown>) =>
    typeof message.content === "string"
      ? message.content.length > 0
      : Array.isArray(message.content) && message.content.some((part) => part.text.length > 0)
  const leading = messages.findIndex((message) => message.role !== "system" && message.role !== "developer")
  const system = leading === -1 ? messages.length : leading
  const marked = [
    ...(system > 1 ? [0] : []),
    system - 1,
    messages.findLastIndex((message) => message.role === "user" && text(message)),
    messages.findLastIndex(text),
  ].filter((index) => index >= 0 && text(messages[index]!))
  return messages.map((message, index) => {
    if (!marked.includes(index)) return message
    const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content) }]
    const last = content.findLastIndex((part) => part.text.length > 0)
    return {
      ...message,
      content: content.map((part, partIndex) =>
        partIndex === last ? { ...part, cache_control: { type: "ephemeral" } } : part,
      ),
    }
  })
}

/**
 * Rejects a request the model's context window cannot hold and returns its estimated input tokens, which also size
 * the credit check. The gateway has no tokenizer, so it estimates tokens as Vector's clients do, at four bytes of
 * content per token. A JSON escape stands for one character the model reads, so only the bytes it adds are left out:
 * one for \n, \" or \\, five for \u0001. Counting each byte as a token rejected conversations at about a quarter of
 * the window the catalog lists.
 */
export function requireModelPlanContext<T extends { max_tokens: number }>(body: T, model: ModelPlanModel) {
  const text = JSON.stringify(body)
  const bytes = Buffer.byteLength(text)
  const escapes = (text.match(/\\(?:u[0-9a-fA-F]{4}|.)/g) ?? []).reduce((total, escape) => total + escape.length - 1, 0)
  const inputTokens = Math.ceil((bytes - escapes) / 4)
  if (inputTokens + body.max_tokens > model.contextLength) throw contextError()
  if (model.promptTokenLimit !== undefined && promptBound(text, bytes, escapes) >= model.promptTokenLimit)
    throw contextError()
  return inputTokens
}

/**
 * A conservative count of a prompt's tokens for a model priced by prompt length, without the provider's tokenizer.
 * ASCII counts one token per two characters: code, prose, JSON and tool output average more than that, though text
 * as dense as long random hashes could not. Any other character counts one token per UTF-8 byte, the most a
 * byte-level tokenizer can produce, and a fixed allowance covers the framing a provider adds around messages and tools.
 */
function promptBound(text: string, bytes: number, escapes: number) {
  const ascii = text.length - (text.match(/[^\x00-\x7f]/g)?.length ?? 0)
  return Math.ceil((ascii - escapes) / 2) + bytes - ascii + 2_000
}

/**
 * Streams the provider's answer to Vector. Once the answer finishes it returns what the provider said it charged; when
 * Vector goes away first it returns nothing, since the provider may still be producing, and billing, the answer.
 */
export async function streamModelPlanResponse(upstream: Response, response: ApiResponse) {
  if (upstream.status === 402 || upstream.status === 429) {
    const retry = upstream.headers.get("retry-after")
    if (retry && /^\d+$/.test(retry) && Number(retry) > 0)
      response.setHeader("retry-after", String(Math.min(Number(retry), 300)))
  }
  if (upstream.status === 402)
    throw new ApiError(
      402,
      "MODEL_PLAN_CAPACITY",
      "Your Codium credits or provider capacity are currently unavailable. Check your balance or retry later.",
    )
  if (upstream.status === 429)
    throw new ApiError(429, "MODEL_PLAN_BUSY", "This model is busy. Retry shortly or choose another included model.")
  // The four-bytes-per-token estimate can undercount a provider's tokenizer. When the provider refuses the context,
  // answer as the gateway's own check does, so Vector compacts the conversation instead of retrying a request that
  // can never fit. The provider's wording is only matched, never passed on.
  if (upstream.status === 413 || (upstream.status === 400 && contextRefused(await upstream.text().catch(() => ""))))
    throw contextError()
  if (!upstream.ok || !upstream.body || !upstream.headers.get("content-type")?.includes("text/event-stream"))
    throw new ApiError(503, "MODEL_PLAN_UPSTREAM", "This model is temporarily unavailable.")
  response.statusCode = 200
  response.setHeader("content-type", "text/event-stream; charset=utf-8")
  response.setHeader("cache-control", "no-store, no-transform")
  response.setHeader("x-accel-buffering", "no")
  response.flushHeaders()
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  const controller = new AbortController()
  const cancel = () => {
    controller.abort()
    void reader.cancel().catch(() => undefined)
  }
  const state = { pending: "", charge: undefined as number | undefined }
  response.once("close", cancel)
  try {
    while (!response.destroyed) {
      const part = await reader.read()
      state.pending += decoder.decode(part.value, { stream: !part.done })
      if (state.pending.length > 1_000_000)
        throw new ApiError(503, "MODEL_PLAN_STREAM", "The model returned an invalid response stream.")
      const frames = state.pending.split(/\r?\n\r?\n/)
      state.pending = frames.pop() ?? ""
      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (data === "[DONE]") {
          response.end("data: [DONE]\n\n")
          return { charge: state.charge }
        }
        if (!data) continue
        const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(data)
        if (Option.isNone(parsed) || !stripeRecord(parsed.value))
          throw new ApiError(503, "MODEL_PLAN_STREAM", "The model returned an invalid response stream.")
        if (parsed.value.error)
          throw new ApiError(
            503,
            "MODEL_PLAN_STREAM",
            "The model stopped responding. Your account shows any usage charged by the provider.",
          )
        const cost = stripeRecord(parsed.value.usage) ? parsed.value.usage.cost : undefined
        if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) state.charge = cost
        if (!response.write(`data: ${JSON.stringify(withoutCharge(parsed.value))}\n\n`))
          await once(response, "drain", { signal: controller.signal })
      }
      if (part.done) throw new ApiError(503, "MODEL_PLAN_STREAM", "The model response ended before completion.")
    }
    return undefined
  } finally {
    response.off("close", cancel)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

// The provider reports each request's charge in USD, which is exactly what comes off the credits. Beside the share of
// a plan it used, that amount would reveal the plan's allowance, so it stays on the server and Vector counts Codium
// steps by their tokens.
function withoutCharge(chunk: Record<string, unknown>) {
  if (!stripeRecord(chunk.usage)) return chunk
  return {
    ...chunk,
    usage: Object.fromEntries(
      Object.entries(chunk.usage).filter(([key]) => !["cost", "cost_details", "is_byok"].includes(key)),
    ),
  }
}

function contextError() {
  return new ApiError(
    400,
    "MODEL_PLAN_CONTEXT",
    "This request may exceed the model context limit. Shorten the conversation or requested response.",
  )
}

// How OpenAI-compatible providers word a context-window refusal.
function contextRefused(body: string) {
  return /context[ _-]?(length|window)|maximum context|too many tokens|prompt is too long/i.test(body.slice(0, 8_192))
}

export async function handleModelPlanChat(request: ApiRequest, response: ApiResponse, fetcher: typeof fetch = fetch) {
  const controller = new AbortController()
  const close = () => controller.abort()
  // The credits held for this request until it settles, and how its answer went: whether the provider began one, and
  // what it charged once the answer finished.
  const hold = {
    release: async (_charge?: number) => {},
    required: 0,
    streamed: false,
    finished: undefined as { charge?: number } | undefined,
  }
  response.once("close", close)
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, MAX_BYTES)
    requireModelPlans()
    const account = await requireModelPlanUser(request, fetcher)
    const body = modelPlanRequest(await readJson(request, MAX_BYTES), configuredPlanModels())
    await enforceRateLimit(request, response, {
      scope: "model-plan-minute",
      identifier: account.id,
      limit: 30,
      windowSeconds: 60,
      requirePersistent: true,
    })
    const model = configuredPlanModels().find((model) => model.id === body.model)!
    // Estimate prompt tokens, including tool schemas, before reserving provider credit.
    const inputTokens = requireModelPlanContext(body, model)
    hold.required = (inputTokens * model.inputPrice + body.max_tokens * model.outputPrice) / 1_000_000
    const funding = await modelPlanCredential(account.id, fetcher, Date.now(), hold.required)
    hold.release = funding.release
    const upstream = await fetcher(`${MODEL_PLAN_ROOT}/chat/completions`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]),
      headers: {
        authorization: `Bearer ${funding.key}`,
        "content-type": "application/json",
        "HTTP-Referer": "https://vectordev.ai/",
        "X-OpenRouter-Title": "Vector",
      },
      body: JSON.stringify({ ...body, user: createHash("sha256").update(account.id).digest("hex") }),
    })
    hold.streamed = upstream.ok
    hold.finished = await streamModelPlanResponse(upstream, response)
  } catch (error) {
    if (response.destroyed) return
    const payload = {
      error: {
        code: error instanceof ApiError ? error.code : "MODEL_PLAN_UNAVAILABLE",
        message: error instanceof ApiError ? error.message : "Model access is temporarily unavailable.",
      },
    }
    if (response.headersSent) {
      response.end(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`)
      return
    }
    if (error instanceof ApiError && error.code === "BILLING_MUTATION_BUSY") {
      response.setHeader("retry-after", "1")
      json(response, 429, payload)
      return
    }
    json(response, error instanceof ApiError ? error.statusCode : 503, payload)
  } finally {
    request.resume()
    response.off("close", close)
    controller.abort()
    // A request the provider never answered frees its hold at once, and one whose answer finished keeps only its charge,
    // or its largest cost when the provider named none, until the key's usage shows it. An answer that broke off or
    // that Vector cancelled may still be billed when the provider finishes, so its hold stays until it lapses.
    if (!hold.streamed || hold.finished)
      await hold
        .release(hold.finished ? (hold.finished.charge ?? hold.required) : undefined)
        .catch(() => undefined)
  }
}
