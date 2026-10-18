import { expect, test } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { streamText } from "ai"
import { FreeModels } from "@vectordevai/core/free-models"
import { MessageV2 } from "@/session/message-v2"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SessionRetry } from "@/session/retry"
import { ProviderTransform } from "@/provider/transform"
import type { Provider } from "@/provider/provider"
import { freeModelRequest } from "@vectordevai/core/free-model-request"
import { FREE_MODEL_FALLBACKS } from "@vectordevai/schema/free-model"

const limit = {
  type: "free_models_limit",
  code: "VECTOR_FREE_MODELS_LIMIT",
  reason: "user_daily",
  resetAt: 123456,
  message: "Shared allowance used",
} as const

test("AI SDK SSE quota retains typed details across split frames and suppresses raw JSON", async () => {
  const data = new TextEncoder().encode(`data: ${JSON.stringify({ error: limit })}\n\ndata: [DONE]\n\n`)
  const model = createOpenAICompatible({
    name: "vector",
    baseURL: "https://vectordev.ai/api/free-models",
    apiKey: "placeholder",
    fetch: Object.assign(
      async () =>
        FreeModels.preserveLimit(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(data.slice(0, 11))
                controller.enqueue(data.slice(11))
                controller.close()
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
      { preconnect: fetch.preconnect },
    ),
  }).languageModel("synthetic/model:free")
  const result = streamText({ model, prompt: "hello", maxRetries: 0 })
  const errors: unknown[] = []
  await (async () => {
    for await (const part of result.fullStream) if (part.type === "error") errors.push(part.error)
  })().catch((error: unknown) => errors.push(error))
  expect(errors).toHaveLength(1)
  expect(MessageV2.fromError(errors[0], { providerID: ProviderV2.ID.vector })).toEqual({
    name: "FreeModelsLimitError",
    data: { code: limit.code, reason: limit.reason, resetAt: limit.resetAt, message: limit.message },
  })
  expect(
    SessionRetry.retryable(MessageV2.fromError(errors[0], { providerID: ProviderV2.ID.vector }), "vector"),
  ).toBeUndefined()
})

test("HTTP quota is typed and nonquota provider errors retain their normal representation", async () => {
  const model = createOpenAICompatible({
    name: "vector",
    baseURL: "https://vectordev.ai/api/free-models",
    apiKey: "placeholder",
    fetch: Object.assign(async () => Response.json({ error: limit }, { status: 429 }), {
      preconnect: fetch.preconnect,
    }),
  }).languageModel("synthetic/model:free")
  const errors: unknown[] = []
  for await (const part of streamText({ model, prompt: "hello", maxRetries: 0 }).fullStream)
    if (part.type === "error") errors.push(part.error)
  expect(MessageV2.fromError(errors[0], { providerID: ProviderV2.ID.vector })).toMatchObject({
    name: "FreeModelsLimitError",
    data: { resetAt: 123456 },
  })
  expect(MessageV2.fromError(new Error("ordinary failure"), { providerID: ProviderV2.ID.openrouter })).toMatchObject({
    name: "UnknownError",
    data: { message: "ordinary failure" },
  })
})

test("a greeting on a free model whose reasoning is optional reaches the free proxy with reasoning off", async () => {
  const bodies: unknown[] = []
  const free = {
    id: "cohere/north-mini-code:free",
    providerID: "vector",
    api: {
      id: "cohere/north-mini-code:free",
      npm: "@ai-sdk/openai-compatible",
      url: "https://vectordev.ai/api/free-models",
    },
    freeModel: { source: "shared", reasoning: "optional" },
    capabilities: { reasoning: false },
    variants: {},
  } as unknown as Provider.Model
  const model = createOpenAICompatible({
    name: "vector",
    baseURL: "https://vectordev.ai/api/free-models",
    apiKey: "placeholder",
    fetch: Object.assign(
      async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response(
          `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ delta: { content: "Hi!" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
      { preconnect: fetch.preconnect },
    ),
  }).languageModel(free.api.id)
  for (const effort of ["off", "default"] as const) {
    const result = streamText({
      model,
      prompt: "hi",
      maxRetries: 0,
      providerOptions: ProviderTransform.providerOptions(free, ProviderTransform.effortOptions(free, effort)),
    })
    await result.consumeStream()
  }
  expect(bodies).toHaveLength(2)
  // What the shared proxy forwards to OpenRouter keeps the reasoning object; it would drop reasoning_effort.
  const forwarded: Record<string, unknown>[] = bodies.map((body) => freeModelRequest(body, FREE_MODEL_FALLBACKS))
  expect(forwarded[0]?.reasoning).toEqual({ effort: "none" })
  // Work keeps the model's own reasoning.
  expect(forwarded[1]?.reasoning).toBeUndefined()
  expect(forwarded.some((body) => "reasoning_effort" in body)).toBe(false)
})

test("a free model the live catalog says nothing about takes its reviewed reasoning, and an unsupported one never does", async () => {
  const { Provider } = await import("@/provider/provider")
  const north = FREE_MODEL_FALLBACKS.find((model) => model.id === "cohere/north-mini-code:free")!
  // A catalog published before it carried the field: reasoning still switches off without waiting on a deploy.
  const unstated = {
    id: north.id,
    name: north.name,
    contextLength: north.contextLength,
    maxOutputTokens: north.maxOutputTokens,
    providers: north.providers,
  }
  expect(Provider.fromFreeModels([unstated]).models[north.id]?.freeModel?.reasoning).toBe("optional")
  // The catalog's own word wins, and an endpoint that does not take the parameter is never sent it.
  expect(Provider.fromFreeModels([{ ...north, reasoning: "unsupported" }]).models[north.id]?.freeModel?.reasoning).toBe(
    undefined,
  )
  expect(Provider.fromFreeModels([{ ...north, reasoning: "mandatory" }]).models[north.id]?.freeModel?.reasoning).toBe(
    "mandatory",
  )
  // A model with no reviewed fallback keeps its own default.
  expect(
    Provider.fromFreeModels([{ ...unstated, id: "other/model:free" }]).models["other/model:free"]?.freeModel?.reasoning,
  ).toBeUndefined()
})
