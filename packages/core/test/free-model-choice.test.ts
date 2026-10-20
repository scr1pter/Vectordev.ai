import { describe, expect, test } from "bun:test"
import {
  FREE_MODEL_TRAINING_OWNER_ONLY,
  freeModelTrainingRefusal,
  FREE_MODEL_TRAINING_DISCLAIMER,
  FREE_MODEL_TRAINING_LABEL,
  FREE_MODELS_DATA_POLICY,
  FREE_MODELS_TITLE,
  freeModelMayTrain,
  freeModelTrainingDisclaimer,
  freeModelTrainingLabel,
  freeModelName,
  freeModelSource,
  freeModelChoices,
  freeModelTrainingNotice,
  FREE_MODEL_RESUME_UNAVAILABLE,
  FREE_ROUTER_DISCLAIMER,
  FREE_MODELS_OWN_KEYS,
  FREE_MODELS_OWN_KEYS_TERMINAL,
  FREE_MODELS_SHARED_COPY,
  FREE_MODELS_SIGN_IN,
  FREE_MODELS_UNAVAILABLE,
  freeModelsLimitMessage,
  freeModelsLimitNotice,
  freeModelsLimitTitle,
  freeModelsResetLabel,
} from "../src/free-model-choice"

describe("free model presentation", () => {
  const shared = { id: "maker/coder:free", name: "Maker Coder:free", freeModel: { source: "shared" as const } }
  const own = { ...shared, freeModel: { source: "openrouter" as const } }
  test("lists both copies of a model, the shared one first, without changing routing IDs", () => {
    // A connected OpenRouter account no longer hides the shared copy: choosing it keeps the shared allowance.
    expect(freeModelChoices([shared, own])).toEqual([shared, own])
    expect(freeModelChoices([own, shared])).toEqual([shared, own])
    const paid = { id: "maker/paid", name: "Maker Paid" }
    expect(freeModelChoices([own, paid, shared])).toEqual([paid, shared, own])
    expect(freeModelName(own)).toBe("Maker Coder")
    expect(own.id).toBe("maker/coder:free")
    expect(freeModelSource(own)).toBe("Your OpenRouter account")
    expect(freeModelSource(shared)).toBe("Provided by Vector")
  })
  test("price and free-looking names cannot enable the section when metadata is absent", () => {
    const ordinary = { id: shared.id, name: "Maker Coder (free)", cost: { input: 0, output: 0 } }
    expect(freeModelSource(ordinary)).toBeUndefined()
    expect(freeModelChoices([ordinary])).toEqual([ordinary])
    expect(freeModelName(ordinary)).toBe("Maker Coder")
  })
})

test("quota notices accept only typed limits and never repeat upstream text", () => {
  const data = { reason: "user_daily", resetAt: 1893542400000, message: "private upstream details" }
  const limit = freeModelsLimitNotice({ name: "FreeModelsLimitError", data })!
  expect(freeModelsLimitTitle(limit)).toBe("You've reached today's limit for Free models inside of Vector")
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
  expect(FREE_MODELS_DATA_POLICY).toContain("Vector doesn't request zero data retention for these models")
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

test("an invited guest whose acceptance the engine refuses is told only the owner can use these models", () => {
  // The engine answers 403 to a guest's acceptance, so "try again" could never work for a guest.
  expect(freeModelTrainingRefusal(403)).toBe(FREE_MODEL_TRAINING_OWNER_ONLY)
  expect(FREE_MODEL_TRAINING_OWNER_ONLY).toContain('"May train on your prompts"')
  expect(FREE_MODEL_TRAINING_OWNER_ONLY).toContain("workspace owner")
  for (const status of [500, 503, undefined]) expect(freeModelTrainingRefusal(status)).toContain("Try again")
})

test("limit notices say when free models provided by Vector are available again and offer the user's own keys, never an OpenRouter account", () => {
  const limit = { reason: "user_daily" as const, resetAt: Date.UTC(2030, 0, 1, 12) }
  const desktop = freeModelsLimitMessage(limit, { locale: "en-US" })
  expect(desktop).toStartWith(
    `${freeModelsLimitTitle(limit)}. They are expected to be available again at`,
  )
  expect(desktop).toContain(freeModelsResetLabel(limit, "en-US"))
  expect(desktop).toEndWith(FREE_MODELS_OWN_KEYS)
  expect(freeModelsLimitMessage(limit, { terminal: true })).toEndWith(FREE_MODELS_OWN_KEYS_TERMINAL)
  for (const text of [
    desktop,
    FREE_MODELS_OWN_KEYS,
    FREE_MODELS_OWN_KEYS_TERMINAL,
    FREE_MODELS_SIGN_IN,
    FREE_MODELS_SHARED_COPY,
    FREE_MODELS_UNAVAILABLE,
    FREE_MODEL_RESUME_UNAVAILABLE,
  ])
    expect(text).not.toMatch(/connect (?:your own )?(?:free )?openrouter|own (?:free )?openrouter account/i)
  expect(FREE_MODELS_SIGN_IN).toBe("Sign in to Vector to use free models.")
})

test("OpenRouter's free router carries its own notice, which says the model is picked at random", () => {
  const router = { id: "openrouter/free", freeModel: { source: "shared" as const, dataPolicy: "may-train" as const } }
  expect(freeModelTrainingLabel(router)).toBe(FREE_MODEL_TRAINING_LABEL)
  expect(freeModelTrainingDisclaimer(router)).toBe(FREE_ROUTER_DISCLAIMER)
  expect(FREE_ROUTER_DISCLAIMER).toContain("at random")
  expect(FREE_ROUTER_DISCLAIMER).toContain("Vector itself never trains on your prompts")
  expect(freeModelTrainingDisclaimer({ ...router, id: "poolside/laguna-s-2.1:free" })).toBe(
    FREE_MODEL_TRAINING_DISCLAIMER,
  )
})

test("the in-use notice names the source and label of a model that may train, and nothing for one that does not", () => {
  const laguna = {
    id: "poolside/laguna-s-2.1:free",
    freeModel: { source: "shared" as const, dataPolicy: "may-train" as const },
  }
  expect(freeModelTrainingNotice(laguna)).toEqual({
    summary: "Provided by Vector · May train on your prompts",
    disclaimer: FREE_MODEL_TRAINING_DISCLAIMER,
  })
  expect(
    freeModelTrainingNotice({ ...laguna, freeModel: { source: "openrouter", dataPolicy: "unreviewed" } })?.summary,
  ).toBe("Your OpenRouter account · May train on your prompts")
  expect(freeModelTrainingNotice({ id: "openrouter/free", freeModel: laguna.freeModel })?.disclaimer).toBe(
    FREE_ROUTER_DISCLAIMER,
  )
  expect(freeModelTrainingNotice({ ...laguna, freeModel: { source: "shared", dataPolicy: "no-training" } })).toBe(
    undefined,
  )
  expect(freeModelTrainingNotice({ id: "maker/paid" })).toBeUndefined()
})
