import { expect, test } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { streamText } from "ai"
import { FreeModels } from "@vectordevai/core/free-models"
import { MessageV2 } from "@/session/message-v2"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SessionRetry } from "@/session/retry"

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
