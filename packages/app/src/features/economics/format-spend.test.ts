import { describe, expect, test } from "bun:test"
import {
  SPEND_TOOLTIP,
  capTooltip,
  formatUsd,
  lastAssistantModel,
  sessionReading,
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

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
const t = (key: "session.cost.unknown" | "session.cost.partial", params: { cost: string }) =>
  key === "session.cost.unknown" ? "Cost unknown" : `${params.cost} + unpriced`
const read = (input: { cost: number; unpricedSteps?: number; tokens: number; kind: "free" | "unpriced" | "priced" }) =>
  sessionReading({ unpricedSteps: 0, ...input, format: (value) => usd.format(value), t })

describe("sessionReading", () => {
  test("a session that spent nothing on a free model reads free", () => {
    expect(read({ cost: 0, tokens: 45_000, kind: "free" })).toEqual({ label: "free", kind: "free" })
  })

  test("tokens on a model with no price read cost unknown, never $0.00", () => {
    expect(read({ cost: 0, tokens: 45_000, kind: "unpriced" })).toEqual({ label: "Cost unknown", kind: "unpriced" })
    expect(read({ cost: 0, tokens: 1, kind: "unpriced" }).label).toBe("Cost unknown")
  })

  test("priced tokens that reported no dollars are unknown, not free", () => {
    expect(read({ cost: 0, tokens: 500, kind: "priced" })).toEqual({ label: "Cost unknown", kind: "unpriced" })
  })

  test("the backend's unpriced steps decide before the catalog does", () => {
    expect(read({ cost: 0, unpricedSteps: 2, tokens: 500, kind: "free" })).toEqual({
      label: "Cost unknown",
      kind: "unpriced",
    })
    expect(read({ cost: 1.5, unpricedSteps: 2, tokens: 500, kind: "priced" })).toEqual({
      label: "$1.50 + unpriced",
      kind: "priced",
    })
  })

  test("money a session spent before switching to a free model still shows", () => {
    expect(read({ cost: 3.4, tokens: 1000, kind: "free" })).toEqual({ label: "$3.40", kind: "priced" })
  })

  test("an untouched session reads $0.00", () => {
    expect(read({ cost: 0, tokens: 0, kind: "priced" })).toEqual({ label: "$0.00", kind: "priced" })
  })

  test("the tooltip for tokens nothing priced never says the key was billed", () => {
    expect(SPEND_TOOLTIP[read({ cost: 0, tokens: 45_000, kind: "priced" }).kind]).toBe(SPEND_TOOLTIP.unpriced)
  })
})

describe("spendPill", () => {
  const run = (spentUsd: number, state: "ok" | "warn" | "stopped" = "ok") => ({ spentUsd, capUsd: 5, state })
  const priced = (label: string) => ({ label, kind: "priced" as const })

  test("a capped run shows the guard's per-run figure, not the session's lifetime cost", () => {
    const pill = spendPill({ session: priced("$12.00"), run: run(0.8), running: true })
    expect(pill.label).toBe("$0.80 of $5.00")
    expect(pill.session).toBe("$12.00")
    expect(pill.run).toBe("$0.80 of $5.00")
    expect(pill.capUsd).toBe(5)
    expect(pill.warn).toBe(false)
  })

  test("the warn state turns the pill amber", () => {
    expect(spendPill({ session: priced("$4.10"), run: run(4.1, "warn"), running: true }).warn).toBe(true)
  })

  test("a finished run drops the cap and the amber", () => {
    const pill = spendPill({ session: priced("$4.10"), run: run(4.1, "warn"), running: false })
    expect(pill.label).toBe("$4.10")
    expect(pill.warn).toBe(false)
    expect(pill.capUsd).toBeUndefined()
  })

  test("no cap follows free or cost unknown when the run spent nothing", () => {
    expect(spendPill({ session: { label: "free", kind: "free" }, run: run(0), running: true }).label).toBe("free")
    expect(
      spendPill({ session: { label: "Cost unknown", kind: "unpriced" }, run: run(0), running: true }).label,
    ).toBe("Cost unknown")
  })

  test("with no reading or no cap the pill shows the session total", () => {
    expect(spendPill({ session: priced("$1.50"), run: undefined, running: true }).label).toBe("$1.50")
    expect(spendPill({ session: priced("$1.50"), run: { spentUsd: 1, state: "ok" }, running: true }).label).toBe(
      "$1.50",
    )
  })

  test("a subagent reads its root's run, which counts every session in it", () => {
    // The child spent $1.10 itself; the root's run is at $5.02 across all its subagents.
    expect(spendPill({ session: priced("$1.10"), run: run(5.02, "warn"), running: true }).label).toBe(
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
