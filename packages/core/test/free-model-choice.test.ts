import { describe, expect, test } from "bun:test"
import {
  FREE_MODEL_TRAINING_DISCLAIMER,
  FREE_MODEL_TRAINING_LABEL,
  FREE_MODELS_DATA_POLICY,
  FREE_MODELS_TITLE,
  freeModelMayTrain,
  freeModelTrainingDisclaimer,
  freeModelTrainingLabel,
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
  expect(freeModelsLimitTitle(limit)).toBe("You've used today's shared allowance for Free models inside of Vector")
  expect(freeModelsResetLabel(limit, "en-US")).toContain("2030")
  expect(freeModelsLimitNotice({ _tag: "FreeModelsLimitError", ...data })).toEqual(limit)
  expect(freeModelsLimitNotice({ type: "free_models_limit", code: "VECTOR_FREE_MODELS_LIMIT", ...data })).toEqual(limit)
  expect(freeModelsLimitNotice({ type: "free_models_limit", code: "unknown", ...data })).toBeUndefined()
  expect(freeModelsLimitNotice({ name: "APIError", data })).toBeUndefined()
  expect(freeModelsLimitNotice({ name: "FreeModelsLimitError", data: { ...data, resetAt: NaN } })).toBeUndefined()
  expect(freeModelsLimitNotice({ name: "FreeModelsLimitError", data: { ...data, reason: "unknown" } })).toBeUndefined()
})

test("the section is branded Free models inside of Vector", () => {
  expect(FREE_MODELS_TITLE).toBe("Free models inside of Vector")
  // Owner rule: the no-training copy never claims zero data retention or absolute privacy.
  expect(FREE_MODELS_DATA_POLICY).toContain("Not zero data retention")
  expect(`${FREE_MODELS_DATA_POLICY} ${FREE_MODEL_TRAINING_DISCLAIMER}`).not.toMatch(
    /absolute privacy|exactly|never exceeds/i,
  )
})

test('may-train and unreviewed free models carry "May train on your prompts"; no-training and paid ones do not', () => {
  const free = (dataPolicy?: "no-training" | "may-train" | "unreviewed") => ({
    freeModel: { source: "shared" as const, dataPolicy },
  })
  expect(FREE_MODEL_TRAINING_LABEL).toBe("May train on your prompts")
  expect(freeModelTrainingLabel(free("may-train"))).toBe("May train on your prompts")
  expect(freeModelTrainingLabel(free("unreviewed"))).toBe("May train on your prompts")
  expect(freeModelTrainingLabel(free("no-training"))).toBeUndefined()
  expect(freeModelTrainingLabel({})).toBeUndefined()
  expect(freeModelMayTrain(free("unreviewed"))).toBe(true)
  expect(freeModelTrainingDisclaimer(free("may-train"))).toBe(FREE_MODEL_TRAINING_DISCLAIMER)
  expect(FREE_MODEL_TRAINING_DISCLAIMER).toContain("Vector itself never trains on your prompts.")
  expect(freeModelTrainingDisclaimer(free("unreviewed"))).toContain("has not reviewed")
  expect(freeModelTrainingDisclaimer(free("no-training"))).toBeUndefined()
})
