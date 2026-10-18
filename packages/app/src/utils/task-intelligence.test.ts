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
  freeModel?: { source: "shared" | "openrouter"; dataPolicy?: "no-training" | "may-train" | "unreviewed" }
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
  test("automatic routing cannot upgrade a guarded free choice to a paid model", () => {
    const current = model("acme/mini:free", { provider: { id: "openrouter" }, freeModel: { source: "openrouter" } })
    const paid = model("gpt-5.6", {
      provider: { id: "openrouter" },
      capabilities: { reasoning: true, toolcall: true, input: { image: true } },
    })
    const unverified = model("gpt-5.6:free", { provider: { id: "openrouter" } })
    expect(routeModelForTask({ difficulty: "complex", current, available: [current, paid, unverified] })).toEqual({
      model: current,
      routed: false,
    })
    expect(routeModelForImages({ current, available: [current, paid] })).toEqual({ model: undefined, routed: false })
    expect(
      routeModelForImages({ current: { ...current, freeModel: { source: "shared" } }, available: [paid] }),
    ).toEqual({ model: undefined, routed: false })
  })

  test("automatic routing never moves a prompt onto a free model whose provider may train on it", () => {
    const current = model("cohere/mini:free", {
      provider: { id: "openrouter" },
      freeModel: { source: "openrouter", dataPolicy: "no-training" },
    })
    // A much stronger free model that may train is not a routing target; the person has to pick it.
    const trainer = model("acme/opus-max:free", {
      provider: { id: "openrouter" },
      limit: { context: 1_000_000, output: 64_000 },
      freeModel: { source: "openrouter", dataPolicy: "may-train" },
    })
    expect(routeModelForTask({ difficulty: "complex", current, available: [current, trainer] })).toEqual({
      model: current,
      routed: false,
    })
  })

  for (const id of ["maker/mini:free", "maker/mini:FREE"])
    test(`an unverified configured ${id} cannot auto-route to paid task or image models`, () => {
      const current = model(id, {
        provider: { id: "openrouter" },
        capabilities: { reasoning: false, toolcall: true },
      })
      const paid = model("gpt-5.6", {
        provider: { id: "openrouter" },
        capabilities: { reasoning: true, toolcall: true, input: { image: true } },
      })
      expect(routeModelForTask({ difficulty: "complex", current, available: [current, paid] })).toEqual({
        model: current,
        routed: false,
      })
      expect(routeModelForImages({ current, available: [current, paid] })).toEqual({ model: undefined, routed: false })
    })

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

  test("an image never moves a prompt onto Vector Codium", () => {
    const vision = { capabilities: { reasoning: true, toolcall: true, input: { image: true } } }
    const text = model("maker/text", { provider: { id: "anthropic" } })
    const codium = model("codium/vision", { ...vision, provider: { id: "vector-plan" } })
    const other = model("vision", { ...vision, provider: { id: "openai" } })
    expect(routeModelForImages({ current: text, available: [text, codium] })).toEqual({
      model: undefined,
      routed: false,
    })
    expect(routeModelForImages({ current: text, available: [text, codium, other] })).toEqual({
      model: other,
      routed: true,
    })
    const codiumText = model("codium/text", { provider: { id: "vector-plan" } })
    expect(routeModelForImages({ current: codiumText, available: [codiumText, codium, other] })).toEqual({
      model: codium,
      routed: true,
    })
  })
})
