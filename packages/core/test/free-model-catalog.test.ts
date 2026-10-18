import { expect, test } from "bun:test"
import { NO_TRAINING_RETENTION } from "@vectordevai/schema/free-model"
import { NO_TRAINING_ENDPOINTS, eligibleFreeModel, freeModelInfo, includedFreeModel } from "../src/free-model-catalog"

const fixture = await Bun.file(new URL("./fixture/free-model-public.json", import.meta.url)).json()
const metadata = (id: string) => fixture.models.find((item: { id: string }) => item.id === id)
const cohere = metadata("cohere/north-mini-code:free")
const [endpoint] = fixture.endpoints["cohere/north-mini-code:free"]

test("no-training mode accepts an allowlisted free endpoint and never claims zero data retention", () => {
  const info = freeModelInfo(cohere, [endpoint], { noTraining: true })
  expect(info).toEqual({
    id: "cohere/north-mini-code:free",
    name: "Cohere: North Mini Code",
    contextLength: 256000,
    maxOutputTokens: 64000,
    providers: [{ id: "cohere", name: "Cohere", retention: NO_TRAINING_RETENTION }],
  })
  expect(NO_TRAINING_RETENTION).toContain("not used for training")
  expect(JSON.stringify(info)).not.toMatch(/zero data retention|\bZDR\b|no retention|no prompt retention/i)
})

test("reasoning is optional only when OpenRouter says it is not mandatory and every endpoint takes the parameter", () => {
  const info = (model: object, endpoints: object[] = [endpoint]) =>
    freeModelInfo({ ...cohere, ...model }, endpoints, { noTraining: true })?.reasoning
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

test("no-training mode applies the same model ID and endpoint checks as ZDR mode", () => {
  for (const change of [
    { model_id: "cohere/other:free" },
    { model_id: undefined },
    { status: 1 },
    { tag: "" },
    { pricing: { ...endpoint.pricing, completion: "0.01" } },
    { pricing: { ...endpoint.pricing, request: "" } },
    { supported_parameters: ["tools"] },
    { context_length: 0 },
  ]) {
    const changed = { ...endpoint, ...change }
    expect(freeModelInfo(cohere, [changed], { zdr: true })).toBeUndefined()
    expect(freeModelInfo(cohere, [changed], { noTraining: true })).toBeUndefined()
  }
})

test("no-training mode keeps only allowlisted model and provider pairs; Poolside's free endpoints may train", () => {
  expect([...NO_TRAINING_ENDPOINTS]).toEqual([
    ["cohere/north-mini-code:free", ["cohere"]],
    ["dots-studio/dots-3-note-preview:free", ["atlas-cloud"]],
  ])
  for (const id of ["poolside/laguna-s-2.1:free", "poolside/laguna-xs-2.1:free"]) {
    expect(freeModelInfo(metadata(id), fixture.endpoints[id], { noTraining: true })).toBeUndefined()
    // The model itself still passes every price, tool and expiry check today.
    expect(eligibleFreeModel(metadata(id), fixture.capturedAt)).toBe(true)
    expect(includedFreeModel(metadata(id), fixture.capturedAt)).toBe(false)
  }
  const unknown = { ...endpoint, provider_name: "Unknown", tag: "unknown/fp8" }
  expect(freeModelInfo(cohere, [unknown], { noTraining: true })).toBeUndefined()
  // An allowlisted provider is not enough: the model must be allowlisted with that provider.
  const dots = metadata("dots-studio/dots-3-note-preview:free")
  const [atlasEndpoint] = fixture.endpoints["dots-studio/dots-3-note-preview:free"]
  expect(freeModelInfo(dots, [{ ...endpoint, model_id: dots.id }], { noTraining: true })).toBeUndefined()
  expect(freeModelInfo(cohere, [{ ...atlasEndpoint, model_id: cohere.id }], { noTraining: true })).toBeUndefined()
  const newCohere = { ...cohere, id: "cohere/north-code-next:free" }
  expect(eligibleFreeModel(newCohere, fixture.capturedAt)).toBe(true)
  expect(includedFreeModel(newCohere, fixture.capturedAt)).toBe(false)
  expect(freeModelInfo(newCohere, [{ ...endpoint, model_id: newCohere.id }], { noTraining: true })).toBeUndefined()
  expect(freeModelInfo(dots, [atlasEndpoint], { noTraining: true })?.providers).toEqual([
    { id: "atlas-cloud/fp8", name: "AtlasCloud", retention: NO_TRAINING_RETENTION },
  ])
})

test("included models exclude logged or unreviewed authors and anything within a week of expiry", () => {
  const now = fixture.capturedAt
  const included = fixture.models.filter((item: typeof cohere) => includedFreeModel(item, now))
  expect(included.map((item: { id: string }) => item.id).sort()).toEqual([
    "cohere/north-mini-code:free",
    "dots-studio/dots-3-note-preview:free",
  ])
  // Dots3-Note Preview is listed as free until 31 December 2026.
  const dots = metadata("dots-studio/dots-3-note-preview:free")
  expect(includedFreeModel(dots, Date.parse("2026-12-23T23:00:00Z"))).toBe(true)
  expect(includedFreeModel(dots, Date.parse("2026-12-24T00:00:00Z"))).toBe(false)
  expect(includedFreeModel({ ...cohere, id: "google/north-mini-code:free" }, now)).toBe(false)
})

test("eligible free models need an explicit free ID, zero prices, tools and an unexpired listing", () => {
  const now = Date.UTC(2026, 9, 2)
  const free = { ...cohere, pricing: { prompt: "0", completion: "0", request: "0", image: "0" } }
  expect(eligibleFreeModel(free, now)).toBe(true)
  for (const id of ["cohere/not-free", "openrouter/auto:free", "cohere/model:online:free", "cohere/trailing:free\n"])
    expect(eligibleFreeModel({ ...free, id }, now)).toBe(false)
  for (const change of [
    { expiration_date: "2026-10-01" },
    { expiration_date: "unknown" },
    { supported_parameters: [] },
    { supported_parameters: ["tools"] },
  ])
    expect(eligibleFreeModel({ ...free, ...change }, now)).toBe(false)
  for (const field of [
    "prompt",
    "completion",
    "request",
    "image",
    "web_search",
    "internal_reasoning",
    "input_cache_read",
  ])
    expect(eligibleFreeModel({ ...free, pricing: { ...free.pricing, [field]: "0.01" } }, now)).toBe(false)
  for (const price of ["", "unknown", "NaN", "-1"])
    expect(eligibleFreeModel({ ...free, pricing: { ...free.pricing, request: price } }, now)).toBe(false)
})
