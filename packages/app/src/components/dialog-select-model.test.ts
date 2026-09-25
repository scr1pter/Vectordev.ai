import { describe, expect, test } from "bun:test"
import {
  buildModelSections,
  contextLabel,
  contextTitle,
  isCodingModel,
  isNewRelease,
  matchRank,
  modelAccess,
  modelAriaLabel,
  modelDisplayName,
  modelTitle,
  pickerKeys,
  pickerModelKey,
  releaseTitle,
  showRowAccess,
  type PickerModel,
} from "../utils/provider-brand"

const DAY = 86_400_000
const NOW = Date.UTC(2026, 8, 11)
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString().slice(0, 10)
const MARKER = "vector-oauth-dummy-key"

type Provider = PickerModel["provider"]
const gateway: Provider = {
  id: "unlisted-service",
  name: "Unlisted service",
  source: "api",
  options: { apiKey: "public" },
}
const unlistedKey: Provider = { id: "unlisted-service", name: "Unlisted service", source: "api", options: {} }
const chatgpt: Provider = { id: "openai", name: "OpenAI", source: "custom", options: { apiKey: MARKER } }
const openaiKey: Provider = { id: "openai", name: "OpenAI", source: "api", options: {} }
const anthropicKey: Provider = { id: "anthropic", name: "Anthropic", source: "api", options: {} }
const anthropicEnv: Provider = {
  id: "anthropic",
  name: "Anthropic",
  source: "env",
  env: ["ANTHROPIC_API_KEY"],
  options: {},
}
const copilot: Provider = { id: "github-copilot", name: "GitHub Copilot", source: "custom", options: { apiKey: "" } }
const copilotToken: Provider = { id: "github-copilot", name: "GitHub Copilot", source: "env", options: {} }
const supergrok: Provider = { id: "xai", name: "xAI", source: "custom", options: { apiKey: MARKER } }
const xaiKey: Provider = { id: "xai", name: "xAI", source: "api", options: {} }
const snowflake: Provider = { id: "snowflake-cortex", name: "Snowflake", source: "custom", options: { apiKey: MARKER } }
const local: Provider = { id: "lmstudio", name: "LM Studio", source: "config", options: {} }

function model(provider: Provider, id: string, name: string, extra: Partial<PickerModel> = {}): PickerModel {
  return {
    id,
    name,
    provider,
    release_date: "2025-01-01",
    capabilities: { reasoning: true },
    limit: { context: 200_000 },
    cost: { input: 1 },
    ...extra,
  }
}

const unlistedModel = (id: string, name: string, extra: Partial<PickerModel> = {}) =>
  model(gateway, id, name, { cost: { input: 0 }, ...extra })

describe("modelAccess", () => {
  test("zero costs, old sign-in markers and empty keys never establish a subscription", () => {
    for (const provider of [chatgpt, copilot, supergrok, snowflake, local, gateway]) {
      for (const input of [0, 2])
        expect(modelAccess(model(provider, "coding", "Coding", { cost: { input } })).kind).toBe("none")
    }
    expect(
      modelAccess(model({ id: "openai", source: "custom" }, "coding", "Coding", { cost: { input: 0 } })).kind,
    ).toBe("none")
  })

  test("known API sources report the user's key without inferring inclusion", () => {
    for (const provider of [anthropicKey, anthropicEnv, openaiKey, xaiKey]) {
      const access = modelAccess(model(provider, "coding", "Coding", { cost: { input: 2 } }))
      expect(access.kind).toBe("key")
      expect(access.label).toBe("API key")
      expect(access.title).toBe(`Uses your ${provider.name} API key`)
    }
    expect(modelAccess(model(openaiKey, "custom", "Custom", { cost: { input: 0 } })).kind).toBe("none")
  })

  test("ambiguous environment credentials and unlisted providers claim no access method", () => {
    expect(modelAccess(model(copilotToken, "coding", "Coding", { cost: { input: 2 } })).kind).toBe("none")
    expect(modelAccess(model(unlistedKey, "coding", "Coding", { cost: { input: 2 } })).kind).toBe("none")
  })

  test("row captions show only for different verified access methods", () => {
    expect(showRowAccess([unlistedModel("a", "A"), unlistedModel("b", "B")])).toBe(false)
    expect(
      showRowAccess([unlistedModel("a", "A"), model(anthropicKey, "claude", "Claude", { cost: { input: 2 } })]),
    ).toBe(true)
  })
})

describe("isCodingModel", () => {
  // As the server sends them, with every output flag set.
  const output = (flags: { text?: boolean; audio?: boolean; image?: boolean }) => ({
    text: false,
    audio: false,
    image: false,
    video: false,
    pdf: false,
    ...flags,
  })
  const image = model(openaiKey, "gpt-image-2", "GPT Image 2", {
    capabilities: { reasoning: false, toolcall: false, output: output({ image: true }) },
  })
  const realtime = model(openaiKey, "gpt-realtime-2.1", "GPT Realtime 2.1", {
    capabilities: { reasoning: false, toolcall: true, output: output({ text: true, audio: true }) },
  })
  const chat = model(openaiKey, "gpt-5.5", "GPT-5.5", {
    capabilities: { reasoning: true, toolcall: true, output: output({ text: true }) },
  })
  const bare = model(local, "llama", "Llama", { capabilities: undefined })

  test("keeps models that call tools and answer in text; drops image and voice models", () => {
    expect(isCodingModel(image)).toBe(false)
    expect(isCodingModel(realtime)).toBe(false)
    expect(isCodingModel(chat)).toBe(true)
  })

  test("a missing field never hides a model", () => {
    expect(isCodingModel(bare)).toBe(true)
    expect(isCodingModel(model(local, "llama", "Llama", { capabilities: { reasoning: true } }))).toBe(true)
    // A catalogue entry without modalities arrives with every output flag false: unknown, not "no text".
    expect(isCodingModel(model(openaiKey, "x", "X", { capabilities: { toolcall: true, output: output({}) } }))).toBe(
      true,
    )
  })

  test("without capabilities, tool_call and modalities.output decide", () => {
    const configured = (extra: Partial<PickerModel>) => model(local, "m", "M", { capabilities: undefined, ...extra })
    expect(isCodingModel(configured({ tool_call: false, modalities: { output: ["image"] } }))).toBe(false)
    // Audio output alone keeps a model; only a voice model by name goes.
    expect(isCodingModel(configured({ modalities: { output: ["text", "audio"] } }))).toBe(true)
    expect(
      isCodingModel(
        model(local, "custom-realtime", "Custom Realtime", {
          capabilities: undefined,
          modalities: { output: ["text", "audio"] },
        }),
      ),
    ).toBe(false)
    expect(isCodingModel(configured({ tool_call: false }))).toBe(false)
    expect(isCodingModel(configured({ tool_call: true, modalities: { output: ["text"] } }))).toBe(true)
    expect(isCodingModel(configured({ modalities: { output: [] } }))).toBe(true)
  })

  test("the picker leaves them out, in every section and in search", () => {
    const models = [image, realtime, chat, bare]
    const browse = buildModelSections({ models, currentKey: pickerModelKey(image), now: NOW })
    expect(new Set(pickerKeys(browse))).toEqual(new Set([pickerModelKey(chat), pickerModelKey(bare)]))
    expect(browse.some((section) => section.kind === "recent")).toBe(false)
    expect(pickerKeys(buildModelSections({ models, term: "gpt", now: NOW }))).toEqual([pickerModelKey(chat)])
  })
})

describe("row text", () => {
  test("context labels", () => {
    expect(contextLabel(400_000)).toBe("400K")
    expect(contextLabel(262_144)).toBe("262K")
    expect(contextLabel(128_000)).toBe("128K")
    expect(contextLabel(1_048_576)).toBe("1M")
    expect(contextLabel(1_050_000)).toBe("1M")
    expect(contextLabel(1_500_000)).toBe("1.5M")
    expect(contextLabel(2_000_000)).toBe("2M")
    expect(contextLabel(0)).toBe("")
    expect(contextLabel(undefined)).toBe("")
    expect(contextTitle(400_000)).toBe("400,000-token context window")
  })

  test("new means released in the last 60 days", () => {
    expect(isNewRelease({ release_date: daysAgo(59) }, NOW)).toBe(true)
    expect(isNewRelease({ release_date: daysAgo(60) }, NOW)).toBe(true)
    expect(isNewRelease({ release_date: daysAgo(61) }, NOW)).toBe(false)
    expect(isNewRelease({ release_date: daysAgo(-3) }, NOW)).toBe(false)
    expect(isNewRelease({ release_date: "not a date" }, NOW)).toBe(false)
    expect(isNewRelease({}, NOW)).toBe(false)
  })

  test("release dates are shown in UTC", () => {
    expect(releaseTitle({ release_date: "2026-08-14" })).toBe("Released Aug 14, 2026")
    expect(releaseTitle({ release_date: "" })).toBe("")
  })

  test("aria-label reads the whole row", () => {
    const astra = model(chatgpt, "gpt-6-astra", "GPT-6 Astra", {
      release_date: "2026-09-04",
      cost: { input: 0 },
      limit: { context: 1_050_000 },
    })
    expect(modelAriaLabel(astra, NOW)).toBe("GPT-6 Astra, OpenAI, 1M context, reasoning, new")
    expect(modelAriaLabel(unlistedModel("sample-coder", "Sample Coder"), NOW)).toBe(
      "Sample Coder, Unlisted service, 200K context, reasoning",
    )
  })

  test("the row tooltip carries what the row leaves out", () => {
    const astra = model(chatgpt, "gpt-6-astra", "GPT-6 Astra", {
      release_date: "2026-09-04",
      cost: { input: 0 },
      limit: { context: 1_050_000 },
    })
    expect(modelTitle(astra)).toBe(
      "GPT-6 Astra\nOpenAI · Reasoning\n1,050,000-token context window\nReleased Sep 4, 2026",
    )
    const lightning = unlistedModel("sample-lightning", "Sample Lightning", {
      release_date: "2026-08-11",
      limit: { context: 262_144 },
      capabilities: { reasoning: false },
    })
    expect(modelTitle(lightning)).toBe(
      "Sample Lightning\nUnlisted service\n262,144-token context window\nReleased Aug 11, 2026",
    )
    const bare = model(local, "llama", "Llama", { capabilities: undefined, limit: undefined, release_date: "" })
    expect(modelTitle(bare)).toBe("Llama\nLM Studio")
  })
})

describe("buildModelSections", () => {
  const astra = model(chatgpt, "gpt-6-astra", "GPT-6 Astra", {
    release_date: "2026-09-04",
    cost: { input: 0 },
    limit: { context: 1_050_000 },
  })
  const sol = model(chatgpt, "gpt-5.6-sol", "GPT-5.6 Sol", {
    release_date: "2026-07-09",
    cost: { input: 0 },
    limit: { context: 400_000 },
  })
  const gpt55 = model(chatgpt, "gpt-5.5", "GPT-5.5", {
    release_date: "2026-04-23",
    cost: { input: 0 },
    limit: { context: 400_000 },
  })
  const opus = model(anthropicKey, "claude-opus-5", "Claude Opus 5", {
    release_date: "2026-07-24",
    cost: { input: 5 },
    limit: { context: 1_000_000 },
  })
  const sonnet = model(anthropicKey, "claude-sonnet-5", "Claude Sonnet 5", {
    release_date: "2026-06-30",
    cost: { input: 2 },
  })
  const pickle = unlistedModel("sample-coder", "Sample Coder", { release_date: "2025-10-17" })
  const muse = unlistedModel("sample-spark", "Sample Spark", {
    release_date: "2026-09-02",
    limit: { context: 1_048_576 },
  })
  const lightning = unlistedModel("sample-lightning", "Sample Lightning", {
    release_date: "2026-08-11",
    limit: { context: 262_144 },
    capabilities: { reasoning: false },
  })
  const ultra = unlistedModel("sample-ultra", "Sample Ultra", {
    release_date: "2026-03-11",
    limit: { context: 1_000_000 },
  })
  const mimo = unlistedModel("sample-small", "Sample Small", { release_date: "2026-05-20" })

  // Deliberately in no useful order: the unlisted roster first, the frontier model last.
  const models = [pickle, muse, lightning, ultra, mimo, gpt55, sol, sonnet, opus, astra]
  const popular = ["unlisted-a", "unlisted-b", "unlisted-c", "anthropic", "github-copilot", "openai", "google"]
  const build = (term = "", extra: { currentKey?: string; recentKeys?: string[] } = {}) =>
    buildModelSections({
      models,
      term,
      now: NOW,
      popular,
      currentKey: pickerModelKey(astra),
      recentKeys: [pickerModelKey(pickle), pickerModelKey(astra)],
      ...extra,
    })
  const keysOf = (items: PickerModel[]) => items.map(pickerModelKey)

  test("new models stay in their own section, newest first; there is no separate new-releases section", () => {
    const sections = build("", { currentKey: undefined, recentKeys: [] })
    expect(sections.map((section) => section.id)).toEqual(["provider:anthropic", "provider:openai"])
    expect(keysOf(sections.find((section) => section.id === "provider:openai")?.items ?? [])).toEqual([
      "openai:gpt-6-astra",
      "openai:gpt-5.6-sol",
      "openai:gpt-5.5",
    ])
    expect(pickerKeys(sections).some((key) => key.startsWith("unlisted-"))).toBe(false)
  })

  test("rows run newest first within a provider, under one access label", () => {
    const sections = build()
    const openai = sections.find((section) => section.id === "provider:openai")
    expect(keysOf(openai?.items ?? [])).toEqual(["openai:gpt-5.6-sol", "openai:gpt-5.5"])
    expect(openai?.access).toBeUndefined()
    expect(sections.find((section) => section.id === "provider:anthropic")?.access?.label).toBe("API key")
  })

  test("rows carry an access caption only where their section mixes ways of paying", () => {
    const sections = build()
    // Unlisted providers do not enter the recent section.
    expect(sections[0].rowAccess).toBe(false)
    expect(sections.slice(1).some((section) => section.rowAccess)).toBe(false)
    // Rows without a verified access label need no per-row caption.
    expect(build("", { recentKeys: [pickerModelKey(sol)] })[0].rowAccess).toBe(false)
  })

  test("keys are unique and are exactly the render order, and every model appears once", () => {
    for (const sections of [build(), build("gpt"), build("free"), build("", { recentKeys: [] })]) {
      const walk: string[] = []
      for (const section of sections) for (const item of section.items) walk.push(pickerModelKey(item))
      expect(pickerKeys(sections)).toEqual(walk)
      expect(new Set(walk).size).toBe(walk.length)
      expect(sections.every((section) => section.items.length > 0)).toBe(true)
    }
    expect(new Set(pickerKeys(build()))).toEqual(
      new Set(keysOf(models.filter((model) => model.provider.id !== "unlisted-service"))),
    )
  })

  test("the top section holds at most three, skips models that aren't listed, and works without recent", () => {
    const recent = build("", {
      recentKeys: ["openai:gone", pickerModelKey(pickle), pickerModelKey(sonnet), pickerModelKey(gpt55)],
    })[0]
    expect(keysOf(recent.items)).toEqual(["openai:gpt-6-astra", "anthropic:claude-sonnet-5", "openai:gpt-5.5"])
    // Parallel Workspaces has no recent list: the section is just the current model.
    const parallel = build("", { recentKeys: undefined })[0]
    expect(keysOf(parallel.items)).toEqual(["openai:gpt-6-astra"])
    // A current model that is hidden or disconnected is left out; the list still starts cleanly.
    const hidden = build("", { currentKey: "openai:gone", recentKeys: [] })
    expect(hidden[0].id).toBe("provider:anthropic")
  })

  test("the top section says Current model until one of its rows comes from recent history", () => {
    // Parallel Workspaces passes no history, and a new user's current model is a default.
    expect(build("", { recentKeys: undefined })[0].label).toBe("Current model")
    expect(build("", { recentKeys: [] })[0].label).toBe("Current model")
    expect(build("", { recentKeys: ["openai:gone"] })[0].label).toBe("Current model")
    expect(build("", { recentKeys: [pickerModelKey(astra)] })[0].label).toBe("Recently used")
    // The current model was never used, but a recent one sits below it.
    expect(build("", { recentKeys: [pickerModelKey(pickle)] })[0].label).toBe("Current model")
  })

  test("searching drops the top section and puts the best match first", () => {
    const sections = build("astra")
    expect(sections.some((section) => section.kind === "recent")).toBe(false)
    expect(pickerKeys(sections)[0]).toBe("openai:gpt-6-astra")
    expect(pickerKeys(build("  ASTRA "))).toEqual(["openai:gpt-6-astra"])
  })

  test("searching orders sections by their best match, then popularity, then A to Z", () => {
    const zed: Provider = { id: "zai", name: "Zed", source: "api", options: {} }
    const beta: Provider = { id: "azure", name: "Beta", source: "api", options: {} }
    // Anthropic is the most popular provider here, but its only match is weak.
    const supernova = model(anthropicKey, "claude-supernova", "Claude Supernova")
    const novaPro = model(openaiKey, "nova-pro", "Nova Pro")
    const novaMini = model(zed, "nova-mini", "Nova Mini")
    const novaMax = model(beta, "nova-max", "Nova Max")
    const novaLite = unlistedModel("nova-lite-free", "Nova Lite Free")
    const items = [supernova, novaPro, novaMini, novaMax, novaLite]
    expect(matchRank(supernova, "nova", NOW)).toBe(2)
    expect(buildModelSections({ models: items, now: NOW, popular }).map((section) => section.id)).toEqual([
      "provider:anthropic",
      "provider:openai",
      "provider:azure",
      "provider:zai",
    ])
    const sections = buildModelSections({ models: items, term: "nova", now: NOW, popular })
    expect(sections.map((section) => section.id)).toEqual([
      "provider:openai",
      "provider:azure",
      "provider:zai",
      "provider:anthropic",
    ])
    expect(pickerKeys(sections)[0]).toBe("openai:nova-pro")
    // An unlisted provider never enters the search results.
    const bigwig = model(anthropicKey, "claude-bigwig", "Claude Bigwig")
    expect(
      buildModelSections({ models: [bigwig, pickle], term: "big", now: NOW, popular }).map((section) => section.id),
    ).toEqual(["provider:anthropic"])
  })

  test("searching by spec: context, access and capability words", () => {
    expect(new Set(pickerKeys(build("1m")))).toEqual(new Set(keysOf([astra, opus])))
    expect(new Set(pickerKeys(build("openai")))).toEqual(new Set(keysOf([astra, sol, gpt55])))
    // Unlisted provider terms do not introduce unavailable models.
    for (const term of ["included", "vector", "free"]) {
      const includedOnly = build(term)
      expect(includedOnly).toEqual([])
      expect(pickerKeys(includedOnly)).toEqual([])
    }
    expect(pickerKeys(build("zzz"))).toEqual([])
  })

  test("match rank beats release date inside a section", () => {
    const provider: Provider = { id: "groq", name: "Acme", source: "api", options: {} }
    const supernova = model(provider, "supernova", "Supernova", { release_date: "2026-09-01" })
    const bigNova = model(provider, "big-nova", "Big Nova", { release_date: "2026-08-01" })
    const novaMini = model(provider, "nova-mini", "Nova Mini", { release_date: "2026-01-01" })
    expect(matchRank(novaMini, "nova", NOW)).toBe(0)
    expect(matchRank(bigNova, "nova", NOW)).toBe(1)
    expect(matchRank(supernova, "nova", NOW)).toBe(2)
    const sections = buildModelSections({ models: [supernova, bigNova, novaMini], term: "nova", now: NOW })
    expect(pickerKeys(sections)).toEqual(["groq:nova-mini", "groq:big-nova", "groq:supernova"])
  })

  test("providers follow the popular order, then the rest alphabetically; nothing listed means no sections", () => {
    const zed: Provider = { id: "zai", name: "Zed", source: "api", options: {} }
    const beta: Provider = { id: "azure", name: "Beta", source: "api", options: {} }
    const sections = buildModelSections({
      models: [model(zed, "z", "Z"), model(beta, "b", "B"), sonnet, gpt55],
      now: NOW,
      popular,
    })
    expect(sections.map((section) => section.id)).toEqual([
      "provider:anthropic",
      "provider:openai",
      "provider:azure",
      "provider:zai",
    ])
    expect(buildModelSections({ models: [], now: NOW, popular })).toEqual([])
  })
})

describe("edge cases from review", () => {
  const audioToo = { text: true, image: true, audio: true, video: false, pdf: false }

  test("a coding model that can also answer in audio stays, and voice models still go", () => {
    const azure: Provider = { id: "azure", name: "Azure", source: "env", env: ["AZURE_API_KEY"], options: {} }
    const codex = model(azure, "gpt-5.1-codex", "GPT-5.1 Codex", {
      capabilities: { reasoning: true, toolcall: true, output: audioToo },
    })
    const voice = model(azure, "gpt-realtime-2.1", "GPT Realtime 2.1", {
      capabilities: { reasoning: false, toolcall: true, output: audioToo },
    })
    expect(isCodingModel(codex)).toBe(true)
    expect(isCodingModel(voice)).toBe(false)
  })

  test("an env var counts as a key only when it is the provider's single var", () => {
    const vertex: Provider = {
      id: "google-vertex",
      name: "Vertex",
      source: "env",
      env: ["GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS"],
      options: {},
    }
    expect(modelAccess(model(vertex, "gemini-3-pro", "Gemini 3 Pro", { cost: { input: 2 } })).kind).toBe("none")
    expect(
      modelAccess(model(anthropicEnv, "claude-fable-5-1", "Claude Fable 5.1", { cost: { input: 10 } })).label,
    ).toBe("API key")
  })

  test("a sign-in that isn't a known plan claims nothing, even with a key env var set", () => {
    const xaiBoth: Provider = {
      id: "xai",
      name: "xAI",
      source: "env",
      env: ["XAI_API_KEY"],
      options: { apiKey: MARKER },
    }
    expect(modelAccess(model(xaiBoth, "grok-4.6", "Grok 4.6", { cost: { input: 2 } })).kind).toBe("none")
  })
})

test("retired providers are excluded from current, recent, provider and search sections", () => {
  const retired = ["unlisted-a", "unlisted-b", "unlisted-c", "unlisted-d"].map((id) =>
    model({ id, source: "api", options: { apiKey: "test-only" } }, "coding", "Coding model", { cost: { input: 3 } }),
  )
  const available = model(anthropicKey, "claude", "Claude")
  for (const term of ["", "coding", "vector"]) {
    const sections = buildModelSections({
      models: [...retired, available],
      term,
      currentKey: pickerModelKey(retired[0]),
      recentKeys: retired.map(pickerModelKey),
      now: NOW,
    })
    expect(pickerKeys(sections).some((key) => key.startsWith("unlisted-"))).toBe(false)
  }
  for (const item of retired) expect(modelAccess(item).kind).toBe("none")
})

test("custom providers remain available in current, recent and searched model choices", () => {
  const custom = model({ id: "ollama", name: "Ollama", source: "config" }, "coder", "Local Coder")
  for (const term of ["", "local", "ollama"]) {
    expect(
      pickerKeys(
        buildModelSections({
          models: [custom],
          term,
          currentKey: pickerModelKey(custom),
          recentKeys: [pickerModelKey(custom)],
          now: NOW,
        }),
      ),
    ).toEqual([pickerModelKey(custom)])
  }
})

test("paused Copilot models from an older server never enter selectable sections", () => {
  const sections = buildModelSections({
    models: [
      model(copilot, "coding", "Copilot Coding"),
      model(copilotToken, "coding", "Copilot Coding"),
      model(openaiKey, "coding", "OpenAI Coding"),
    ],
    now: Date.now(),
    popular: ["github-copilot", "openai"],
  })
  expect(sections.flatMap((section) => section.items).map((item) => item.provider.id)).toEqual(["openai"])
})
