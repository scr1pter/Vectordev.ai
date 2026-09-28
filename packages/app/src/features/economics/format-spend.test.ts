import { describe, expect, test } from "bun:test"
import {
  SPEND_TOOLTIP,
  capTooltip,
  effectiveSpendKind,
  formatSpend,
  formatUsd,
  lastAssistantModel,
  spendKind,
  spendPill,
  type SpendCatalog,
} from "./format-spend"

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

  test("money a session spent before switching to a free model still shows", () => {
    expect(formatSpend({ usd: 3.4, tokens: 1000, kind: "free" })).toBe("$3.40")
    expect(formatSpend({ usd: 1.2, tokens: 1000, kind: "free" })).toBe("$1.20")
  })

  test("an untouched session reads $0.00", () => {
    expect(formatSpend({ usd: 0, tokens: 0, kind: "priced" })).toBe("$0.00")
  })
})

describe("effectiveSpendKind", () => {
  test("the tooltip kind follows the label", () => {
    const priced = { usd: 0, tokens: 45_000, kind: "priced" as const }
    expect(formatSpend(priced)).toBe("unpriced")
    expect(effectiveSpendKind(priced)).toBe("unpriced")
    expect(SPEND_TOOLTIP[effectiveSpendKind(priced)]).not.toContain("Billed to your own provider key.")
    expect(effectiveSpendKind({ usd: 3.4, tokens: 1000, kind: "free" })).toBe("priced")
    expect(effectiveSpendKind({ usd: 0, tokens: 1000, kind: "free" })).toBe("free")
    expect(effectiveSpendKind({ usd: 1, tokens: 1000, kind: "priced" })).toBe("priced")
  })
})

describe("spendPill", () => {
  const run = (spentUsd: number, state: "ok" | "warn" | "stopped" = "ok") => ({ spentUsd, capUsd: 5, state })

  test("a capped run shows the guard's per-run figure, not the session's lifetime cost", () => {
    const pill = spendPill({ usd: 12, tokens: 90_000, kind: "priced", run: run(0.8), running: true })
    expect(pill.label).toBe("$0.80 of $5.00")
    expect(pill.session).toBe("$12.00")
    expect(pill.run).toBe("$0.80 of $5.00")
    expect(pill.capUsd).toBe(5)
    expect(pill.warn).toBe(false)
  })

  test("the warn state turns the pill amber", () => {
    expect(spendPill({ usd: 4.1, tokens: 900, kind: "priced", run: run(4.1, "warn"), running: true }).warn).toBe(true)
  })

  test("a finished run drops the cap and the amber", () => {
    const pill = spendPill({ usd: 4.1, tokens: 900, kind: "priced", run: run(4.1, "warn"), running: false })
    expect(pill.label).toBe("$4.10")
    expect(pill.warn).toBe(false)
    expect(pill.capUsd).toBeUndefined()
  })

  test("no cap follows free or unpriced when the run spent nothing", () => {
    expect(spendPill({ usd: 0, tokens: 900, kind: "free", run: run(0), running: true }).label).toBe("free")
    expect(spendPill({ usd: 0, tokens: 900, kind: "unpriced", run: run(0), running: true }).label).toBe("unpriced")
  })

  test("with no reading or no cap the pill shows the session total", () => {
    expect(spendPill({ usd: 1.5, tokens: 900, kind: "priced", run: undefined, running: true }).label).toBe("$1.50")
    expect(
      spendPill({ usd: 1.5, tokens: 900, kind: "priced", run: { spentUsd: 1, state: "ok" }, running: true }).label,
    ).toBe("$1.50")
  })

  test("a subagent reads its root's run, which counts every session in it", () => {
    // The child spent $1.10 itself; the root's run is at $5.02 across all its subagents.
    expect(spendPill({ usd: 1.1, tokens: 900, kind: "priced", run: run(5.02, "warn"), running: true }).label).toBe(
      "$5.02 of $5.00",
    )
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
