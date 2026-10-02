import { expect, test } from "bun:test"
import { FreeModelsLimitError, isFreeModel, parseFreeModelLimit, type FreeModelLimit } from "../src/free-model"

const limit: FreeModelLimit = {
  type: "free_models_limit",
  code: "VECTOR_FREE_MODELS_LIMIT",
  reason: "user_daily",
  resetAt: 1900000000000,
  message: "The free allowance resets later.",
}

test("free-model limit reset times are finite in HTTP and stored error shapes", () => {
  expect(parseFreeModelLimit(JSON.stringify({ error: limit }))).toEqual(limit)
  for (const resetAt of [NaN, Infinity, -Infinity, "NaN", "Infinity", null])
    expect(parseFreeModelLimit({ error: { ...limit, resetAt } })).toBeUndefined()
  expect(() => new FreeModelsLimitError({ reason: "upstream", resetAt: Infinity, message: "Invalid reset" })).toThrow()
})

test("free-model auxiliary routing recognizes every accepted suffix case", () => {
  for (const suffix of ["free", "FREE", "Free"]) {
    expect(isFreeModel({ providerID: "openrouter", id: `maker/model:${suffix}`, cost: { input: 0, output: 0 } })).toBe(
      true,
    )
    expect(isFreeModel({ providerID: "openrouter", id: `maker/model:${suffix}`, cost: { input: 1, output: 0 } })).toBe(
      false,
    )
  }
})
