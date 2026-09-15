import { describe, expect, test } from "bun:test"
import type { Provider } from "@opencode-ai/sdk/v2"
import { modelProviderName } from "../../src/util/included-model"
import { name, parse } from "../../src/util/model"

describe("util.model", () => {
  test("splits provider from a nested model identifier", () => {
    expect(parse("provider/org/model")).toEqual({ providerID: "provider", modelID: "org/model" })
    expect(parse("invalid")).toEqual({ providerID: "invalid", modelID: "" })
  })

  test("names an included model without the Free its catalogue name carries", () => {
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
      provider("opencode", [
        model("nemotron-3-ultra-free", "Nemotron 3 Ultra Free"),
        model("muse-spark-1.3", "Muse Spark 1.3 Free", 1.25),
      ]),
      provider("ollama", [model("llama-free", "Llama Free")]),
    ]

    expect(name(list, "opencode", "nemotron-3-ultra-free")).toBe("Nemotron 3 Ultra")
    // A priced Zen model, and a zero-cost model from any other provider, keep their catalogue names.
    expect(name(list, "opencode", "muse-spark-1.3")).toBe("Muse Spark 1.3 Free")
    expect(name(list, "ollama", "llama-free")).toBe("Llama Free")
    expect(name(list, "opencode", "missing")).toBe("missing")
  })

  test("an included model names no provider on the prompt line", () => {
    const zen = { id: "opencode", name: "OpenCode Zen", options: { apiKey: "public" } }
    const local = { id: "ollama", name: "Ollama", options: {} }
    const zeroCost = { cost: { input: 0 }, release_date: "2026-03-11" }

    expect(modelProviderName(zen, zeroCost)).toBe("Included with Vector")
    // A zero-cost model from any other provider, and a priced Zen model, keep their provider's name.
    expect(modelProviderName(local, zeroCost)).toBe("Ollama")
    expect(modelProviderName(zen, { cost: { input: 1 }, release_date: "2026-03-11" })).toBe("OpenCode Zen")
  })
})
