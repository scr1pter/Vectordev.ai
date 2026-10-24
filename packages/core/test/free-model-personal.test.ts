import { expect, test } from "bun:test"
import { MAY_TRAIN_RETENTION, UNREVIEWED_RETENTION } from "@vectordevai/schema/free-model"
import { FreeModels } from "../src/free-models"

const endpointsPath = (url: string) => /\/models\/(.+)\/endpoints$/.exec(url)?.[1]
// Every free OpenRouter model and endpoint, captured from the public API on 17 October 2026.
const fixture = await Bun.file(new URL("./fixture/free-model-public-2026-10-17.json", import.meta.url)).json()

test("a personal account gets every free model its settings allow, each with its data policy, NVIDIA's included", async () => {
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
  expect(
    models.map((item) => [item.id, item.providers.map((provider) => `${provider.id}:${provider.dataPolicy}`)]),
  ).toEqual([
    ["thinkingmachines/inkling-small:free", ["thinkingmachines/nvfp4:may-train"]],
    ["thinkingmachines/inkling:free", ["thinkingmachines/nvfp4:may-train"]],
    ["nvidia/nemotron-3.5-lightning:free", ["nvidia/nvfp4:may-train"]],
    ["nvidia/nemotron-3.5-super-vl:free", ["nvidia:may-train"]],
    ["dots-studio/dots-3-note-preview:free", ["atlas-cloud/fp8:no-training"]],
    // Gemma is offered on both Vector and personal accounts, with a US only tag.
    ["google/gemma-4-26b-a4b-it:free", ["google-ai-studio:no-training"]],
    ["google/gemma-4-31b-it:free", ["google-ai-studio:no-training"]],
    ["nvidia/nemotron-3-super-120b-a12b:free", ["nvidia:may-train"]],
    ["poolside/laguna-s-2.1:free", ["poolside/fp4:may-train"]],
    ["poolside/laguna-xs-2.1:free", ["poolside/fp8:may-train"]],
    ["xingchen-agi/xing4.0-29b-a4b:free", ["phala:no-training"]],
    ["cohere/north-mini-code:free", ["cohere:no-training"]],
    ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", ["nvidia:may-train"]],
    // OpenRouter's Free Models Router, which picks a free model at random, so it is labelled as one that may train.
    ["openrouter/free", ["openrouter:may-train"]],
    ["liquid/lfm-2.5-2.6b:free", ["liquid/fp8:may-train"]],
  ])
  // Nemotron 3 Ultra's one endpoint was down and served nothing that day, so it is left out. Models without tools
  // (NVIDIA's content-safety classifier, Google's Lyria previews) are never looked up, nor is the free router, which
  // has no endpoint list of its own. NVIDIA's other models are, since the owner's decision of 23 October 2026.
  const looked = requests.slice(1).map(endpointsPath)
  expect(looked.filter((id) => /^(?:openrouter|google\/lyria)|content-safety/.test(id ?? ""))).toEqual([])
  expect(looked.filter((id) => id?.startsWith("nvidia/")).length).toBe(5)
})

test("an account whose privacy settings hide may-train models gets the no-training ones only", async () => {
  // OpenRouter's /models/user applies the account's settings, so blocked may-train models are simply absent.
  const noTraining = ["cohere/north-mini-code:free", "xingchen-agi/xing4.0-29b-a4b:free"]
  const client = FreeModels.createClient({
    now: () => fixture.capturedAt,
    request: async (url) => {
      if (url.endsWith("/models/user"))
        return Response.json({ data: fixture.models.filter((item: { id: string }) => noTraining.includes(item.id)) })
      const id = endpointsPath(url)
      if (id && fixture.endpoints[id]) return Response.json({ data: { id, endpoints: fixture.endpoints[id] } })
      throw new Error("Only catalog metadata may be requested")
    },
  })
  expect((await client.forKey("placeholder")).map((item) => item.id).sort()).toEqual(noTraining)
})

test("one unreadable endpoint list drops only that model from a personal account", async () => {
  const two = ["cohere/north-mini-code:free", "dots-studio/dots-3-note-preview:free"]
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
        if (url.endsWith("/models/user"))
          return Response.json({ data: fixture.models.filter((item: { id: string }) => two.includes(item.id)) })
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
const reviewed = "cohere/north-mini-code:free"
const endpoint = {
  model_id: reviewed,
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
        return Response.json({ data: [model(reviewed)] })
      }
      expect(new Headers(init.headers).has("authorization")).toBe(false)
      if (endpointsPath(url) === reviewed) return Response.json({ data: { endpoints: [endpoint] } })
      throw new Error("Personal access must not request the shared catalog")
    },
  })
  expect(await client.forKey("placeholder")).toEqual([
    {
      id: reviewed,
      name: "cohere/north-mini-code",
      contextLength: 8000,
      maxOutputTokens: 2048,
      // This endpoint takes no reasoning parameter, which the catalog says outright.
      reasoning: "unsupported",
      providers: [
        {
          id: "cohere/checked",
          name: "Cohere",
          retention: "Kept up to 30 days; not used for training.",
          dataPolicy: "no-training",
        },
      ],
    },
  ])
  expect(requests).toHaveLength(2)
  await client.forKey("placeholder")
  expect(requests).toHaveLength(2)
})

test("an unreviewed free model or provider is offered on a personal account as one that may train", async () => {
  const client = FreeModels.createClient({
    request: async (url) => {
      if (url.endsWith("/models/user")) return Response.json({ data: [model("maker/new:free"), model(reviewed)] })
      const id = endpointsPath(url)
      if (id === "maker/new:free")
        return Response.json({
          data: { endpoints: [{ ...endpoint, model_id: id, provider_name: "Maker", tag: "maker" }] },
        })
      return Response.json({ data: { endpoints: [{ ...endpoint, provider_name: "Poolside", tag: "poolside/fp8" }] } })
    },
  })
  const models = await client.forKey("placeholder")
  expect(models.map((item) => [item.id, item.providers])).toEqual([
    [
      "cohere/north-mini-code:free",
      [{ id: "poolside/fp8", name: "Poolside", retention: UNREVIEWED_RETENTION, dataPolicy: "may-train" }],
    ],
    ["maker/new:free", [{ id: "maker", name: "Maker", retention: UNREVIEWED_RETENTION, dataPolicy: "may-train" }]],
  ])
  expect(MAY_TRAIN_RETENTION).toContain("train")
})

test("personal discovery checks free IDs, prices, tools and expiry before endpoint lookup", async () => {
  const requests: string[] = []
  const client = FreeModels.createClient({
    now: () => Date.UTC(2026, 9, 2),
    request: async (url) => {
      requests.push(url)
      if (url.endsWith("/models/user"))
        return Response.json({
          data: [
            model(reviewed),
            model("cohere/north-mini-code"),
            model("openrouter/auto:free"),
            { ...model("dots-studio/dots-3-note-preview:free"), expiration_date: "2026-10-01" },
            { ...model("maker/no-tools:free"), supported_parameters: ["tool_choice"] },
          ],
        })
      return Response.json({ data: { endpoints: [endpoint] } })
    },
  })
  expect((await client.forKey("placeholder")).map((item) => item.id)).toEqual([reviewed])
  expect(requests).toEqual([
    `${FreeModels.OPENROUTER_ROOT}/models/user`,
    `${FreeModels.OPENROUTER_ROOT}/models/${reviewed}/endpoints`,
  ])
})

test("personal discovery skips models within a day of expiry", async () => {
  const requests: string[] = []
  const client = FreeModels.createClient({
    now: () => Date.UTC(2026, 9, 15),
    request: async (url) => {
      requests.push(url)
      if (url.endsWith("/models/user"))
        return Response.json({
          data: [
            model(reviewed),
            { ...model("dots-studio/dots-3-note-preview:free"), expiration_date: "2026-10-16T00:00:00Z" },
          ],
        })
      return Response.json({ data: { endpoints: [endpoint] } })
    },
  })
  expect((await client.forKey("placeholder")).map((item) => item.id)).toEqual([reviewed])
  expect(requests.slice(1).map(endpointsPath)).toEqual([reviewed])
})

test("personal discovery fails closed for priced, unavailable or mismatched endpoints", async () => {
  const invalid = [
    { ...endpoint, pricing: { ...endpoint.pricing, request: "0.01" } },
    { ...endpoint, pricing: { ...endpoint.pricing, completion: "0.01" } },
    { ...endpoint, supported_parameters: ["tool_choice"] },
    { ...endpoint, status: 1 },
    { ...endpoint, context_length: 0 },
    { ...endpoint, tag: "" },
    { ...endpoint, model_id: "cohere/other:free" },
    { ...endpoint, model_id: undefined },
  ]
  for (const entry of invalid) {
    const client = FreeModels.createClient({
      request: async (url) => {
        if (url.endsWith("/models/user")) return Response.json({ data: [model(reviewed)] })
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
      if (url.endsWith("/models/user")) return Response.json({ data: [model(reviewed)] })
      return Response.json({ data: { endpoints: [endpoint] } })
    },
  })
  expect(await client.forKey("placeholder")).toHaveLength(1)
  state.failure = "/models/user"
  state.now += 300001
  expect(await client.forKey("placeholder")).toEqual([])
  state.failure = ""
  expect(await client.forKey("placeholder")).toHaveLength(1)
  state.failure = `/${reviewed}/endpoints`
  expect(await client.forKey("placeholder", true)).toEqual([])
})
