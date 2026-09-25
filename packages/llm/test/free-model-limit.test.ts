import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { FreeModelLimit } from "@vectordevai/schema/free-model"
import { LLM, LLMError } from "../src"
import { OpenAIChat } from "../src/protocols/openai-chat"
import { LLMClient } from "../src/route"
import { dynamicResponse } from "./lib/http"
import { sseEvents } from "./lib/sse"

const limit: FreeModelLimit = {
  type: "free_models_limit",
  code: "VECTOR_FREE_MODELS_LIMIT",
  reason: "shared_daily",
  resetAt: 1900000000000,
  message: "The shared free allowance is exhausted.",
}
const request = LLM.request({
  model: OpenAIChat.route.with({ endpoint: { baseURL: "https://fixture.invalid" } }).model({ id: "test:free" }),
  prompt: "Hello",
})

test("HTTP quota errors retain structured limits and never retry", async () => {
  const attempts: string[] = []
  const error = await Effect.runPromise(
    LLMClient.stream(request).pipe(
      Stream.runCollect,
      Effect.flip,
      Effect.provide(
        dynamicResponse((input) => {
          attempts.push(input.request.url)
          return Effect.succeed(input.respond(JSON.stringify({ error: limit }), { status: 429 }))
        }),
      ),
    ),
  )
  expect(attempts).toHaveLength(1)
  expect(error).toBeInstanceOf(LLMError)
  expect(error.reason).toMatchObject({ _tag: "FreeModelsLimit", limit })
  expect(error.retryable).toBe(false)
})

test("SSE quota errors preserve earlier output and stop before later output without retries", async () => {
  const attempts: string[] = []
  const output: string[] = []
  const error = await Effect.runPromise(
    LLMClient.stream(request).pipe(
      Stream.tap((event) =>
        Effect.sync(() => {
          if (event.type === "text-delta") output.push(event.text)
        }),
      ),
      Stream.runCollect,
      Effect.flip,
      Effect.provide(
        dynamicResponse((input) => {
          attempts.push(input.request.url)
          return Effect.succeed(
            input.respond(
              sseEvents(
                { choices: [{ delta: { content: "Before limit" } }] },
                { error: { ...limit, reason: "upstream" } },
                { choices: [{ delta: { content: "Never emitted" } }] },
              ),
              { headers: { "content-type": "text/event-stream" } },
            ),
          )
        }),
      ),
    ),
  )
  expect(attempts).toHaveLength(1)
  expect(output).toEqual(["Before limit"])
  expect(error.reason).toMatchObject({ _tag: "FreeModelsLimit", limit: { ...limit, reason: "upstream" } })
  expect(error.retryable).toBe(false)
})
