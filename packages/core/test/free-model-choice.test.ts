import { describe, expect, test } from "bun:test"
import {
  freeModelName,
  freeModelSource,
  preferOwnFreeModels,
  freeModelsLimitNotice,
  freeModelsLimitTitle,
  freeModelsResetLabel,
} from "../src/free-model-choice"

describe("free model presentation", () => {
  const shared = { id: "maker/coder:free", name: "Maker Coder:free", freeModel: { source: "shared" as const } }
  const own = { ...shared, freeModel: { source: "openrouter" as const } }
  test("uses the user's account for duplicate curated models without changing routing IDs", () => {
    expect(preferOwnFreeModels([shared, own])).toEqual([own])
    expect(preferOwnFreeModels([own, shared])).toEqual([own])
    expect(freeModelName(own)).toBe("Maker Coder")
    expect(own.id).toBe("maker/coder:free")
    expect(freeModelSource(own)).toBe("Your OpenRouter account")
    expect(freeModelSource(shared)).toBe("Shared Vector allowance")
  })
  test("price and free-looking names cannot enable the section when metadata is absent", () => {
    const ordinary = { id: shared.id, name: "Maker Coder (free)", cost: { input: 0, output: 0 } }
    expect(freeModelSource(ordinary)).toBeUndefined()
    expect(preferOwnFreeModels([ordinary])).toEqual([ordinary])
    expect(freeModelName(ordinary)).toBe("Maker Coder")
  })
})

test("quota notices accept only typed limits and never repeat upstream text", () => {
  const data = { reason: "user_daily", resetAt: 1893542400000, message: "private upstream details" }
  const limit = freeModelsLimitNotice({ name: "FreeModelsLimitError", data })!
  expect(freeModelsLimitTitle(limit)).toBe("You've used today's shared free models inside of Vector")
  expect(freeModelsResetLabel(limit, "en-US")).toContain("2030")
  expect(freeModelsLimitNotice({ _tag: "FreeModelsLimitError", ...data })).toEqual(limit)
  expect(freeModelsLimitNotice({ type: "free_models_limit", code: "VECTOR_FREE_MODELS_LIMIT", ...data })).toEqual(limit)
  expect(freeModelsLimitNotice({ type: "free_models_limit", code: "unknown", ...data })).toBeUndefined()
  expect(freeModelsLimitNotice({ name: "APIError", data })).toBeUndefined()
  expect(freeModelsLimitNotice({ name: "FreeModelsLimitError", data: { ...data, resetAt: NaN } })).toBeUndefined()
  expect(freeModelsLimitNotice({ name: "FreeModelsLimitError", data: { ...data, reason: "unknown" } })).toBeUndefined()
})
