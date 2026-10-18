import { expect, test } from "bun:test"
import { FREE_ROUTER_RETENTION, MAY_TRAIN_RETENTION, UNREVIEWED_RETENTION } from "@vectordevai/schema/free-model"
import {
  FREE_MODEL_POLICY_REVIEWED,
  REVIEWED_FREE_ENDPOINTS,
  barredFreeModel,
  denyDataCollection,
  eligibleFreeModel,
  freeEndpointPolicy,
  freeModelDataPolicy,
  freeModelInfo,
  isFreeModelID,
  isOpenRouterURL,
  offeredFreeModel,
  openRouterModelRouting,
  personalOnlyFreeModel,
  sendsToOpenRouterFree,
  zeroFreeModelPricing,
} from "../src/free-model-catalog"

// Every free OpenRouter model and endpoint, captured from the public API on 17 October 2026.
const fixture = await Bun.file(new URL("./fixture/free-model-public-2026-10-17.json", import.meta.url)).json()
const metadata = (id: string) => fixture.models.find((item: { id: string }) => item.id === id)
const info = (id: string, reviewedOnly = false) => freeModelInfo(metadata(id), fixture.endpoints[id], { reviewedOnly })
const cohere = metadata("cohere/north-mini-code:free")
const [endpoint] = fixture.endpoints["cohere/north-mini-code:free"]

test("every free model of 17 October 2026 is offered except NVIDIA's trial endpoints and models without tools", () => {
  expect(FREE_MODEL_POLICY_REVIEWED).toBe("2026-10-17")
  const offered = fixture.models
    .filter((item: typeof cohere) => offeredFreeModel(item, fixture.capturedAt))
    .map((item: { id: string }) => item.id)
    .sort()
  expect(offered).toEqual([
    "cohere/north-mini-code:free",
    "dots-studio/dots-3-note-preview:free",
    "google/gemma-4-26b-a4b-it:free",
    "google/gemma-4-31b-it:free",
    "liquid/lfm-2.5-2.6b:free",
    "openrouter/free",
    "poolside/laguna-s-2.1:free",
    "poolside/laguna-xs-2.1:free",
    "thinkingmachines/inkling-small:free",
    "thinkingmachines/inkling:free",
    "xingchen-agi/xing4.0-29b-a4b:free",
  ])
  // The owner's count of 17 October 2026: 19 zero-price IDs, the router included. Each one not offered is NVIDIA's,
  // barred by its terms, or a Google Lyria preview, which the capture lists at zero token prices but without tools.
  const zeroPrice = fixture.models
    .filter((item: typeof cohere) => zeroFreeModelPricing(item.pricing))
    .map((item: { id: string }) => item.id)
  expect(zeroPrice).toHaveLength(19)
  expect(zeroPrice.filter((id: string) => !offered.includes(id)).sort()).toEqual([
    "google/lyria-3-clip-preview",
    "google/lyria-3-pro-preview",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "nvidia/nemotron-3.5-content-safety:free",
    "nvidia/nemotron-3.5-lightning:free",
    "nvidia/nemotron-3.5-super-vl:free",
  ])
  // Each offered model is in the reviewed record, so none of today's models is unreviewed.
  expect(offered.every((id: string) => REVIEWED_FREE_ENDPOINTS.has(id))).toBe(true)
  // The only exclusions by policy are legally barred models, each with its reason.
  for (const item of fixture.models.filter((model: { id: string }) => model.id.startsWith("nvidia/")))
    expect(barredFreeModel(item.id)).toContain("NVIDIA's API Trial Terms")
  expect(offered.some((id: string) => barredFreeModel(id))).toBe(false)
  // Lyria is left out for its missing tools, the reason the docs give: its capture has zero prices and no `tools`. With
  // tools, it would still need a `:free` ID.
  for (const id of ["google/lyria-3-pro-preview", "google/lyria-3-clip-preview"]) {
    expect(zeroFreeModelPricing(metadata(id).pricing)).toBe(true)
    expect(metadata(id).supported_parameters).not.toContain("tools")
    expect(eligibleFreeModel(metadata(id), fixture.capturedAt)).toBe(false)
    const withTools = { ...metadata(id), supported_parameters: [...metadata(id).supported_parameters, "tools"] }
    expect(eligibleFreeModel(withTools, fixture.capturedAt)).toBe(false)
    expect(eligibleFreeModel({ ...withTools, id: `${id}:free` }, fixture.capturedAt)).toBe(true)
  }
  for (const id of ["openrouter/auto", "openrouter/free:nitro", "OpenRouter/free", " openrouter/free"])
    expect(isFreeModelID(id)).toBe(false)
  expect(isFreeModelID("openrouter/free")).toBe(true)
})

test("OpenRouter's Free Models Router is offered as one that may train, with no providers to name", () => {
  // It lists no endpoints: it picks a free model at random for each request.
  expect(fixture.endpoints["openrouter/free"]).toEqual([])
  const router = info("openrouter/free", true)
  expect(router).toEqual({
    id: "openrouter/free",
    name: "Free Models Router",
    contextLength: 200000,
    // No output limit is published; 8,192 fits every tool-capable free model of 17 October 2026.
    maxOutputTokens: 8192,
    providers: [{ id: "openrouter", name: "OpenRouter", retention: FREE_ROUTER_RETENTION, dataPolicy: "may-train" }],
  })
  expect(freeModelDataPolicy(router!)).toBe("may-train")
  expect(personalOnlyFreeModel("openrouter/free")).toBeUndefined()
  expect(barredFreeModel("openrouter/free")).toBeUndefined()
  // A priced or tool-less listing would not qualify.
  const listing = metadata("openrouter/free")
  expect(
    freeModelInfo({ ...listing, pricing: { prompt: "0.000001", completion: "0" } }, [], { reviewedOnly: true }),
  ).toBeUndefined()
  expect(
    freeModelInfo({ ...listing, supported_parameters: ["tool_choice"] }, [], { reviewedOnly: true }),
  ).toBeUndefined()
  // Every tool-capable free endpoint of that day accepts a reply of the router's length.
  const limits = Object.values(
    fixture.endpoints as Record<string, { max_completion_tokens: number | null; supported_parameters: string[] }[]>,
  )
    .flat()
    .filter((item) => item.supported_parameters.includes("tools"))
    .map((item) => item.max_completion_tokens ?? Infinity)
  expect(Math.min(...limits)).toBe(router!.maxOutputTokens)
})

test("each endpoint carries its reviewed policy, and today's may-train providers are labelled as such", () => {
  const policies = Object.fromEntries(
    [...REVIEWED_FREE_ENDPOINTS.keys()].map((id) => [id, info(id)?.providers.map((provider) => provider.dataPolicy)]),
  )
  expect(policies).toEqual({
    "xingchen-agi/xing4.0-29b-a4b:free": ["no-training"],
    "cohere/north-mini-code:free": ["no-training"],
    "dots-studio/dots-3-note-preview:free": ["no-training"],
    "google/gemma-4-26b-a4b-it:free": ["no-training"],
    "google/gemma-4-31b-it:free": ["no-training"],
    "poolside/laguna-s-2.1:free": ["may-train"],
    "poolside/laguna-xs-2.1:free": ["may-train"],
    "liquid/lfm-2.5-2.6b:free": ["may-train"],
    "thinkingmachines/inkling:free": ["may-train"],
    "thinkingmachines/inkling-small:free": ["may-train"],
    "openrouter/free": ["may-train"],
  })
  expect(info("poolside/laguna-s-2.1:free")?.providers).toEqual([
    { id: "poolside/fp4", name: "Poolside", retention: MAY_TRAIN_RETENTION, dataPolicy: "may-train" },
  ])
  expect(info("cohere/north-mini-code:free")).toEqual({
    id: "cohere/north-mini-code:free",
    name: "Cohere: North Mini Code",
    contextLength: 256000,
    maxOutputTokens: 64000,
    providers: [
      {
        id: "cohere",
        name: "Cohere",
        retention: "Kept up to 30 days; not used for training.",
        dataPolicy: "no-training",
      },
    ],
  })
  // No retention text claims zero data retention.
  expect(JSON.stringify(info("cohere/north-mini-code:free"))).not.toMatch(/zero data retention|\bZDR\b/i)
})

test("only Gemma is offered through the user's own account alone, with the reason", () => {
  // The shared allowance cannot apply the EEA, Swiss and UK limit in Google's Gemini API terms.
  for (const id of ["google/gemma-4-26b-a4b-it:free", "google/gemma-4-31b-it:free"]) {
    expect(personalOnlyFreeModel(id)).toContain("Paid Services")
    expect(offeredFreeModel(metadata(id), fixture.capturedAt)).toBe(true)
  }
  // The owner's decision of 17 October 2026: every free model belongs on the shared allowance unless its terms bar
  // it. RedPill's terms, under which Phala serves Xing4.0, do not address free use, which is not a bar.
  expect(personalOnlyFreeModel("xingchen-agi/xing4.0-29b-a4b:free")).toBeUndefined()
  expect([...REVIEWED_FREE_ENDPOINTS.keys()].filter((id) => personalOnlyFreeModel(id))).toEqual([
    "google/gemma-4-26b-a4b-it:free",
    "google/gemma-4-31b-it:free",
  ])
})

test("an unknown policy is never presented as no-training", () => {
  // A new free model, or a reviewed model served by a provider nobody reviewed, is "unreviewed".
  const newModel = { ...cohere, id: "acme/new-coder:free" }
  const unreviewed = freeModelInfo(newModel, [{ ...endpoint, model_id: newModel.id, tag: "acme" }], {
    reviewedOnly: false,
  })
  expect(unreviewed?.providers).toEqual([
    { id: "acme", name: "Cohere", retention: UNREVIEWED_RETENTION, dataPolicy: "unreviewed" },
  ])
  expect(freeModelDataPolicy(unreviewed!)).toBe("unreviewed")
  expect(freeEndpointPolicy("cohere/north-mini-code:free", "atlas-cloud/fp8")).toBe("unreviewed")
  // The shared allowance serves reviewed endpoints only.
  expect(
    freeModelInfo(newModel, [{ ...endpoint, model_id: newModel.id, tag: "acme" }], { reviewedOnly: true }),
  ).toBeUndefined()
  // A catalog from before 1.99.109 has no policy on its providers: the reviewed record decides, and anything it
  // does not know is unreviewed.
  expect(
    freeModelDataPolicy({
      id: "poolside/laguna-s-2.1:free",
      providers: [{ id: "poolside/fp4", name: "", retention: "" }],
    }),
  ).toBe("may-train")
  expect(
    freeModelDataPolicy({ id: "cohere/north-mini-code:free", providers: [{ id: "cohere", name: "", retention: "" }] }),
  ).toBe("no-training")
  expect(freeModelDataPolicy({ id: "acme/x:free", providers: [{ id: "acme", name: "", retention: "" }] })).toBe(
    "unreviewed",
  )
  expect(freeModelDataPolicy({ id: "acme/x:free", providers: [] })).toBe("unreviewed")
  // One may-train or unreviewed endpoint makes the whole model one that may train.
  expect(
    freeModelDataPolicy({
      id: "cohere/north-mini-code:free",
      providers: [
        { id: "cohere", name: "", retention: "", dataPolicy: "no-training" },
        { id: "acme", name: "", retention: "", dataPolicy: "may-train" },
      ],
    }),
  ).toBe("may-train")
})

test("an endpoint without tool_choice is kept and marked, and tools stay required", () => {
  // Thinking Machines' free endpoints call tools but accept no tool_choice.
  expect(info("thinkingmachines/inkling:free")?.toolChoice).toBe(false)
  expect(info("cohere/north-mini-code:free")).not.toHaveProperty("toolChoice")
  expect(
    freeModelInfo(cohere, [{ ...endpoint, supported_parameters: ["tool_choice"] }], { reviewedOnly: false }),
  ).toBeUndefined()
  expect(eligibleFreeModel({ ...cohere, supported_parameters: ["tool_choice"] }, fixture.capturedAt)).toBe(false)
})

test("endpoint checks refuse mismatched, offline, priced or tool-less endpoints", () => {
  for (const change of [
    { model_id: "cohere/other:free" },
    { model_id: undefined },
    { status: 1 },
    { status: -5 },
    { tag: "" },
    { pricing: { ...endpoint.pricing, completion: "0.01" } },
    { pricing: { ...endpoint.pricing, request: "" } },
    { supported_parameters: [] },
    { context_length: 0 },
  ])
    expect(freeModelInfo(cohere, [{ ...endpoint, ...change }], { reviewedOnly: false })).toBeUndefined()
})

test("offered models are free, zero-priced, tool-capable and more than a week from expiry", () => {
  const now = Date.UTC(2026, 9, 2)
  const free = { ...cohere, pricing: { prompt: "0", completion: "0", request: "0", image: "0" } }
  expect(eligibleFreeModel(free, now)).toBe(true)
  for (const id of ["cohere/not-free", "openrouter/auto:free", "cohere/model:online:free", "cohere/trailing:free\n"])
    expect(eligibleFreeModel({ ...free, id }, now)).toBe(false)
  for (const change of [
    { expiration_date: "2026-10-01" },
    { expiration_date: "unknown" },
    { supported_parameters: [] },
  ])
    expect(eligibleFreeModel({ ...free, ...change }, now)).toBe(false)
  for (const field of ["prompt", "completion", "request", "image", "web_search", "internal_reasoning"])
    expect(eligibleFreeModel({ ...free, pricing: { ...free.pricing, [field]: "0.01" } }, now)).toBe(false)
  for (const price of ["", "unknown", "NaN", "-1"])
    expect(eligibleFreeModel({ ...free, pricing: { ...free.pricing, request: price } }, now)).toBe(false)
  // Poolside's free Laguna endpoints end on 31 October 2026: offered until a week before.
  const laguna = metadata("poolside/laguna-s-2.1:free")
  expect(offeredFreeModel(laguna, Date.parse("2026-10-23T23:00:00Z"))).toBe(true)
  expect(offeredFreeModel(laguna, Date.parse("2026-10-24T00:00:00Z"))).toBe(false)
})

test("a model reaches OpenRouter's free endpoints by its name or the ID it sends, under any provider pointed there", () => {
  const free = (model: Partial<Parameters<typeof sendsToOpenRouterFree>[0]>) =>
    sendsToOpenRouterFree({ providerID: "openrouter", id: "maker/paid", destinations: [], price: undefined, ...model })
  expect(free({})).toBe(false)
  // Configured under another name: the ID sent decides.
  for (const apiID of ["poolside/laguna-s-2.1:free", "openrouter/free", "stealth/owl", " Poolside/Laguna:FREE "])
    expect(free({ apiID })).toBe(true)
  // A variant stacked after `:free` still names the free endpoints.
  expect(free({ id: "poolside/laguna-s-2.1:free:nitro" })).toBe(true)
  expect(free({ id: "maker/paid", price: { input: 0, output: 0 } })).toBe(true)
  // Any provider whose requests go to OpenRouter, by base URL or SDK package.
  for (const destinations of [
    ["https://openrouter.ai/api/v1"],
    [undefined, "https://eu.openrouter.ai/api/v1"],
    ["@openrouter/ai-sdk-provider"],
  ])
    expect(free({ providerID: "or-proxy", apiID: "poolside/laguna-s-2.1:free", destinations })).toBe(true)
  // Another provider elsewhere may name a free ID of its own.
  for (const destinations of [[], ["https://openrouter.ai.example.com/v1"], ["https://example.com/openrouter.ai"]])
    expect(free({ providerID: "acme", apiID: "maker/coder:free", destinations })).toBe(false)
  expect(isOpenRouterURL("not a url")).toBe(false)
})

test("a fully qualified OpenRouter host, ending in a dot, is still OpenRouter", () => {
  // The verifier's low of 18 October 2026: "openrouter.ai." resolves like "openrouter.ai" but missed the host check.
  for (const url of [
    "https://openrouter.ai./api/v1",
    "https://openrouter.ai%2E/api/v1",
    "https://OpenRouter.AI../api/v1",
    "https://eu.openrouter.ai./api/v1",
  ])
    expect({ url, openRouter: isOpenRouterURL(url) }).toEqual({ url, openRouter: true })
  expect(
    sendsToOpenRouterFree({
      providerID: "proxy",
      id: "renamed",
      apiID: "poolside/laguna-s-2.1:free",
      destinations: ["https://openrouter.ai./api/v1"],
      price: undefined,
    }),
  ).toBe(true)
  for (const url of ["https://openrouter.ai.example.com./v1", "https://notopenrouter.ai./v1"])
    expect(isOpenRouterURL(url)).toBe(false)
})

test("OpenRouter settings that let another model answer are named, and provider preferences are not", () => {
  // The verifier's medium of 18 October 2026: fallbacks in a paid-named model's request body reached free endpoints.
  expect(
    openRouterModelRouting(
      { models: ["poolside/laguna-s-2.1:free"], provider: { data_collection: "allow" } },
      "acme/paid-model",
    ),
  ).toEqual(["models"])
  expect(
    openRouterModelRouting({ route: "fallback", preset: "coding", plugins: [{ id: "auto-router" }] }, "acme/paid"),
  ).toEqual(["route", "preset", "plugins"])
  // A preset can also be named in the model ID, and one of OpenRouter's routers picks the model itself.
  expect(openRouterModelRouting({}, "acme/paid@preset/free-coding")).toEqual(["preset"])
  expect(openRouterModelRouting(undefined, "@preset/free-coding")).toEqual(["preset"])
  expect(openRouterModelRouting({}, " OpenRouter/Auto")).toEqual(["model"])
  // Plugins that keep the model, such as web search, are not named; one that is not known to is.
  expect(
    openRouterModelRouting({ plugins: [{ id: "web", max_results: 3 }, { id: "file-parser" }] }, "acme/paid"),
  ).toEqual([])
  for (const plugins of [[{ id: "web" }, { id: "pareto-router" }], [{}], ["web"], { id: "web" }])
    expect(openRouterModelRouting({ plugins }, "acme/paid")).toEqual(["plugins"])
  // Provider preferences only choose among the named model's endpoints, and are how a request asks for no training.
  for (const body of [{}, { provider: { data_collection: "deny", zdr: true } }, { usage: { include: true } }, "x", []])
    expect(openRouterModelRouting(body, "acme/paid")).toEqual([])
})

test("denying data collection keeps every other setting and replaces whatever allowed it", () => {
  // The integrator's decision of 18 October 2026: such requests still go out, asking not to train.
  const body = {
    models: ["openrouter/free"],
    plugins: [{ id: "web" }],
    provider: { data_collection: "allow", sort: "price" },
  }
  expect(denyDataCollection(body)).toEqual({
    models: ["openrouter/free"],
    plugins: [{ id: "web" }],
    provider: { data_collection: "deny", sort: "price" },
  })
  expect(body.provider.data_collection).toBe("allow")
  for (const provider of [undefined, "allow", ["x"], null])
    expect(denyDataCollection({ route: "fallback", provider })).toEqual({
      route: "fallback",
      provider: { data_collection: "deny" },
    })
})

test("reasoning is optional only when OpenRouter says it is not mandatory and every endpoint takes the parameter", () => {
  const info = (model: object, endpoints: object[] = [endpoint]) =>
    freeModelInfo({ ...cohere, ...model }, endpoints, { reviewedOnly: false })?.reasoning
  expect(info({ reasoning: { mandatory: false } })).toBe("optional")
  expect(info({ reasoning: { mandatory: true } })).toBe("mandatory")
  // Unstated: the model keeps its own default.
  expect(info({})).toBeUndefined()
  const noReasoning = {
    ...endpoint,
    supported_parameters: endpoint.supported_parameters.filter((item: string) => item !== "reasoning"),
  }
  // An endpoint without the parameter is said outright, so no client falls back to a value that would send it.
  expect(info({ reasoning: { mandatory: false } }, [noReasoning])).toBe("unsupported")
})
