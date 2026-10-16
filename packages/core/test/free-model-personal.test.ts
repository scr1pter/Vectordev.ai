import { expect, test } from "bun:test"
import { NO_TRAINING_RETENTION } from "@vectordevai/schema/free-model"
import { FreeModels } from "../src/free-models"

const endpointsPath = (url: string) => /\/models\/(.+)\/endpoints$/.exec(url)?.[1]

test("today's public OpenRouter data gives personal accounts the allowlisted no-training models", async () => {
  // Captured from OpenRouter's public /models and per-model /endpoints on 15 October 2026. None of these
  // endpoints is on OpenRouter's ZDR list, which left the earlier ZDR-only selection empty.
  const fixture = await Bun.file(new URL("./fixture/free-model-public.json", import.meta.url)).json()
  const requests: string[] = []
  const client = FreeModels.createClient({
    now: () => fixture.capturedAt,
    request: async (url) => {
      requests.push(url)
      if (url.endsWith("/models/user")) return Response.json({ data: fixture.models })
      const id = endpointsPath(url)
      if (id && fixture.endpoints[id]) return Response.json({ data: { id, endpoints: fixture.endpoints[id] } })
      throw new Error("Only catalog metadata may be requested")
    },
  })
  const models = await client.forKey("fixture-placeholder")
  expect(models.map((item) => [item.id, item.providers.map((provider) => provider.id)])).toEqual([
    ["dots-studio/dots-3-note-preview:free", ["atlas-cloud/fp8"]],
    ["cohere/north-mini-code:free", ["cohere"]],
  ])
  expect(models.flatMap((item) => item.providers.map((provider) => provider.retention))).toEqual([
    NO_TRAINING_RETENTION,
    NO_TRAINING_RETENTION,
  ])
  // Models off the allowlist never reach an endpoint lookup: Poolside's free Laguna pages say free use may
  // train on inputs, and NVIDIA, Google, Liquid and Thinking Machines are excluded authors.
  expect(requests.slice(1).map(endpointsPath).sort()).toEqual([
    "cohere/north-mini-code:free",
    "dots-studio/dots-3-note-preview:free",
  ])
})

test("one unreadable endpoint list drops only that model from a personal account", async () => {
  const fixture = await Bun.file(new URL("./fixture/free-model-public.json", import.meta.url)).json()
  for (const failure of [
    () => Response.json({ error: { code: 429, message: "Rate limited" } }, { status: 429 }),
    () => Response.json({ error: { code: 404, message: "Not Found" } }, { status: 404 }),
    () => Response.json({ data: { endpoints: "unexpected" } }),
    () => new Response("not json"),
    async () => Promise.reject(new TypeError("fetch failed")),
  ]) {
    const client = FreeModels.createClient({
      now: () => fixture.capturedAt,
      request: async (url) => {
        if (url.endsWith("/models/user")) return Response.json({ data: fixture.models })
        const id = endpointsPath(url)
        if (id === "dots-studio/dots-3-note-preview:free") return failure()
        if (id && fixture.endpoints[id]) return Response.json({ data: { id, endpoints: fixture.endpoints[id] } })
        throw new Error("Only catalog metadata may be requested")
      },
    })
    expect((await client.forKey("fixture-placeholder")).map((item) => item.id)).toEqual(["cohere/north-mini-code:free"])
  }
})

const model = (id: string) => ({
  id,
  name: id,
  context_length: 16000,
  pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
  supported_parameters: ["tools", "tool_choice"],
  top_provider: { max_completion_tokens: 4096 },
})
const allowed = "cohere/north-mini-code:free"
const endpoint = {
  model_id: allowed,
  provider_name: "Cohere",
  tag: "cohere/checked",
  context_length: 8000,
  max_completion_tokens: 2048,
  pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
  supported_parameters: ["tools", "tool_choice"],
  status: 0,
}

test("personal discovery validates live endpoints without the shared service and never sends keys to public metadata", async () => {
  const requests: string[] = []
  const client = FreeModels.createClient({
    request: async (url, init) => {
      requests.push(url)
      expect(init.redirect).toBe("error")
      if (url.endsWith("/models/user")) {
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer placeholder")
        return Response.json({ data: [model(allowed)] })
      }
      expect(new Headers(init.headers).has("authorization")).toBe(false)
      if (endpointsPath(url) === allowed) return Response.json({ data: { endpoints: [endpoint] } })
      throw new Error("Personal access must not request the shared catalog")
    },
  })
  expect(await client.forKey("placeholder")).toEqual([
    {
      id: allowed,
      name: "cohere/north-mini-code",
      contextLength: 8000,
      maxOutputTokens: 2048,
      providers: [
        {
          id: "cohere/checked",
          name: "Cohere",
          retention: NO_TRAINING_RETENTION,
        },
      ],
    },
  ])
  expect(requests).toHaveLength(2)
  await client.forKey("placeholder")
  expect(requests).toHaveLength(2)
})

test("personal discovery checks free IDs, prices, tools, expiry and the allowlist before endpoint lookup", async () => {
  const requests: string[] = []
  const client = FreeModels.createClient({
    now: () => Date.UTC(2026, 9, 2),
    request: async (url) => {
      requests.push(url)
      if (url.endsWith("/models/user"))
        return Response.json({
          data: [
            model(allowed),
            model("cohere/north-mini-code"),
            model("openrouter/auto:free"),
            { ...model("dots-studio/dots-3-note-preview:free"), expiration_date: "2026-10-01" },
            model("cohere/north-code-next:free"),
            model("maker/new:free"),
          ],
        })
      return Response.json({ data: { endpoints: [endpoint] } })
    },
  })
  expect((await client.forKey("placeholder")).map((item) => item.id)).toEqual([allowed])
  expect(requests).toEqual([
    `${FreeModels.OPENROUTER_ROOT}/models/user`,
    `${FreeModels.OPENROUTER_ROOT}/models/${allowed}/endpoints`,
  ])
})

test("personal discovery skips models within a week of expiry", async () => {
  const requests: string[] = []
  const client = FreeModels.createClient({
    now: () => Date.UTC(2026, 9, 15),
    request: async (url) => {
      requests.push(url)
      if (url.endsWith("/models/user"))
        return Response.json({
          data: [model(allowed), { ...model("dots-studio/dots-3-note-preview:free"), expiration_date: "2026-10-20" }],
        })
      return Response.json({ data: { endpoints: [endpoint] } })
    },
  })
  expect((await client.forKey("placeholder")).map((item) => item.id)).toEqual([allowed])
  expect(requests.slice(1).map(endpointsPath)).toEqual([allowed])
})

test("personal discovery fails closed for priced, unavailable, mismatched or unreviewed endpoints", async () => {
  const invalid = [
    { ...endpoint, pricing: { ...endpoint.pricing, request: "0.01" } },
    { ...endpoint, pricing: { ...endpoint.pricing, completion: "0.01" } },
    { ...endpoint, supported_parameters: ["tools"] },
    { ...endpoint, status: 1 },
    { ...endpoint, context_length: 0 },
    { ...endpoint, tag: "" },
    { ...endpoint, model_id: "cohere/other:free" },
    { ...endpoint, model_id: undefined },
    { ...endpoint, provider_name: "Poolside", tag: "poolside/fp8" },
    { ...endpoint, provider_name: "AtlasCloud", tag: "atlas-cloud/fp8" },
    { ...endpoint, provider_name: "Unknown", tag: "unknown" },
  ]
  for (const entry of invalid) {
    const client = FreeModels.createClient({
      request: async (url) => {
        if (url.endsWith("/models/user")) return Response.json({ data: [model(allowed)] })
        return Response.json({ data: { endpoints: [entry] } })
      },
    })
    expect(await client.forKey("placeholder")).toEqual([])
  }
})

test("rejected keys and unavailable metadata discard cached personal eligibility", async () => {
  const state = { now: 1, failure: "" }
  const client = FreeModels.createClient({
    now: () => state.now,
    request: async (url) => {
      if (state.failure && url.endsWith(state.failure)) return new Response(null, { status: 401 })
      if (url.endsWith("/models/user")) return Response.json({ data: [model(allowed)] })
      return Response.json({ data: { endpoints: [endpoint] } })
    },
  })
  expect(await client.forKey("placeholder")).toHaveLength(1)
  state.failure = "/models/user"
  state.now += 300001
  expect(await client.forKey("placeholder")).toEqual([])
  state.failure = ""
  expect(await client.forKey("placeholder")).toHaveLength(1)
  state.failure = `/${allowed}/endpoints`
  expect(await client.forKey("placeholder", true)).toEqual([])
})
