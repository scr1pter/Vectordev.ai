import { describe, expect, test } from "bun:test"
import {
  includedModelName,
  isIncluded,
  searchModelOptions,
  sortModelOptions,
} from "../../../../src/component/dialog-model"

describe("sortModelOptions", () => {
  test("orders provider-scoped model choices by newest release first", () => {
    const sorted = sortModelOptions(
      [
        { title: "GPT 5.2", releaseDate: "2025-12-11" },
        { title: "GPT 5.4", releaseDate: "2026-03-05" },
        { title: "GPT 5.1", releaseDate: "2025-11-13" },
      ],
      true,
    )

    expect(sorted.map((model) => model.title)).toEqual(["GPT 5.4", "GPT 5.2", "GPT 5.1"])
  })

  test("orders regular model choices included-first and then newest-first", () => {
    const sorted = sortModelOptions(
      [
        { title: "GLM 5", releaseDate: "2025-07-28" },
        { title: "GLM 5.1", releaseDate: "2025-12-09" },
        { title: "GLM 5.2", releaseDate: "2026-02-16" },
        { title: "Included old", releaseDate: "2024-01-01", footer: "Included" },
        { title: "Included new", releaseDate: "2025-01-01", footer: "Included" },
      ],
      false,
    )

    expect(sorted.map((model) => model.title)).toEqual(["Included new", "Included old", "GLM 5.2", "GLM 5.1", "GLM 5"])
  })
})

describe("includedModelName", () => {
  test("drops a trailing Free or (Free) in any case", () => {
    expect(includedModelName("Muse Spark 1.3 Free")).toBe("Muse Spark 1.3")
    expect(includedModelName("Muse Spark 1.3 (Free)")).toBe("Muse Spark 1.3")
    expect(includedModelName("Nemotron 3.5 Lightning FREE")).toBe("Nemotron 3.5 Lightning")
    expect(includedModelName("Big Pickle")).toBe("Big Pickle")
  })

  test("leaves names alone when Free isn't a trailing word", () => {
    expect(includedModelName("Ox Alpha Free (Unlimited)")).toBe("Ox Alpha Free (Unlimited)")
    expect(includedModelName("Carefree")).toBe("Carefree")
    expect(includedModelName("Free")).toBe("Free")
  })
})

describe("isIncluded", () => {
  const zenKey = { id: "opencode", options: {} }
  const keyless = { id: "opencode", options: { apiKey: "public" } }

  test("zero cost from Zen is included for catalogue models, or for any model when Zen runs keyless", () => {
    expect(isIncluded(zenKey, { cost: { input: 0 }, release_date: "2026-03-11" })).toBe(true)
    expect(isIncluded({ id: "opencode-zen" }, { cost: { input: 0 }, release_date: "2026-03-11" })).toBe(true)
    // Defined only in config: no release date, cost defaults to zero, and a Zen key pays for it.
    expect(isIncluded(zenKey, { cost: { input: 0 }, release_date: "" })).toBe(false)
    expect(isIncluded(zenKey, { cost: { input: 0 } })).toBe(false)
    // Keyless, Zen only loads zero-cost models.
    expect(isIncluded(keyless, { cost: { input: 0 }, release_date: "" })).toBe(true)
    expect(isIncluded(zenKey, { cost: { input: 1.25 }, release_date: "2026-03-11" })).toBe(false)
  })

  test("only Zen's models are included: zero cost from any other provider claims nothing", () => {
    // Config and local providers default cost to zero, so zero alone proves nothing.
    expect(isIncluded({ id: "ollama", options: {} }, { cost: { input: 0 }, release_date: "2026-03-11" })).toBe(false)
    expect(isIncluded({ id: "anthropic" }, { cost: { input: 0 }, release_date: "2026-03-11" })).toBe(false)
    // A missing price isn't a zero one.
    expect(isIncluded(keyless, {})).toBe(false)
  })
})

describe("searchModelOptions", () => {
  // As the dialog builds them: included rows sit under the section heading and drop "Free";
  // search reads the catalogue name and the connected provider's name.
  const row = (provider: string, name: string, releaseDate: string, included = false) => ({
    title: included ? includedModelName(name) : name,
    searchName: name,
    searchProvider: provider,
    category: included ? "Models included with Vector" : provider,
    footer: included ? "Included" : undefined,
    releaseDate,
  })
  const options = [
    row("OpenCode Zen", "Muse Spark 1.3 Free", "2026-09-02", true),
    row("OpenCode Zen", "Ling 3.0 Flash Fin Free", "2026-06-10", true),
    row("OpenCode Zen", "Nemotron 3 Ultra Free", "2026-03-11", true),
    row("OpenCode Zen", "Big Pickle", "2025-10-17", true),
    row("Google", "Gemini 3.5 Flash Lite", "2026-05-01"),
    row("Google", "Gemini 3.5 Flash", "2026-05-01"),
    row("OpenAI", "GPT-5 mini", "2025-08-07"),
  ]
  const titles = (needle: string) => searchModelOptions(needle, options).map((option) => option.title)

  test("the section heading doesn't pull included rows into a search", () => {
    // "Models included with Vector" holds l-i-t-e and m-i-n-i in order; Enter picks row one.
    expect(titles("flash lite")).toEqual(["Gemini 3.5 Flash Lite"])
    expect(searchModelOptions("mini", options).filter((option) => option.footer === "Included")).toEqual([])
  })

  test("free still finds the included models by their catalogue names", () => {
    expect(titles("free")).toEqual(["Muse Spark 1.3", "Ling 3.0 Flash Fin", "Nemotron 3 Ultra"])
  })
})
