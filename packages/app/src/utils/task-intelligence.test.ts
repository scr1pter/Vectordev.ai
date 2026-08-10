import { describe, expect, test } from "bun:test"

import {
  classifyTaskDifficulty,
  routeModelForImages,
  routeModelForTask,
  routeVariantForTask,
  supportsImageInput,
} from "./task-intelligence"

type TestModel = {
  id: string
  name: string
  family: string
  status: string
  provider: { id: string }
  capabilities: {
    reasoning: boolean
    toolcall: boolean
    input?: { image?: boolean }
  }
  limit: { context: number; output: number }
  variants: Record<string, unknown>
}

const model = (id: string, input: Partial<TestModel> = {}): TestModel => ({
  id,
  name: id,
  family: id,
  status: "active",
  provider: { id: "test" },
  capabilities: { reasoning: true, toolcall: true },
  limit: { context: 128_000, output: 16_000 },
  variants: {},
  ...input,
})

describe("task intelligence", () => {
  test("keeps conversational messages in the quick lane", () => {
    expect(classifyTaskDifficulty("hello!")).toBe("trivial")
    expect(classifyTaskDifficulty("fix login.ts")).toBe("standard")
  })

  test("routes complex work to a meaningfully stronger model in the same provider", () => {
    const current = model("coder-mini", { capabilities: { reasoning: false, toolcall: true } })
    const strongest = model("gpt-5.6")
    expect(routeModelForTask({ difficulty: "complex", current, available: [current, strongest] })).toEqual({
      model: strongest,
      routed: true,
    })
    expect(routeModelForTask({ difficulty: "simple", current, available: [current, strongest] }).model).toBe(current)
  })

  test("raises default effort for complex work without overriding an explicit choice", () => {
    expect(routeVariantForTask({ difficulty: "complex", variants: ["light", "balanced", "max"] })).toBe("max")
    expect(
      routeVariantForTask({ difficulty: "complex", selected: "light", variants: ["light", "balanced", "max"] }),
    ).toBe("light")
    expect(routeVariantForTask({ difficulty: "complex", selected: "unsupported", variants: ["balanced", "max"] })).toBe(
      "max",
    )
  })

  test("keeps a selected model that understands images", () => {
    const vision = model("vision", { capabilities: { reasoning: true, toolcall: true, input: { image: true } } })
    expect(supportsImageInput(vision)).toBe(true)
    expect(routeModelForImages({ current: vision, available: [vision] })).toEqual({ model: vision, routed: false })
  })

  test("routes image prompts to a connected vision model and reports when none exists", () => {
    const text = model("text-only")
    const sameProvider = model("vision", {
      capabilities: { reasoning: true, toolcall: true, input: { image: true } },
    })
    expect(routeModelForImages({ current: text, available: [text, sameProvider] })).toEqual({
      model: sameProvider,
      routed: true,
    })
    expect(routeModelForImages({ current: text, available: [text] })).toEqual({ model: undefined, routed: false })
  })
})
