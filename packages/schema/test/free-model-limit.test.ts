import { expect, test } from "bun:test"
import { FreeModelsLimitError, parseFreeModelLimit, type FreeModelLimit } from "../src/free-model"

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
