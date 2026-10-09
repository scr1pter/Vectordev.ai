import { describe, expect, test } from "bun:test"
import { bestOwnFreeModel } from "./free-model"

const model = (id: string, context: number, source?: "openrouter" | "shared") => ({
  id,
  limit: { context },
  ...(source ? { freeModel: { source } } : {}),
})

describe("bestOwnFreeModel", () => {
  test("picks the largest-context model from the user's own OpenRouter account", () => {
    expect(
      bestOwnFreeModel([
        model("maker/coder:free", 128_000, "openrouter"),
        model("maker/big:free", 256_000, "openrouter"),
        model("maker/small:free", 32_000, "openrouter"),
      ])?.id,
    ).toBe("maker/big:free")
  })

  test("never picks a paid or shared model, even with a larger context window", () => {
    expect(
      bestOwnFreeModel([
        model("maker/paid", 1_000_000),
        model("maker/huge:free", 900_000),
        model("vector/shared:free", 800_000, "shared"),
        model("maker/coder:free", 128_000, "openrouter"),
      ])?.id,
    ).toBe("maker/coder:free")
  })

  test("returns nothing when the account offers no eligible free model", () => {
    expect(bestOwnFreeModel([model("maker/paid", 1_000_000), model("maker/huge:free", 900_000)])).toBeUndefined()
    expect(bestOwnFreeModel([])).toBeUndefined()
  })
})
