import { describe, expect, test } from "bun:test"
import { capTooltip, formatSpend, formatUsd, lastAssistantModel, spendKind, type SpendCatalog } from "./format-spend"

const rates = (input: number, output: number) => ({ input, output, cache: { read: 0, write: 0 } })

const catalog: SpendCatalog = new Map([
  [
    "anthropic",
    {
      models: {
        "claude-sonnet": { cost: rates(3, 15) },
        "claude-custom": { cost: rates(0, 0) },
      },
    },
  ],
  [
    "openrouter",
    {
      models: {
        "qwen/coder:free": { cost: rates(0, 0) },
      },
    },
  ],
  ["vector", { models: { "big-pickle": { cost: rates(1, 2), freeModel: { source: "shared" } } } }],
])

describe("spendKind", () => {
  test("a listed price is priced", () => {
    expect(spendKind(catalog, "anthropic", "claude-sonnet")).toBe("priced")
  })

  test("all-zero rates or a missing model are unpriced", () => {
    expect(spendKind(catalog, "anthropic", "claude-custom")).toBe("unpriced")
    expect(spendKind(catalog, "anthropic", "missing")).toBe("unpriced")
    expect(spendKind(undefined, "anthropic", "claude-sonnet")).toBe("unpriced")
  })

  test("free models are free, whether marked or named :free at zero cost", () => {
    expect(spendKind(catalog, "openrouter", "qwen/coder:free")).toBe("free")
    expect(spendKind(catalog, "vector", "big-pickle")).toBe("free")
  })
})

describe("formatSpend", () => {
  test("free models read free", () => {
    expect(formatSpend({ usd: 0, tokens: 45_000, kind: "free" })).toBe("free")
  })

  test("tokens on an unpriced model read unpriced, never $0.00", () => {
    expect(formatSpend({ usd: 0, tokens: 45_000, kind: "unpriced" })).toBe("unpriced")
    expect(formatSpend({ usd: undefined, tokens: 1, kind: "unpriced" })).toBe("unpriced")
  })

  test("a priced amount below a cent reads <$0.01, never $0.00", () => {
    expect(formatSpend({ usd: 0.004, tokens: 900, kind: "priced" })).toBe("<$0.01")
    expect(formatSpend({ usd: 0.0001, tokens: 12, kind: "priced" })).not.toBe("$0.00")
  })

  test("priced tokens that reported no dollars are unpriced, not free", () => {
    expect(formatSpend({ usd: 0, tokens: 500, kind: "priced" })).toBe("unpriced")
  })

  test("money uses two decimals, including large values", () => {
    expect(formatSpend({ usd: 1.234, tokens: 10, kind: "priced" })).toBe("$1.23")
    expect(formatSpend({ usd: 1234.567, tokens: 10, kind: "priced" })).toBe("$1,234.57")
  })

  test("an untouched session reads $0.00", () => {
    expect(formatSpend({ usd: 0, tokens: 0, kind: "priced" })).toBe("$0.00")
  })
})

describe("formatUsd and cap copy", () => {
  test("caps print with two decimals", () => {
    expect(formatUsd(5)).toBe("$5.00")
    expect(capTooltip(5)).toBe("This run is capped at $5.00. Vector stops within one step of the cap.")
  })
})

describe("lastAssistantModel", () => {
  test("uses the latest assistant reply", () => {
    expect(
      lastAssistantModel([
        { role: "assistant", providerID: "anthropic", modelID: "a" },
        { role: "user" },
        { role: "assistant", providerID: "openrouter", modelID: "b" },
        { role: "user" },
      ]),
    ).toEqual({ providerID: "openrouter", modelID: "b" })
    expect(lastAssistantModel([{ role: "user" }])).toBeUndefined()
  })
})
