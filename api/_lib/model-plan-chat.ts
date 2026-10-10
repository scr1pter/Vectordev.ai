import { createHash } from "node:crypto"
import { once } from "node:events"
import { Option, Schema } from "effect"
import { enforceRateLimit, requireTrustedJsonRequest } from "./abuse.js"
import { verifyCliToken } from "./cli-token.js"
import { modelPlanCredential } from "./model-plan-account.js"
import { configuredPlanModels, MODEL_PLAN_ROOT, requireModelPlans, type ModelPlanModel } from "./model-plan-config.js"
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
    return Object.fromEntries(
      Object.entries(message).filter(([key]) =>
        ["role", "content", "name", "tool_calls", "tool_call_id", "reasoning", "reasoning_details"].includes(key),
      ),
    )
  })
  if (
    body.tools !== undefined &&
    (!Array.isArray(body.tools) ||
      body.tools.some((tool) => !stripeRecord(tool) || tool.type !== "function" || !stripeRecord(tool.function)))
  )
    throw new ApiError(400, "MODEL_PLAN_TOOL", "Only local function tools are supported.")
  const maximum = body.max_tokens ?? body.max_completion_tokens ?? Math.min(8192, model.maxOutputTokens)
  if (typeof maximum !== "number" || !Number.isSafeInteger(maximum) || maximum < 1)
    throw new ApiError(400, "MODEL_PLAN_OUTPUT", "The requested response length is invalid.")
  return {
    ...Object.fromEntries(
      Object.entries(body).filter(([key]) =>
        [
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
    messages,
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
      max_price: { prompt: model.inputPrice, completion: model.outputPrice, request: 0, image: 0 },
    },
  }
}

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
  const state = { pending: "" }
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
          return
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
        if (!response.write(`data: ${JSON.stringify(parsed.value)}\n\n`))
          await once(response, "drain", { signal: controller.signal })
      }
      if (part.done) throw new ApiError(503, "MODEL_PLAN_STREAM", "The model response ended before completion.")
    }
  } finally {
    response.off("close", cancel)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export async function handleModelPlanChat(request: ApiRequest, response: ApiResponse, fetcher: typeof fetch = fetch) {
  const controller = new AbortController()
  const close = () => controller.abort()
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
    // A byte bound deliberately overestimates tokenized input; include tool
    // schemas and formatting overhead before choosing a credit pool. The
    // provider key cap is the final spending control; its concurrent request
    // accounting still depends on the upstream provider's enforcement.
    const inputBound = Buffer.byteLength(JSON.stringify(body)) + body.messages.length * 32 + 256
    if (inputBound + body.max_tokens > model.contextLength)
      throw new ApiError(
        400,
        "MODEL_PLAN_CONTEXT",
        "This request may exceed the model context limit. Shorten the conversation or requested response.",
      )
    const requiredCredits = (inputBound * model.inputPrice + body.max_tokens * model.outputPrice) / 1_000_000
    const key = await modelPlanCredential(account.id, fetcher, Date.now(), requiredCredits)
    const upstream = await fetcher(`${MODEL_PLAN_ROOT}/chat/completions`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]),
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "HTTP-Referer": "https://vectordev.ai/",
        "X-OpenRouter-Title": "Vector",
      },
      body: JSON.stringify({ ...body, user: createHash("sha256").update(account.id).digest("hex") }),
    })
    await streamModelPlanResponse(upstream, response)
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
  }
}
