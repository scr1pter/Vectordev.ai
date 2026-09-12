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
const MARKER = "opencode-oauth-dummy-key"

type Provider = PickerModel["provider"]
const gateway: Provider = { id: "opencode", name: "OpenCode Zen", source: "custom", options: { apiKey: "public" } }
const zenKey: Provider = { id: "opencode", name: "OpenCode Zen", source: "api", options: {} }
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
const local: Provider = { id: "ollama", name: "Ollama", source: "config", options: {} }

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

const free = (id: string, name: string, extra: Partial<PickerModel> = {}) =>
  model(gateway, id, name, { cost: { input: 0 }, ...extra })

describe("modelAccess", () => {
  test("a zero-cost model from Vector's gateway is free", () => {
    const access = modelAccess(free("big-pickle", "Big Pickle"))
    expect(access.kind).toBe("free")
    expect(access.label).toBe("Free")
    expect(access.title).toBe("Included with Vector at no cost")
    expect(modelAccess(model({ ...gateway, id: "opencode-zen" }, "x", "X", { cost: { input: 0 } })).label).toBe("Free")
  })

  test("zero cost from the gateway is free only for catalogue models or when it runs keyless", () => {
    // Defined only in config: no release date, cost defaults to zero, and a Zen key pays for it.
    const configOnly = model(zenKey, "my-model", "My model Free", { cost: { input: 0 }, release_date: "" })
    expect(modelAccess(configOnly).kind).toBe("none")
    expect(modelDisplayName(configOnly)).toBe("My model Free")
    expect(modelAccess({ ...configOnly, release_date: undefined }).kind).toBe("none")
    // A catalogue model stays free on a Zen key; keyless, the gateway only loads free models.
    expect(modelAccess(model(zenKey, "big-pickle", "Big Pickle", { cost: { input: 0 } })).kind).toBe("free")
    expect(modelAccess(model(gateway, "my-model", "My model", { cost: { input: 0 }, release_date: "" })).kind).toBe(
      "free",
    )
  })

  test("a zero-cost model from a provider that normally charges is included with the sign-in plan", () => {
    const access = modelAccess(model(chatgpt, "gpt-6-astra", "GPT-6 Astra", { cost: { input: 0 } }))
    expect(access.kind).toBe("plan")
    expect(access.label).toBe("ChatGPT plan")
    expect(access.title).toBe("Uses your ChatGPT plan")
    expect(access.spoken).toBe("uses your ChatGPT plan")
    expect(modelAccess(model(copilot, "claude-opus-5", "Claude Opus 5", { cost: { input: 0 } })).label).toBe(
      "Copilot plan",
    )
  })

  test("a priced model never reads as free", () => {
    const priced = [
      model(gateway, "muse-spark-1.3", "Muse Spark 1.3", { cost: { input: 1.25 } }),
      model(zenKey, "muse-spark-1.3", "Muse Spark 1.3", { cost: { input: 1.25 } }),
      model(openaiKey, "gpt-5.5", "GPT-5.5", { cost: { input: 5 } }),
      model(anthropicKey, "claude-opus-5", "Claude Opus 5", { cost: { input: 5 } }),
      model(snowflake, "claude", "Claude", { cost: { input: 3 } }),
      model(local, "llama", "Llama", { cost: [{ input: 0 }, { input: 2 }] }),
    ]
    for (const item of priced) expect(modelAccess(item).kind).not.toBe("free")
  })

  test("known sign-in plans win over price, and the plan name is never invented", () => {
    // Signed-in Copilot models carry catalogue prices, but the plan pays for them.
    expect(modelAccess(model(copilot, "gpt-6-astra", "GPT-6 Astra", { cost: { input: 10 } })).label).toBe(
      "Copilot plan",
    )
    // xAI's sign-in proves no plan and keeps per-token prices, so it claims nothing.
    expect(modelAccess(model(supergrok, "grok-4.6", "Grok 4.6", { cost: { input: 2 } })).kind).toBe("none")
    expect(modelAccess(model(xaiKey, "grok-4.6", "Grok 4.6", { cost: { input: 2 } })).label).toBe("API key")
    // Snowflake Cortex sets the same marker but bills credits: no plan, no "Free".
    expect(modelAccess(model(snowflake, "claude", "Claude", { cost: { input: 0 } })).kind).toBe("none")
  })

  test("Copilot reads as a plan only with the Copilot sign-in", () => {
    // A GITHUB_TOKEN env var connects Copilot without the sign-in: no plan, and not an API key either.
    for (const input of [0, 10]) {
      const access = modelAccess(model(copilotToken, "claude-opus-5", "Claude Opus 5", { cost: { input } }))
      expect(access.kind).toBe("none")
      expect(access.label).toBe("")
    }
  })

  test("ChatGPT detection survives options disappearing, without mislabelling config models", () => {
    const withoutOptions: Provider = { id: "openai", name: "OpenAI", source: "custom" }
    expect(modelAccess(model(withoutOptions, "gpt-6-astra", "GPT-6 Astra", { cost: { input: 0 } })).label).toBe(
      "ChatGPT plan",
    )
    // An API-key user's config-defined OpenAI model defaults to zero cost: that proves nothing.
    expect(modelAccess(model(openaiKey, "my-finetune", "My fine-tune", { cost: { input: 0 } })).kind).toBe("none")
  })

  test("other zero cost claims nothing; a priced key says only that it's used", () => {
    expect(modelAccess(model(local, "llama", "Llama", { cost: { input: 0 } })).kind).toBe("none")
    expect(modelAccess(model(local, "llama", "Llama", { cost: undefined })).kind).toBe("none")
    expect(modelAccess(model(local, "llama", "Llama", { cost: { input: 2 } })).kind).toBe("none")
    const key = modelAccess(model(anthropicKey, "claude-opus-5", "Claude Opus 5", { cost: { input: 5 } }))
    expect(key.label).toBe("API key")
    expect(key.title).toBe("Uses your Anthropic API key")
    expect(key.spoken).toBe("uses your API key")
    expect(modelAccess(model(anthropicEnv, "claude-opus-5", "Claude Opus 5", { cost: { input: 5 } })).label).toBe(
      "API key",
    )
  })

  test("row captions show only when rows are paid for in more than one way", () => {
    expect(showRowAccess([free("a", "A"), free("b", "B")])).toBe(false)
    expect(showRowAccess([free("a", "A"), model(chatgpt, "gpt-5.5", "GPT-5.5", { cost: { input: 0 } })])).toBe(true)
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

  test("a free model drops the trailing Free its caption already carries", () => {
    expect(modelDisplayName(free("n", "Nemotron 3.5 Lightning Free"))).toBe("Nemotron 3.5 Lightning")
    expect(modelDisplayName(free("m", "Muse Spark 1.3 (Free)"))).toBe("Muse Spark 1.3")
    expect(modelDisplayName(free("b", "Big Pickle"))).toBe("Big Pickle")
    expect(modelDisplayName(free("o", "Ox Alpha Free (Unlimited)"))).toBe("Ox Alpha Free (Unlimited)")
    expect(modelDisplayName(model(zenKey, "m", "Muse Spark 1.3 Free", { cost: { input: 1 } }))).toBe(
      "Muse Spark 1.3 Free",
    )
  })

  test("aria-label reads the whole row", () => {
    const astra = model(chatgpt, "gpt-6-astra", "GPT-6 Astra", {
      release_date: "2026-09-04",
      cost: { input: 0 },
      limit: { context: 1_050_000 },
    })
    expect(modelAriaLabel(astra, NOW)).toBe("GPT-6 Astra, OpenAI, 1M context, reasoning, new, uses your ChatGPT plan")
    expect(modelAriaLabel(free("big-pickle", "Big Pickle"), NOW)).toBe(
      "Big Pickle, 200K context, reasoning, free, included with Vector",
    )
  })

  test("the row tooltip carries what the row leaves out", () => {
    const astra = model(chatgpt, "gpt-6-astra", "GPT-6 Astra", {
      release_date: "2026-09-04",
      cost: { input: 0 },
      limit: { context: 1_050_000 },
    })
    expect(modelTitle(astra)).toBe(
      "GPT-6 Astra\nOpenAI · Reasoning\n1,050,000-token context window\nReleased Sep 4, 2026\nUses your ChatGPT plan",
    )
    const lightning = free("nemotron-3.5-lightning-free", "Nemotron 3.5 Lightning Free", {
      release_date: "2026-08-11",
      limit: { context: 262_144 },
      capabilities: { reasoning: false },
    })
    expect(modelTitle(lightning)).toBe(
      "Nemotron 3.5 Lightning Free\n262,144-token context window\nReleased Aug 11, 2026\nIncluded with Vector at no cost",
    )
    const bare = model(local, "llama", "Llama", { capabilities: undefined, limit: undefined, release_date: "" })
    expect(modelTitle(bare)).toBe("Llama\nOllama")
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
  const pickle = free("big-pickle", "Big Pickle", { release_date: "2025-10-17" })
  const muse = free("muse-spark-1.3-free", "Muse Spark 1.3 Free", {
    release_date: "2026-09-02",
    limit: { context: 1_048_576 },
  })
  const lightning = free("nemotron-3.5-lightning-free", "Nemotron 3.5 Lightning Free", {
    release_date: "2026-08-11",
    limit: { context: 262_144 },
    capabilities: { reasoning: false },
  })
  const ultra = free("nemotron-3-ultra-free", "Nemotron 3 Ultra Free", {
    release_date: "2026-03-11",
    limit: { context: 1_000_000 },
  })
  const mimo = free("mimo-v2.5-free", "MiMo V2.5 Free", { release_date: "2026-05-20" })

  // Deliberately in no useful order: the free roster first, the frontier model last.
  const models = [pickle, muse, lightning, ultra, mimo, gpt55, sol, sonnet, opus, astra]
  const popular = ["opencode", "opencode-go", "opencode-zen", "anthropic", "github-copilot", "openai", "google"]
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

  test("the current model is the first row, and Vector's included models come last", () => {
    const sections = build()
    expect(sections.map((section) => section.id)).toEqual([
      "recent",
      "provider:anthropic",
      "provider:openai",
      "included",
    ])
    expect(pickerKeys(sections)[0]).toBe("openai:gpt-6-astra")
    expect(keysOf(sections[0].items)).toEqual(["openai:gpt-6-astra", "opencode:big-pickle"])
    expect(sections[0].label).toBe("Recently used")
    expect(sections.at(-1)?.label).toBe("Included with Vector")
    expect(sections.at(-1)?.access?.label).toBe("Free")
  })

  test("new models stay in their own section, newest first; there is no separate new-releases section", () => {
    const sections = build("", { currentKey: undefined, recentKeys: [] })
    expect(sections.map((section) => section.id)).toEqual(["provider:anthropic", "provider:openai", "included"])
    expect(keysOf(sections.find((section) => section.id === "provider:openai")?.items ?? [])).toEqual([
      "openai:gpt-6-astra",
      "openai:gpt-5.6-sol",
      "openai:gpt-5.5",
    ])
    expect(keysOf(sections.find((section) => section.id === "included")?.items ?? [])).toEqual(
      keysOf([muse, lightning, mimo, ultra, pickle]),
    )
  })

  test("rows run newest first within a provider, under one access label", () => {
    const sections = build()
    const openai = sections.find((section) => section.id === "provider:openai")
    expect(keysOf(openai?.items ?? [])).toEqual(["openai:gpt-5.6-sol", "openai:gpt-5.5"])
    expect(openai?.access?.label).toBe("ChatGPT plan")
    expect(sections.find((section) => section.id === "provider:anthropic")?.access?.label).toBe("API key")
  })

  test("rows carry an access caption only where their section mixes ways of paying", () => {
    const sections = build()
    // GPT-6 Astra (ChatGPT plan) and Big Pickle (Free) share the top section.
    expect(sections[0].rowAccess).toBe(true)
    expect(sections.slice(1).some((section) => section.rowAccess)).toBe(false)
    // Two ChatGPT plan rows: nothing to tell apart.
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
    expect(new Set(pickerKeys(build()))).toEqual(new Set(keysOf(models)))
  })

  test("the top section holds at most three, skips models that aren't listed, and works without recent", () => {
    const recent = build("", {
      recentKeys: ["openai:gone", pickerModelKey(pickle), pickerModelKey(sonnet), pickerModelKey(gpt55)],
    })[0]
    expect(keysOf(recent.items)).toEqual(["openai:gpt-6-astra", "opencode:big-pickle", "anthropic:claude-sonnet-5"])
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
    expect(build("", { recentKeys: [pickerModelKey(pickle)] })[0].label).toBe("Recently used")
  })

  test("searching drops the top section and puts the best match first", () => {
    const sections = build("astra")
    expect(sections.some((section) => section.kind === "recent")).toBe(false)
    expect(pickerKeys(sections)[0]).toBe("openai:gpt-6-astra")
    expect(pickerKeys(build("  ASTRA "))).toEqual(["openai:gpt-6-astra"])
  })

  test("searching orders sections by their best match, then popularity, then A to Z", () => {
    const zed: Provider = { id: "zed", name: "Zed", source: "api", options: {} }
    const beta: Provider = { id: "beta", name: "Beta", source: "api", options: {} }
    // Anthropic is the most popular provider here, but its only match is weak.
    const supernova = model(anthropicKey, "claude-supernova", "Claude Supernova")
    const novaPro = model(openaiKey, "nova-pro", "Nova Pro")
    const novaMini = model(zed, "nova-mini", "Nova Mini")
    const novaMax = model(beta, "nova-max", "Nova Max")
    const novaLite = free("nova-lite-free", "Nova Lite Free")
    const items = [supernova, novaPro, novaMini, novaMax, novaLite]
    expect(matchRank(supernova, "nova", NOW)).toBe(2)
    expect(buildModelSections({ models: items, now: NOW, popular }).map((section) => section.id)).toEqual([
      "provider:anthropic",
      "provider:openai",
      "provider:beta",
      "provider:zed",
      "included",
    ])
    const sections = buildModelSections({ models: items, term: "nova", now: NOW, popular })
    expect(sections.map((section) => section.id)).toEqual([
      "provider:openai",
      "provider:beta",
      "provider:zed",
      "included",
      "provider:anthropic",
    ])
    expect(pickerKeys(sections)[0]).toBe("openai:nova-pro")
    // "Included with Vector" leads when it holds the best match.
    const bigwig = model(anthropicKey, "claude-bigwig", "Claude Bigwig")
    expect(
      buildModelSections({ models: [bigwig, pickle], term: "big", now: NOW, popular }).map((section) => section.id),
    ).toEqual(["included", "provider:anthropic"])
  })

  test("searching by spec: context, access and capability words", () => {
    expect(new Set(pickerKeys(build("1m")))).toEqual(new Set(keysOf([astra, opus, muse, ultra])))
    expect(new Set(pickerKeys(build("chatgpt")))).toEqual(new Set(keysOf([astra, sol, gpt55])))
    const freeOnly = build("free")
    expect(freeOnly.map((section) => section.id)).toEqual(["included"])
    expect(new Set(pickerKeys(freeOnly))).toEqual(new Set(keysOf([pickle, muse, lightning, ultra, mimo])))
    expect(pickerKeys(build("zzz"))).toEqual([])
  })

  test("match rank beats release date inside a section", () => {
    const provider: Provider = { id: "acme", name: "Acme", source: "api", options: {} }
    const supernova = model(provider, "supernova", "Supernova", { release_date: "2026-09-01" })
    const bigNova = model(provider, "big-nova", "Big Nova", { release_date: "2026-08-01" })
    const novaMini = model(provider, "nova-mini", "Nova Mini", { release_date: "2026-01-01" })
    expect(matchRank(novaMini, "nova", NOW)).toBe(0)
    expect(matchRank(bigNova, "nova", NOW)).toBe(1)
    expect(matchRank(supernova, "nova", NOW)).toBe(2)
    const sections = buildModelSections({ models: [supernova, bigNova, novaMini], term: "nova", now: NOW })
    expect(pickerKeys(sections)).toEqual(["acme:nova-mini", "acme:big-nova", "acme:supernova"])
  })

  test("providers follow the popular order, then the rest alphabetically; nothing listed means no sections", () => {
    const zed: Provider = { id: "zed", name: "Zed", source: "api", options: {} }
    const beta: Provider = { id: "beta", name: "Beta", source: "api", options: {} }
    const sections = buildModelSections({
      models: [model(zed, "z", "Z"), model(beta, "b", "B"), sonnet, gpt55],
      now: NOW,
      popular,
    })
    expect(sections.map((section) => section.id)).toEqual([
      "provider:anthropic",
      "provider:openai",
      "provider:beta",
      "provider:zed",
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
