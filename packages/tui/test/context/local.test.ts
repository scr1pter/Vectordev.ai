import { expect, test } from "bun:test"
import { parseModel, recentModels } from "../../src/context/local"

test("parses model IDs containing slashes", () => {
  expect(parseModel("provider/family/model")).toEqual({
    providerID: "provider",
    modelID: "family/model",
  })
})

test("moves a model to the front, deduplicates, and limits recents", () => {
  const recent = Array.from({ length: 12 }, (_, index) => ({
    providerID: "provider",
    modelID: `model-${index}`,
  }))

  expect(recentModels({ providerID: "provider", modelID: "model-5" }, recent)).toEqual([
    { providerID: "provider", modelID: "model-5" },
    ...recent.slice(0, 5),
    ...recent.slice(6, 10),
  ])
})

test("model fallback notices include slash-containing saved IDs and ignore stale lower-priority recents", async () => {
  const { unavailableModel, providerNoticeTracker } = await import("@vectordevai/schema/provider-unavailable")
  const missing = parseModel("missing/family/saved")
  const live = parseModel("anthropic/claude-sonnet-4")
  const valid = (model: { providerID: string }) => model.providerID === "anthropic"
  expect(unavailableModel([missing, live], valid)).toEqual({ providerID: "missing", modelID: "family/saved" })
  expect(unavailableModel([live, missing], valid)).toBeUndefined()
  const take = providerNoticeTracker()
  expect(take("server", "missing/family/saved")).toBe(true)
  expect(take("server", "missing/family/saved")).toBe(false)
})
