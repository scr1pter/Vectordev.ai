import { expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLM } from "@vectordevai/llm"
import { LLMClient, RequestExecutor } from "@vectordevai/llm/route"
import { FreeModels } from "../src/free-models"
import { freeModelRoute } from "../src/session/runner/free-model-route"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { FREE_MODEL_FALLBACKS } from "@vectordevai/schema/free-model"

const catalog = { enabled: true, updatedAt: 1, models: [...FREE_MODEL_FALLBACKS.slice(0, 2)] }
const client = FreeModels.Service.of({
  catalog: () => Effect.succeed(catalog),
  forKey: () => Effect.succeed(catalog.models),
})
const info = ModelV2.Info.make({
  ...ModelV2.Info.empty(ProviderV2.ID.vector, ModelV2.ID.make(catalog.models[0].id)),
  freeModel: { source: "shared" },
  limit: { context: 32000, output: 8000 },
  api: {
    type: "aisdk",
    id: ModelV2.ID.make(catalog.models[0].id),
    package: "@ai-sdk/openai-compatible",
    url: "https://attacker.invalid",
  },
  request: { headers: { Authorization: "injected" }, body: { apiKey: "injected", provider: { max_price: 10 } } },
})

test("native free route fixes destination and body after all caller overlays, reads current own credential", async () => {
  const keys = ["first-owned-key", "second-owned-key"]
  const credentials = FreeModels.CredentialsService.of({
    get: (provider) => Effect.succeed(provider === "openrouter" ? keys.shift() : "vct_shared"),
  })
  const model = freeModelRoute(info, client, credentials)
  for (const key of ["first-owned-key", "second-owned-key"]) {
    const request = LLM.request({
      model,
      prompt: "hello",
      http: {
        headers: { Authorization: "attacker", "x-leak": "private" },
        query: { api_key: "private" },
        body: { user: "injected", web_search_options: {} },
      },
    })
    const prepared = await Effect.runPromise(
      model.route.prepareTransport({ model: model.id, messages: [{ role: "user", content: "hello" }] }, request),
    )
    expect(prepared.request.url).toBe(FreeModels.OPENROUTER_CHAT_URL)
    expect(prepared.request.headers.authorization).toBe(`Bearer ${key}`)
    expect(prepared.request.headers["x-leak"]).toBeUndefined()
    expect(prepared.request.body._tag).toBe("Uint8Array")
    if (prepared.request.body._tag !== "Uint8Array") throw new Error("Expected JSON bytes")
    const body = JSON.parse(new TextDecoder().decode(prepared.request.body.body))
    expect(body.provider.max_price).toEqual({ prompt: 0, completion: 0, request: 0, image: 0 })
    expect(body.models).toEqual(catalog.models.map((item) => item.id))
    expect(body).not.toHaveProperty("web_search_options")
    expect(body).not.toHaveProperty("apiKey")
    expect(body).not.toHaveProperty("user")
  }
})

test("native shared route uses Vector token only on fixed Vector endpoint and refuses paid plugins", async () => {
  const model = freeModelRoute(
    info,
    client,
    FreeModels.CredentialsService.of({
      get: (provider) => Effect.succeed(provider === "vector" ? "vct_shared" : undefined),
    }),
  )
  const request = LLM.request({ model, prompt: "hello" })
  const body = { model: model.id, messages: [{ role: "user", content: "hello" }] }
  const prepared = await Effect.runPromise(model.route.prepareTransport(body, request))
  expect(prepared.request.url).toBe(FreeModels.SHARED_CHAT_URL)
  expect(prepared.request.headers.authorization).toBe("Bearer vct_shared")
  await expect(
    Effect.runPromise(
      model.route.prepareTransport(
        body,
        LLM.request({ model, prompt: "hello", http: { body: { plugins: [{ id: "web" }] } } }),
      ),
    ),
  ).rejects.toThrow("Paid plugins")
})

test("native free-model requests reject redirects before forwarding conversation data", async () => {
  const redirected: string[] = []
  const destination = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      redirected.push(await request.text())
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    },
  })
  const origin = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.redirect(destination.url, 307),
  })
  try {
    const model = freeModelRoute(
      info,
      client,
      FreeModels.CredentialsService.of({
        get: (provider) => Effect.succeed(provider === "vector" ? "vct_synthetic" : undefined),
      }),
    )
    const result = await Effect.runPromise(
      LLMClient.stream(LLM.request({ model, prompt: "private conversation fixture" })).pipe(
        Stream.runCollect,
        Effect.result,
        Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))),
        Effect.provideService(
          FetchHttpClient.Fetch,
          Object.assign(
            (input: RequestInfo | URL, init?: RequestInit) => {
              expect(String(input)).toBe(FreeModels.SHARED_CHAT_URL)
              return fetch(origin.url, init)
            },
            { preconnect: fetch.preconnect },
          ),
        ),
      ),
    )
    expect(redirected).toEqual([])
    expect(result._tag).toBe("Failure")
  } finally {
    await origin.stop(true)
    await destination.stop(true)
  }
})

test("native shared requests reject oversized UTF-8 context before contacting the inference endpoint", async () => {
  const requests: string[] = []
  const model = freeModelRoute(
    info,
    client,
    FreeModels.CredentialsService.of({
      get: (provider) => Effect.succeed(provider === "vector" ? "vct_synthetic" : undefined),
    }),
  )
  const result = await Effect.runPromise(
    LLMClient.stream(LLM.request({ model, prompt: "é".repeat(2_250_000) })).pipe(
      Stream.runCollect,
      Effect.result,
      Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))),
      Effect.provideService(
        FetchHttpClient.Fetch,
        Object.assign(
          async (input: RequestInfo | URL) => {
            requests.push(String(input))
            throw new Error("Oversized shared requests must not reach the network")
          },
          { preconnect: fetch.preconnect },
        ),
      ),
    ),
  )
  expect(requests).toEqual([])
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      reason: {
        _tag: "InvalidRequest",
        message:
          "Context too large for the shared free allowance. Compact this conversation or connect OpenRouter to continue with your own account.",
      },
    },
  })
})

test("a saved shared selection routed to the own key is not subject to the Vector body limit", async () => {
  const requests: string[] = []
  const model = freeModelRoute(
    info,
    client,
    FreeModels.CredentialsService.of({
      get: (provider) => Effect.succeed(provider === "openrouter" ? "own-synthetic" : "vct_synthetic"),
    }),
  )
  const result = await Effect.runPromise(
    LLMClient.stream(LLM.request({ model, prompt: "é".repeat(2_250_000) })).pipe(
      Stream.runCollect,
      Effect.result,
      Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))),
      Effect.provideService(
        FetchHttpClient.Fetch,
        Object.assign(
          async (input: RequestInfo | URL, init?: RequestInit) => {
            requests.push(String(input))
            const request = new Request(input, init)
            expect((await request.arrayBuffer()).byteLength).toBeGreaterThan(4_500_000)
            expect(request.headers.get("authorization")).toBe("Bearer own-synthetic")
            return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
          },
          { preconnect: fetch.preconnect },
        ),
      ),
    ),
  )
  expect(requests).toEqual([FreeModels.OPENROUTER_CHAT_URL])
  expect(result._tag).toBe("Success")
})
