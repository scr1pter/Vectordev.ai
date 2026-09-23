import { describe, expect, test } from "bun:test"
import { searchModelOptions, sortModelOptions } from "../../../../src/component/dialog-model"
import { normalizeCustomProviderID, providerOptions } from "../../../../src/component/dialog-provider"
import { modelDisplayName, modelProviderName } from "../../../../src/util/model"

describe("model choices", () => {
  test("orders model choices by release date", () => {
    const models = [
      { title: "GPT 5.2", releaseDate: "2025-12-11" },
      { title: "GPT 5.4", releaseDate: "2026-03-05" },
      { title: "GPT 5.1", releaseDate: "2025-11-13" },
    ]
    for (const scoped of [true, false]) {
      expect(sortModelOptions(models, scoped).map((model) => model.title)).toEqual(["GPT 5.4", "GPT 5.2", "GPT 5.1"])
    }
  })

  test("hides unlisted providers and rejects their custom provider ids", () => {
    const ids = ["unlisted-a", "unlisted-b", "unlisted-c", "unlisted-d", "anthropic"]
    const options = providerOptions(ids.map((id) => ({ id, name: id })))
    expect(options.filter((item) => item.type === "provider").map((item) => item.value)).toEqual(["anthropic"])
    for (const id of ids.slice(0, -1)) expect(normalizeCustomProviderID(id)).toBeUndefined()
    expect(normalizeCustomProviderID("anthropic")).toBe("anthropic")
  })

  test("shows provider and model names without invented access labels", () => {
    expect(modelDisplayName({ id: "ollama" }, { id: "local", name: "Local model" })).toBe("Local model")
    expect(modelProviderName({ id: "ollama", name: "Ollama" })).toBe("Ollama")
  })

  test("searches model and provider names without matching section headings", () => {
    const models = [
      {
        title: "Gemini Flash Lite",
        searchName: "Gemini Flash Lite",
        searchProvider: "Google",
        category: "Models",
        releaseDate: "2026-05-01",
      },
      {
        title: "GPT mini",
        searchName: "GPT mini",
        searchProvider: "OpenAI",
        category: "Models",
        releaseDate: "2025-08-07",
      },
    ]
    expect(searchModelOptions("flash lite", models).map((model) => model.title)).toEqual(["Gemini Flash Lite"])
    expect(searchModelOptions("Google", models).map((model) => model.title)).toEqual(["Gemini Flash Lite"])
    expect(searchModelOptions("Models", models)).toEqual([])
  })
})
