import { describe, expect, test } from "bun:test"
import type { Provider } from "@vectordevai/sdk/v2"
import { modelProviderName } from "../../src/util/model"
import { name, parse, isHiddenProvider, hasConnectedProvider } from "../../src/util/model"

describe("util.model", () => {
  test("splits provider from a nested model identifier", () => {
    expect(parse("provider/org/model")).toEqual({ providerID: "provider", modelID: "org/model" })
    expect(parse("invalid")).toEqual({ providerID: "invalid", modelID: "" })
  })

  test("preserves provider model names in existing history", () => {
    // Only the fields naming reads.
    const model = (id: string, modelName: string, input = 0) => ({
      id,
      name: modelName,
      cost: { input },
      release_date: "2026-03-11",
    })
    const provider = (id: string, models: ReturnType<typeof model>[]) =>
      ({ id, options: {}, models: Object.fromEntries(models.map((item) => [item.id, item])) }) as unknown as Provider
    const list = [
      provider("groq", [
        model("nemotron-3-ultra-free", "Nemotron 3 Ultra Free"),
        model("muse-spark-1.3", "Muse Spark 1.3 Free", 1.25),
      ]),
      provider("ollama", [model("llama-free", "Llama Free")]),
    ]

    expect(name(list, "groq", "nemotron-3-ultra-free")).toBe("Nemotron 3 Ultra Free")
    // A priced remote model, and a zero-cost model from any other provider, keep their catalogue names.
    expect(name(list, "groq", "muse-spark-1.3")).toBe("Muse Spark 1.3 Free")
    expect(name(list, "ollama", "llama-free")).toBe("Llama Free")
    expect(name(list, "groq", "missing")).toBe("missing")
  })

  test("preserves provider names in existing history", () => {
    const remote = { id: "groq", name: "Groq", options: { apiKey: "public" } }
    const local = { id: "ollama", name: "Ollama", options: {} }
    const zeroCost = { cost: { input: 0 }, release_date: "2026-03-11" }

    expect(modelProviderName(remote, zeroCost)).toBe("Groq")
    // A zero-cost model from any other provider, and a priced remote model, keep their provider's name.
    expect(modelProviderName(local, zeroCost)).toBe("Ollama")
    expect(modelProviderName(remote, { cost: { input: 1 }, release_date: "2026-03-11" })).toBe("Groq")
  })
})

test("custom provider models remain visible while unknown catalog entries stay hidden", () => {
  expect(isHiddenProvider("ollama", { source: "config" })).toBe(false)
  expect(isHiddenProvider("acme-gateway", { source: "custom" })).toBe(false)
  expect(isHiddenProvider("unknown-catalog", { source: "api" })).toBe(true)
})

test("custom-only setups count as connected", () => {
  expect(hasConnectedProvider([{ id: "ollama", source: "config" }])).toBe(true)
  expect(hasConnectedProvider([{ id: "acme-gateway", source: "custom" }])).toBe(true)
  expect(hasConnectedProvider([{ id: "unknown-catalog", source: "env" }])).toBe(false)
  expect(hasConnectedProvider([])).toBe(false)
})
