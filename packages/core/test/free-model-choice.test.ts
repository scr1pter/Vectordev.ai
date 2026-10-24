import { describe, expect, test } from "bun:test"
import {
  FREE_MODEL_TRAINING_OWNER_ONLY,
  freeModelTrainingRefusal,
  FREE_MODEL_TRAINING_DISCLAIMER,
  FREE_MODEL_TRAINING_LABEL,
  FREE_MODELS_DATA_POLICY,
  FREE_MODELS_TITLE,
  freeModelCatalogName,
  freeModelMayTrain,
  freeModelTrainingLabel,
  freeModelName,
  freeModelSource,
  freeModelChoices,
  FREE_MODEL_RESUME_UNAVAILABLE,
  FREE_MODEL_TRAINING_CONSENT_REQUIRED,
  FREE_MODEL_TRAINING_REFUSED_TERMINAL,
  FREE_MODEL_UNLISTED,
  FREE_MODEL_UNREVIEWED_BLOCKED,
  FREE_ROUTER_NAME,
  FREE_MODELS_OWN_KEYS,
  FREE_MODELS_OWN_KEYS_TERMINAL,
  FREE_MODELS_SHARED_COPY,
  FREE_MODELS_SIGN_IN,
  FREE_MODELS_UNAVAILABLE,
  freeModelsLimitMessage,
  freeModelsLimitNotice,
  freeModelsLimitTitle,
  freeModelsResetLabel,
  freeModelsResetSentence,
  freeModelsTokensRanOut,
  type FreeModelsLimitNotice,
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
  expect(freeModelsLimitTitle(limit)).toBe("You've run out of free tokens for today")
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
  // The acceptance question explains the label; nothing else repeats that paragraph.
  expect(FREE_MODEL_TRAINING_DISCLAIMER).toContain("Vector itself never trains on your prompts.")
  expect(FREE_MODEL_TRAINING_CONSENT_REQUIRED).toStartWith(FREE_MODEL_TRAINING_DISCLAIMER)
})

test("vector models names the label and the accept command under its list, with no disclaimer", () => {
  expect(FREE_MODEL_TRAINING_REFUSED_TERMINAL).toBe(
    'Prompts to models labelled "May train on your prompts" are refused until you run "vector models --accept-training".',
  )
  expect(FREE_MODEL_TRAINING_REFUSED_TERMINAL).not.toContain(FREE_MODEL_TRAINING_DISCLAIMER)
  expect(FREE_MODEL_TRAINING_REFUSED_TERMINAL).not.toMatch(/log your prompts|never trains|openrouter/i)
})

test("an invited guest whose acceptance the engine refuses is told only the owner can use these models", () => {
  // The engine answers 403 to a guest's acceptance, so "try again" could never work for a guest.
  expect(freeModelTrainingRefusal(403)).toBe(FREE_MODEL_TRAINING_OWNER_ONLY)
  expect(FREE_MODEL_TRAINING_OWNER_ONLY).toContain('"May train on your prompts"')
  expect(FREE_MODEL_TRAINING_OWNER_ONLY).toContain("workspace owner")
  for (const status of [500, 503, undefined]) expect(freeModelTrainingRefusal(status)).toContain("Try again")
})

test("limit notices say when more free tokens are available and offer the user's own keys, never an OpenRouter account", () => {
  const limit = { reason: "user_daily" as const, resetAt: Date.UTC(2030, 0, 1, 12) }
  const desktop = freeModelsLimitMessage(limit, { locale: "en-US" })
  expect(desktop).toStartWith(
    `You've run out of free tokens for today. More free tokens are available at ${freeModelsResetLabel(limit, "en-US")}.`,
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

test("the free router runs under Vector's own name, with the same label as every model that may train", () => {
  const router = {
    id: "openrouter/free",
    name: "Free Models Router",
    freeModel: { source: "shared" as const, dataPolicy: "may-train" as const },
  }
  expect(freeModelTrainingLabel(router)).toBe(FREE_MODEL_TRAINING_LABEL)
  expect(freeModelCatalogName(router)).toBe(FREE_ROUTER_NAME)
  expect(freeModelName(router)).toBe("Auto (free)")
  // The engine already names it, so a client that passes only the name keeps it whole.
  expect(freeModelName({ name: FREE_ROUTER_NAME })).toBe("Auto (free)")
})

test("catalog names lose OpenRouter's own prefix or suffix, and nothing else", () => {
  expect(freeModelCatalogName({ id: "maker/a:free", name: "OpenRouter: Maker A (free)" })).toBe("Maker A (free)")
  expect(freeModelCatalogName({ id: "maker/b:free", name: "Maker B (OpenRouter)" })).toBe("Maker B")
  expect(freeModelCatalogName({ id: "maker/c:free", name: "Poolside: Laguna S 2.1" })).toBe("Poolside: Laguna S 2.1")
  expect(freeModelName({ id: "maker/a:free", name: "openrouter: Maker A (free)" })).toBe("Maker A")
})

test("what Vector says about the included models never names OpenRouter", () => {
  for (const text of [
    FREE_MODELS_SHARED_COPY,
    FREE_MODELS_SIGN_IN,
    FREE_MODELS_UNAVAILABLE,
    FREE_MODELS_OWN_KEYS,
    FREE_MODELS_OWN_KEYS_TERMINAL,
    FREE_MODEL_TRAINING_DISCLAIMER,
    FREE_MODEL_TRAINING_CONSENT_REQUIRED,
    FREE_MODEL_TRAINING_OWNER_ONLY,
    FREE_MODEL_UNLISTED,
    FREE_MODEL_UNREVIEWED_BLOCKED,
    FREE_ROUTER_NAME,
    freeModelSource({ id: "maker/a:free", freeModel: { source: "shared" } }) ?? "",
    ...(["user_daily", "user_minute", "shared_daily", "upstream", "balance"] as const).map((reason) =>
      freeModelsLimitMessage({ reason, resetAt: Date.UTC(2030, 0, 1) }, { terminal: true }),
    ),
  ])
    expect(text).not.toMatch(/openrouter/i)
})

// Owner, 23 October 2026: nothing tells users free models are an allowance from Vector that they share with others.
test("the daily limits say free tokens ran out, the overall one without saying the user used them", () => {
  const notice = (reason: FreeModelsLimitNotice["reason"]) => ({ reason, resetAt: Date.UTC(2030, 0, 1, 12) })
  expect(freeModelsLimitTitle(notice("user_daily"))).toBe("You've run out of free tokens for today")
  expect(freeModelsLimitTitle(notice("shared_daily"))).toBe("Free tokens have run out for today")
  expect(freeModelsLimitTitle(notice("shared_daily"))).not.toMatch(/\byou/i)
  expect(freeModelsResetSentence(notice("shared_daily"), "en-US")).toBe(
    `More free tokens are available at ${freeModelsResetLabel(notice("shared_daily"), "en-US")}.`,
  )
  expect(freeModelsLimitMessage(notice("shared_daily"), { terminal: true })).toBe(
    `Free tokens have run out for today. ${freeModelsResetSentence(notice("shared_daily"))} ${FREE_MODELS_OWN_KEYS_TERMINAL}`,
  )
})

// Owner's wording review, 23 October 2026: only a daily limit means free tokens ran out.
test("a per-minute limit or an unavailable service says when to try again, never that more free tokens arrive", () => {
  for (const reason of ["user_minute", "upstream", "balance"] as const) {
    const limit = { reason, resetAt: Date.UTC(2030, 0, 1, 12) }
    expect(freeModelsTokensRanOut(limit)).toBe(false)
    expect(freeModelsResetSentence(limit, "en-US")).toBe(`Try again at ${freeModelsResetLabel(limit, "en-US")}.`)
    for (const text of [freeModelsLimitMessage(limit), freeModelsLimitMessage(limit, { terminal: true })]) {
      expect(text).toContain(`. Try again at ${freeModelsResetLabel(limit)}. `)
      expect(text).not.toMatch(/more free tokens|run out/i)
    }
  }
  for (const reason of ["user_daily", "shared_daily"] as const) {
    const limit = { reason, resetAt: Date.UTC(2030, 0, 1, 12) }
    expect(freeModelsTokensRanOut(limit)).toBe(true)
    expect(freeModelsResetSentence(limit)).toStartWith("More free tokens are available at ")
  }
})

test("no user-visible free-model string calls them an allowance, shared or pooled", async () => {
  // Every exported string is shown somewhere, so a new one is checked without being added here.
  const exported = Object.entries(await import("../src/free-model-choice")).flatMap(([name, value]) =>
    typeof value === "string" ? [{ name, text: value }] : [],
  )
  expect(exported.length).toBeGreaterThan(10)
  const reasons = ["user_daily", "user_minute", "shared_daily", "upstream", "balance"] as const
  const shown = [
    ...exported,
    ...reasons.flatMap((reason) => {
      const limit = { reason, resetAt: Date.UTC(2030, 0, 1) }
      return [
        { name: `title ${reason}`, text: freeModelsLimitTitle(limit) },
        { name: `message ${reason}`, text: freeModelsLimitMessage(limit) },
        { name: `terminal ${reason}`, text: freeModelsLimitMessage(limit, { terminal: true }) },
      ]
    }),
    { name: "source shared", text: freeModelSource({ id: "maker/a:free", freeModel: { source: "shared" } }) ?? "" },
    {
      name: "source openrouter",
      text: freeModelSource({ id: "maker/a:free", freeModel: { source: "openrouter" } }) ?? "",
    },
    { name: "refusal", text: freeModelTrainingRefusal(500) },
  ]
  expect(shown.filter((item) => /allowance|\bshared\b|\bpool(?:ed)?\b/i.test(item.text))).toEqual([])
})
