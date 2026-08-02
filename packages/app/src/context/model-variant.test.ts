import { describe, expect, test } from "bun:test"
import {
  cycleModelVariant,
  getConfiguredAgentVariant,
  modelVariantDescription,
  modelVariantLabel,
  normalizeModelVariant,
  resolveModelVariant,
  visibleModelVariants,
} from "./model-variant"

describe("model variant", () => {
  test("resolves configured agent variant when model matches", () => {
    const value = getConfiguredAgentVariant({
      agent: {
        model: { providerID: "openai", modelID: "gpt-5.2" },
        variant: "xhigh",
      },
      model: {
        providerID: "openai",
        modelID: "gpt-5.2",
        variants: { low: {}, high: {}, xhigh: {} },
      },
    })

    expect(value).toBe("xhigh")
  })

  test("ignores configured variant when model does not match", () => {
    const value = getConfiguredAgentVariant({
      agent: {
        model: { providerID: "openai", modelID: "gpt-5.2" },
        variant: "xhigh",
      },
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
        variants: { low: {}, high: {}, xhigh: {} },
      },
    })

    expect(value).toBeUndefined()
  })

  test("prefers selected variant over configured variant", () => {
    const value = resolveModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: "high",
      configured: "xhigh",
    })

    expect(value).toBe("high")
  })

  test("lets an explicit default override the configured variant", () => {
    const value = resolveModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: null,
      configured: "xhigh",
    })

    expect(value).toBeUndefined()
  })

  test("cycles from configured variant to next", () => {
    const value = cycleModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: undefined,
      configured: "high",
    })

    expect(value).toBe("xhigh")
  })

  test("wraps from configured last variant to first", () => {
    const value = cycleModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: undefined,
      configured: "xhigh",
    })

    expect(value).toBe("low")
  })

  test("cycles from an explicit default to the first variant", () => {
    const value = cycleModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: null,
      configured: "xhigh",
    })

    expect(value).toBe("low")
  })

  test("presents xhigh as Max without changing the provider value", () => {
    expect(modelVariantLabel("xhigh")).toBe("Max")
    expect(modelVariantDescription("xhigh")).toContain("maximum effort")
  })

  test("hides none and collapses duplicate native effort tiers", () => {
    expect(visibleModelVariants(["none", "minimal", "low", "medium", "high", "xhigh"])).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ])
  })

  test("prefers a provider's native max tier", () => {
    expect(visibleModelVariants(["low", "medium", "high", "xhigh", "max"])).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ])
    expect(normalizeModelVariant("xhigh", ["low", "medium", "high", "max"])).toBe("max")
  })

  test("treats the provider none tier as Vector default", () => {
    expect(modelVariantLabel("none")).toBe("Default")
    expect(
      resolveModelVariant({ variants: ["low", "medium", "high", "xhigh"], selected: "none", configured: "high" }),
    ).toBeUndefined()
  })
})
