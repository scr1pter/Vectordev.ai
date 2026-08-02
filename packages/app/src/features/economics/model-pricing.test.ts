import { describe, expect, test } from "bun:test"
import { estimatePromptCost, findModelPricing } from "./model-pricing"

describe("findModelPricing", () => {
  test("resolves known models by substring", () => {
    expect(findModelPricing("claude-sonnet-5")?.label).toBe("Claude Sonnet 5")
    expect(findModelPricing("claude-opus-4-8")?.label).toContain("Opus")
    expect(findModelPricing("claude-haiku-4-5")?.label).toContain("Haiku")
    expect(findModelPricing("gpt-4o")?.label).toBe("GPT-4o")
    expect(findModelPricing("o3")?.label).toContain("o3")
    expect(findModelPricing("gemini-2.5-pro")?.label).toContain("Pro")
    expect(findModelPricing("gemini-2.5-flash")?.label).toContain("Flash")
    expect(findModelPricing("deepseek-chat")?.label).toContain("DeepSeek")
  })

  test("matches case-insensitively and ignores surrounding whitespace", () => {
    expect(findModelPricing("  CLAUDE-OPUS-4-8  ")?.label).toContain("Opus")
  })

  test("more specific ids are not shadowed by the substring they contain", () => {
    // "gpt-4o-mini" contains "gpt-4o" as a substring — the mini entry must
    // still win because it's checked first.
    const mini = findModelPricing("gpt-4o-mini-2024-07-18")
    expect(mini?.label).toBe("GPT-4o mini")
    expect(mini?.inputPer1M).toBe(0.15)
    expect(mini?.outputPer1M).toBe(0.6)

    const full = findModelPricing("gpt-4o-2024-08-06")
    expect(full?.label).toBe("GPT-4o")
  })

  test("returns undefined for an unknown model — never guess a price", () => {
    expect(findModelPricing("some-unreleased-model-x")).toBeUndefined()
    expect(findModelPricing("")).toBeUndefined()
  })

  test("every priced entry carries an as-of date", () => {
    for (const model of ["claude-sonnet-5", "gpt-4o", "o3", "gemini-2.5-pro", "gemini-2.5-flash", "deepseek-chat"]) {
      expect(findModelPricing(model)?.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})

describe("estimatePromptCost", () => {
  test("computes input and output cost from real per-1M prices", () => {
    const estimate = estimatePromptCost("claude-sonnet-5", 4000, 1000)
    expect(estimate).toBeDefined()
    expect(estimate?.estimatedInputTokens).toBe(1000) // 4000 chars / 4 chars-per-token
    expect(estimate?.estimatedInputCost).toBeCloseTo((1000 / 1_000_000) * 3, 6)
    expect(estimate?.estimatedOutputCost).toBeCloseTo((1000 / 1_000_000) * 15, 6)
    expect(estimate?.estimatedTotalCost).toBeCloseTo(estimate!.estimatedInputCost + estimate!.estimatedOutputCost, 6)
  })

  test("falls back to the default assumed output length when omitted", () => {
    const estimate = estimatePromptCost("gpt-4o-mini", 400)
    expect(estimate?.assumedOutputTokens).toBeGreaterThan(0)
  })

  test("returns undefined for unknown models instead of guessing a cost", () => {
    expect(estimatePromptCost("totally-made-up-model", 4000)).toBeUndefined()
  })
})
