import { expect, test } from "bun:test"
import { MAY_TRAIN_RETENTION, UNREVIEWED_RETENTION } from "@vectordevai/schema/free-model"
import {
  FREE_MODEL_POLICY_REVIEWED,
  REVIEWED_FREE_ENDPOINTS,
  barredFreeModel,
  eligibleFreeModel,
  freeEndpointPolicy,
  freeModelDataPolicy,
  freeModelInfo,
  offeredFreeModel,
  personalOnlyFreeModel,
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
    "poolside/laguna-s-2.1:free",
    "poolside/laguna-xs-2.1:free",
    "thinkingmachines/inkling-small:free",
    "thinkingmachines/inkling:free",
    "xingchen-agi/xing4.0-29b-a4b:free",
  ])
  // Each offered model is in the reviewed record, so none of today's models is unreviewed.
  expect(offered.every((id: string) => REVIEWED_FREE_ENDPOINTS.has(id))).toBe(true)
  // The only exclusions by policy are legally barred models, each with its reason.
  for (const item of fixture.models.filter((model: { id: string }) => model.id.startsWith("nvidia/")))
    expect(barredFreeModel(item.id)).toContain("NVIDIA's API Trial Terms")
  expect(offered.some((id: string) => barredFreeModel(id))).toBe(false)
  // Router aliases and items priced per song or clip never qualify.
  for (const id of ["openrouter/free", "google/lyria-3-pro-preview", "google/lyria-3-clip-preview"])
    expect(eligibleFreeModel(metadata(id), fixture.capturedAt)).toBe(false)
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

test("Gemma is offered through the user's own account only, with the reason, and every other model is not", () => {
  // The shared allowance cannot apply the EEA, Swiss and UK limit in Google's Gemini API terms.
  for (const id of ["google/gemma-4-26b-a4b-it:free", "google/gemma-4-31b-it:free"]) {
    expect(personalOnlyFreeModel(id)).toContain("Paid Services")
    expect(offeredFreeModel(metadata(id), fixture.capturedAt)).toBe(true)
  }
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
