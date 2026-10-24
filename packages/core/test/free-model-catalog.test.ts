import { expect, test } from "bun:test"
import { FREE_ROUTER_RETENTION, MAY_TRAIN_RETENTION, UNREVIEWED_RETENTION } from "@vectordevai/schema/free-model"
import {
  BARRED_FREE_PROVIDERS,
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
  sendsToOpenRouterFree,
  zeroFreeModelPricing,
} from "../src/free-model-catalog"

// Every free OpenRouter model and endpoint, captured from the public API on 17 October 2026 and on 24 October 2026
// (06:26 UTC, the evening of 23 October in California, when the owner asked to see all of them).
const fixture = await Bun.file(new URL("./fixture/free-model-public-2026-10-17.json", import.meta.url)).json()
const today = await Bun.file(new URL("./fixture/free-model-public-2026-10-24.json", import.meta.url)).json()
const metadata = (id: string) => fixture.models.find((item: { id: string }) => item.id === id)
const info = (id: string) => freeModelInfo(metadata(id), fixture.endpoints[id])
const cohere = metadata("cohere/north-mini-code:free")
const [endpoint] = fixture.endpoints["cohere/north-mini-code:free"]

test("every free model OpenRouter lists is offered, NVIDIA's and unreviewed ones included, except non-tool models", () => {
  expect(FREE_MODEL_POLICY_REVIEWED).toBe("2026-10-17")
  const offered = today.models
    .filter((item: typeof cohere) => offeredFreeModel(item, today.capturedAt))
    .map((item: { id: string }) => item.id)
    .sort()
  expect(offered).toEqual([
    "cohere/north-mini-code:free",
    "dots-studio/dots-3-note-preview:free",
    "google/gemma-4-26b-a4b-it:free",
    "google/gemma-4-31b-it:free",
    "liquid/lfm-2.5-2.6b:free",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "nvidia/nemotron-3.5-lightning:free",
    "nvidia/nemotron-3.5-super-vl:free",
    "openrouter/free",
    "poolside/laguna-s-2.1:free",
    "poolside/laguna-xs-2.1:free",
    "recursive/flint-v1.0:free",
    "thinkingmachines/inkling-small:free",
    "thinkingmachines/inkling:free",
    "xingchen-agi/xing4.0-29b-a4b:free",
  ])
  // The owner's count of 23 October 2026: 20 zero-price IDs, the router included. The three not offered are NVIDIA's
  // content-safety classifier and Google's two Lyria music previews: none lists tools.
  const zeroPrice = today.models
    .filter((item: typeof cohere) => zeroFreeModelPricing(item.pricing))
    .map((item: { id: string }) => item.id)
  expect(zeroPrice).toHaveLength(20)
  expect(zeroPrice.filter((id: string) => !offered.includes(id)).sort()).toEqual([
    "google/lyria-3-clip-preview",
    "google/lyria-3-pro-preview",
    "nvidia/nemotron-3.5-content-safety:free",
  ])
  for (const id of zeroPrice.filter((id: string) => !offered.includes(id)))
    expect(today.models.find((item: { id: string }) => item.id === id).supported_parameters).not.toContain("tools")
  // The 17 October capture differs only by Recursive's Flint, which OpenRouter listed later.
  expect(
    fixture.models
      .filter((item: typeof cohere) => offeredFreeModel(item, fixture.capturedAt))
      .map((item: { id: string }) => item.id)
      .sort(),
  ).toEqual(offered.filter((id: string) => id !== "recursive/flint-v1.0:free"))
  // No author is barred since the owner's decision of 23 October 2026, so the free router skips no provider either.
  expect(today.models.filter((item: { id: string }) => barredFreeModel(item.id))).toEqual([])
  expect(BARRED_FREE_PROVIDERS).toEqual([])
  // Lyria is left out for its missing tools, the reason the docs give: its capture has zero prices and no `tools`. With
  // tools, it would still need a `:free` ID.
  for (const id of ["google/lyria-3-pro-preview", "google/lyria-3-clip-preview"]) {
    expect(zeroFreeModelPricing(metadata(id).pricing)).toBe(true)
    expect(metadata(id).supported_parameters).not.toContain("tools")
    expect(eligibleFreeModel(metadata(id), fixture.capturedAt)).toBe(false)
    const withTools = { ...metadata(id), supported_parameters: [...metadata(id).supported_parameters, "tools"] }
    expect(eligibleFreeModel(withTools, fixture.capturedAt)).toBe(false)
    expect(eligibleFreeModel({ ...withTools, id: `${id}:free` }, fixture.capturedAt)).toBe(true)
    // And its audio output, as OpenRouter's full listing of that day gives it, keeps it out even then.
    const audio = { input_modalities: ["text", "image"], output_modalities: ["text", "audio"] }
    expect(eligibleFreeModel({ ...withTools, id: `${id}:free`, architecture: audio }, fixture.capturedAt)).toBe(false)
  }
  for (const id of ["openrouter/auto", "openrouter/free:nitro", "OpenRouter/free", " openrouter/free"])
    expect(isFreeModelID(id)).toBe(false)
  expect(isFreeModelID("openrouter/free")).toBe(true)
})

test("OpenRouter's Free Models Router is offered as one that may train, with no providers to name", () => {
  // It lists no endpoints: it picks a free model at random for each request.
  expect(fixture.endpoints["openrouter/free"]).toEqual([])
  const router = info("openrouter/free")
  expect(router).toEqual({
    id: "openrouter/free",
    name: "Free Models Router",
    contextLength: 200000,
    // No output limit is published; 8,192 fits every tool-capable free model of 17 October 2026.
    maxOutputTokens: 8192,
    providers: [{ id: "openrouter", name: "OpenRouter", retention: FREE_ROUTER_RETENTION, dataPolicy: "may-train" }],
  })
  expect(freeModelDataPolicy(router!)).toBe("may-train")
  expect(barredFreeModel("openrouter/free")).toBeUndefined()
  // A priced or tool-less listing would not qualify.
  const listing = metadata("openrouter/free")
  expect(freeModelInfo({ ...listing, pricing: { prompt: "0.000001", completion: "0" } }, [])).toBeUndefined()
  expect(freeModelInfo({ ...listing, supported_parameters: ["tool_choice"] }, [])).toBeUndefined()
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
    today.models.flatMap((item: typeof cohere) => {
      const model = offeredFreeModel(item, today.capturedAt) && freeModelInfo(item, today.endpoints[item.id])
      return model
        ? [[model.id, model.providers.map((provider) => `${provider.dataPolicy}: ${provider.retention}`)]]
        : []
    }),
  )
  expect(policies).toEqual({
    "xingchen-agi/xing4.0-29b-a4b:free": [
      "no-training: No prompt retention or training on OpenRouter's endpoint record.",
    ],
    "cohere/north-mini-code:free": ["no-training: Kept up to 30 days; not used for training."],
    "dots-studio/dots-3-note-preview:free": [
      "no-training: Kept for a period AtlasCloud does not publish; not used for training.",
    ],
    "google/gemma-4-26b-a4b-it:free": ["no-training: Kept up to 55 days; not used for training."],
    "google/gemma-4-31b-it:free": ["no-training: Kept up to 55 days; not used for training."],
    "poolside/laguna-s-2.1:free": [`may-train: ${MAY_TRAIN_RETENTION}`],
    "poolside/laguna-xs-2.1:free": [`may-train: ${MAY_TRAIN_RETENTION}`],
    "liquid/lfm-2.5-2.6b:free": [`may-train: ${MAY_TRAIN_RETENTION}`],
    "thinkingmachines/inkling:free": [`may-train: ${MAY_TRAIN_RETENTION}`],
    "thinkingmachines/inkling-small:free": [`may-train: ${MAY_TRAIN_RETENTION}`],
    // NVIDIA's endpoints train on prompts by OpenRouter's records of 17 October 2026.
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": [`may-train: ${MAY_TRAIN_RETENTION}`],
    "nvidia/nemotron-3-ultra-550b-a55b:free": [`may-train: ${MAY_TRAIN_RETENTION}`],
    "nvidia/nemotron-3.5-lightning:free": [`may-train: ${MAY_TRAIN_RETENTION}`],
    "nvidia/nemotron-3.5-super-vl:free": [`may-train: ${MAY_TRAIN_RETENTION}`],
    // Listed by OpenRouter after the review of 17 October 2026, so labelled the worst case until Vector reviews it,
    // though OpenRouter records it as not training.
    "recursive/flint-v1.0:free": [`may-train: ${UNREVIEWED_RETENTION}`],
    "openrouter/free": [`may-train: ${FREE_ROUTER_RETENTION}`],
  })
  // Nemotron 3 Super is missing only because its one endpoint was down and served nothing all day (status -5, no
  // uptime in the last day).
  expect(today.endpoints["nvidia/nemotron-3-super-120b-a12b:free"]).toMatchObject([{ status: -5, uptime_last_1d: 0 }])
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

test("both Gemma models qualify for the shared catalog with their reviewed no-training policy", () => {
  for (const id of ["google/gemma-4-26b-a4b-it:free", "google/gemma-4-31b-it:free"]) {
    expect(offeredFreeModel(metadata(id), fixture.capturedAt)).toBe(true)
    expect(freeModelDataPolicy(info(id)!)).toBe("no-training")
  }
})

test("an endpoint Vector has not reviewed is offered as one that may train, never as no-training", () => {
  // A new free model, or a reviewed model served by a provider nobody reviewed, gets the worst case and says why.
  const newModel = { ...cohere, id: "acme/new-coder:free" }
  const unreviewed = freeModelInfo(newModel, [{ ...endpoint, model_id: newModel.id, tag: "acme" }])
  expect(unreviewed?.providers).toEqual([
    { id: "acme", name: "Cohere", retention: UNREVIEWED_RETENTION, dataPolicy: "may-train" },
  ])
  expect(UNREVIEWED_RETENTION).toContain("Vector has not reviewed this provider's data policy")
  expect(freeModelDataPolicy(unreviewed!)).toBe("may-train")
  expect(freeEndpointPolicy("cohere/north-mini-code:free", "atlas-cloud/fp8")).toBe("may-train")
  // A reviewed no-training endpoint stays no-training.
  expect(freeEndpointPolicy("cohere/north-mini-code:free", "cohere")).toBe("no-training")
  // The "unreviewed" of an engine from before 23 October 2026 reads as may-train.
  expect(
    freeModelDataPolicy({
      id: "acme/x:free",
      providers: [{ id: "acme", name: "", retention: "", dataPolicy: "unreviewed" }],
    }),
  ).toBe("may-train")
  // A catalog from before 1.99.109 has no policy on its providers: the reviewed record decides, and anything it
  // does not know may train.
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
    "may-train",
  )
  expect(freeModelDataPolicy({ id: "acme/x:free", providers: [] })).toBe("may-train")
  // One may-train endpoint makes the whole model one that may train.
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
  expect(freeModelInfo(cohere, [{ ...endpoint, supported_parameters: ["tool_choice"] }])).toBeUndefined()
  expect(eligibleFreeModel({ ...cohere, supported_parameters: ["tool_choice"] }, fixture.capturedAt)).toBe(false)
})

test("endpoint checks refuse mismatched, priced or tool-less endpoints, and ones down all day", () => {
  for (const change of [
    { model_id: "cohere/other:free" },
    { model_id: undefined },
    { status: 1, uptime_last_1d: 0 },
    { status: -5, uptime_last_1d: 0 },
    { status: -5, uptime_last_1d: null },
    { status: -5, uptime_last_1d: undefined },
    { tag: "" },
    { pricing: { ...endpoint.pricing, completion: "0.01" } },
    { pricing: { ...endpoint.pricing, request: "" } },
    { supported_parameters: [] },
    { context_length: 0 },
  ])
    expect(freeModelInfo(cohere, [{ ...endpoint, ...change }])).toBeUndefined()
})

test("an endpoint down when the catalog is built stays listed if it served requests in the last day", () => {
  // Liquid's only endpoint served about a third of the day before 24 October 2026, 06:26 UTC. Read while it was down,
  // the daily catalog used to leave the model out until the next day's refresh.
  const liquid = today.models.find((item: { id: string }) => item.id === "liquid/lfm-2.5-2.6b:free")
  const [down] = today.endpoints[liquid.id]
  expect(down.uptime_last_1d).toBeGreaterThan(0)
  expect(down.uptime_last_1d).toBeLessThan(50)
  expect(freeModelInfo(liquid, [{ ...down, status: -5 }])?.providers.map((provider) => provider.id)).toEqual([
    "liquid/fp8",
  ])
  // NVIDIA's Super VL was marked -2 while answering every request of the last half hour.
  const vl = today.models.find((item: { id: string }) => item.id === "nvidia/nemotron-3.5-super-vl:free")
  expect(today.endpoints[vl.id]).toMatchObject([{ status: -2 }])
  expect(freeModelInfo(vl, today.endpoints[vl.id])).toBeDefined()
})

test("offered models are free, zero-priced, tool-capable and more than a day from expiry", () => {
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
  // Text among the inputs and as the only output, where OpenRouter lists modalities; image input is fine.
  for (const [input, output, eligible] of [
    [["text"], ["text"], true],
    [["text", "image", "audio"], ["text"], true],
    [["image"], ["text"], false],
    [["text"], ["text", "audio"], false],
    [["text"], ["image"], false],
    [["text"], [], false],
  ] as const)
    expect(
      eligibleFreeModel({ ...free, architecture: { input_modalities: input, output_modalities: output } }, now),
    ).toBe(eligible)
  for (const price of ["", "unknown", "NaN", "-1"])
    expect(eligibleFreeModel({ ...free, pricing: { ...free.pricing, request: price } }, now)).toBe(false)
  // Poolside's free Laguna endpoints end on 31 October 2026: offered until a day before, since the shared catalog is
  // rebuilt daily, and each copy says when, so a catalog kept past that day stops serving it.
  const laguna = metadata("poolside/laguna-s-2.1:free")
  expect(offeredFreeModel(laguna, Date.parse("2026-10-24T06:26:00Z"))).toBe(true)
  expect(offeredFreeModel(laguna, Date.parse("2026-10-29T23:59:59Z"))).toBe(true)
  expect(offeredFreeModel(laguna, Date.parse("2026-10-30T00:00:00Z"))).toBe(false)
  expect(info("poolside/laguna-s-2.1:free")?.expiresAt).toBe(Date.parse("2026-10-31"))
  expect(info("cohere/north-mini-code:free")).not.toHaveProperty("expiresAt")
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
    freeModelInfo({ ...cohere, ...model }, endpoints)?.reasoning
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
