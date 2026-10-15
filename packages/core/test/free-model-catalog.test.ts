import { expect, test } from "bun:test"
import { NO_TRAINING_RETENTION } from "@vectordevai/schema/free-model"
import { NO_TRAINING_PROVIDERS, freeModelInfo, includedFreeModel } from "../src/free-model-catalog"

const fixture = await Bun.file(new URL("./fixture/free-model-public.json", import.meta.url)).json()
const metadata = (id: string) => fixture.models.find((item: { id: string }) => item.id === id)
const cohere = metadata("cohere/north-mini-code:free")
const [endpoint] = fixture.endpoints["cohere/north-mini-code:free"]

test("no-training mode accepts a reviewed free endpoint and never claims zero data retention", () => {
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

test("no-training mode keeps only reviewed providers; Poolside's free endpoints may train on inputs", () => {
  expect([...NO_TRAINING_PROVIDERS].sort()).toEqual(["atlas-cloud", "cohere", "modelrun", "novita"])
  for (const id of ["poolside/laguna-s-2.1:free", "poolside/laguna-xs-2.1:free"]) {
    expect(freeModelInfo(metadata(id), fixture.endpoints[id], { noTraining: true })).toBeUndefined()
    // The model itself still passes every other check today.
    expect(includedFreeModel(metadata(id), fixture.capturedAt)).toBe(true)
  }
  const unknown = { ...endpoint, provider_name: "Unknown", tag: "unknown/fp8" }
  expect(freeModelInfo(cohere, [unknown], { noTraining: true })).toBeUndefined()
  const atlas = freeModelInfo(
    metadata("dots-studio/dots-3-note-preview:free"),
    fixture.endpoints["dots-studio/dots-3-note-preview:free"],
    { noTraining: true },
  )
  expect(atlas?.providers).toEqual([{ id: "atlas-cloud/fp8", name: "AtlasCloud", retention: NO_TRAINING_RETENTION }])
})

test("included models exclude logged or unreviewed authors and anything within a week of expiry", () => {
  const now = fixture.capturedAt
  const included = fixture.models.filter((item: typeof cohere) => includedFreeModel(item, now))
  expect(included.map((item: { id: string }) => item.id).sort()).toEqual([
    "cohere/north-mini-code:free",
    "dots-studio/dots-3-note-preview:free",
    "poolside/laguna-s-2.1:free",
    "poolside/laguna-xs-2.1:free",
  ])
  const laguna = metadata("poolside/laguna-s-2.1:free")
  expect(includedFreeModel(laguna, Date.parse("2026-10-23T23:00:00Z"))).toBe(true)
  expect(includedFreeModel(laguna, Date.parse("2026-10-24T00:00:00Z"))).toBe(false)
})
