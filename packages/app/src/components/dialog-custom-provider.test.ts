import { describe, expect, test } from "bun:test"
import { ModelSlots } from "@vectordevai/core/local-mode/model-slots"
import type { LocalProbe } from "@vectordevai/core/local-mode/probe"
import { createVectorClient, type Config } from "@vectordevai/sdk/v2/client"
import {
  applyPreset,
  applyServer,
  COPY,
  defaultOutput,
  type FormState,
  freeID,
  identifyHeaders,
  identity,
  labels,
  PRESETS,
  validateCustomProvider,
} from "./dialog-custom-provider-form"
import { listed, saveCustomProvider } from "./dialog-custom-provider-save"
import { listServer } from "../features/local/local-model"

const t = (key: string) => key

describe("validateCustomProvider", () => {
  test("builds trimmed config payload", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "myprovider",
        name: " Custom Provider ",
        baseURL: "https://api.example.com ",
        apiKey: " {env: CUSTOM_PROVIDER_KEY} ",
        models: [{ row: "m0", id: " model-a ", name: " Model A ", err: {} }],
        headers: [
          { row: "h0", key: " X-Test ", value: " enabled ", err: {} },
          { row: "h1", key: "", value: "", err: {} },
        ],
        err: {},
      },
      t,
    })

    expect(result.result).toEqual({
      providerID: "myprovider",
      name: "Custom Provider",
      key: undefined,
      config: {
        npm: "@ai-sdk/openai-compatible",
        name: "Custom Provider",
        env: ["CUSTOM_PROVIDER_KEY"],
        options: {
          baseURL: "https://api.example.com",
          headers: {
            "X-Test": "enabled",
          },
        },
        models: {
          "model-a": { name: "Model A" },
        },
      },
    })
  })

  test("flags duplicate models and headers", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "myprovider",
        name: "Provider",
        baseURL: "https://api.example.com",
        apiKey: "secret",
        models: [
          { row: "m0", id: "model-a", name: "Model A", err: {} },
          { row: "m1", id: "model-a", name: "Model A 2", err: {} },
        ],
        headers: [
          { row: "h0", key: "Authorization", value: "one", err: {} },
          { row: "h1", key: "authorization", value: "two", err: {} },
        ],
        err: {},
      },
      t,
    })

    expect(result.result).toBeUndefined()
    expect(result.err.providerID).toBeUndefined()
    expect(result.models[1]).toEqual({
      id: "provider.custom.error.duplicate",
      name: undefined,
      context: undefined,
      output: undefined,
    })
    expect(result.headers[1]).toEqual({
      key: "provider.custom.error.duplicate",
      value: undefined,
    })
  })
})

test("allows a new custom ID and rejects catalog, configured, and disabled IDs", () => {
  const form = {
    providerID: "ollama",
    name: "Private endpoint",
    baseURL: "http://127.0.0.1:11434/v1",
    apiKey: "test-only",
    models: [{ row: "m0", id: "local-model", name: "Local model", err: {} }],
    headers: [],
    err: {},
  }
  expect(validateCustomProvider({ form, t }).result?.providerID).toBe("ollama")
  for (const providerID of ["openai", "lmstudio", "configured", "disabled"]) {
    const result = validateCustomProvider({ form: { ...form, providerID }, existing: ["configured", "disabled"], t })
    expect(result.result).toBeUndefined()
    expect(result.err.providerID).toBe("provider.custom.error.providerID.exists")
  }
  expect(validateCustomProvider({ form: { ...form, providerID: "Not valid" }, t }).err.providerID).toBe(
    "provider.custom.error.providerID.format",
  )
})

const empty = (): FormState => ({
  providerID: "",
  name: "",
  baseURL: "",
  apiKey: "",
  models: [{ row: "m0", id: "", name: "", err: {} }],
  headers: [],
  concurrency: "",
  err: {},
})

// What Find servers returns for Ollama on this computer, in the shape the engine sends (LocalProbe.Server).
const OLLAMA: LocalProbe.Server = {
  kind: "ollama",
  name: "Ollama",
  origin: "http://127.0.0.1:11434",
  baseURL: "http://127.0.0.1:11434/v1",
  version: "0.12.6",
  class: "this-computer",
  encrypted: false,
  concurrency: 1,
  forwards: "ollama-cloud",
  models: [
    { id: "gemma3:12b", tools: false, vision: true, loaded: false },
    { id: "gpt-oss:120b-cloud", cloud: true },
    { id: "qwen3-coder:30b", context: 32768, trained: 262144, output: 8192, tools: true, vision: false, loaded: true },
  ],
  pin: { kind: "ollama", version: "0.12.6", models: "sha256:abc", spki: null },
}

const GPU_BOX: LocalProbe.Server = {
  ...OLLAMA,
  kind: "vllm",
  name: "vLLM",
  origin: "http://10.0.0.5:8000",
  baseURL: "http://10.0.0.5:8000/v1",
  version: "0.11.0",
  class: "your-network",
  concurrency: 4,
  forwards: undefined,
  models: [{ id: "Qwen/Qwen3-Coder-30B-A3B-Instruct", context: 65536, output: 8192, loaded: true }],
  pin: { kind: "vllm", version: "0.11.0", models: "sha256:def", spki: null },
}

describe("presets", () => {
  test("cover the servers people host, at their usual addresses", () => {
    expect(PRESETS.map((preset) => [preset.kind, preset.baseURL])).toEqual([
      ["ollama", "http://127.0.0.1:11434/v1"],
      ["lmstudio", "http://127.0.0.1:1234/v1"],
      ["vllm", "http://127.0.0.1:8000/v1"],
      ["llamacpp", "http://127.0.0.1:8080/v1"],
      ["sglang", "http://127.0.0.1:30000/v1"],
      ["openai", ""],
    ])
    // Each suggested ID passes validation, so none collides with a catalog provider such as lmstudio.
    PRESETS.filter((preset) => preset.providerID).forEach((preset) => {
      const form = { ...applyPreset(empty(), preset), models: [{ row: "m", id: "m", name: "m", err: {} }] }
      expect(validateCustomProvider({ form, t }).err.providerID).toBeUndefined()
    })
  })

  test("fill the address, name and concurrency, and keep what the user typed", () => {
    const ollama = PRESETS.find((preset) => preset.kind === "ollama")!
    expect(applyPreset(empty(), ollama)).toMatchObject({
      kind: "ollama",
      providerID: "ollama",
      name: "Ollama",
      baseURL: "http://127.0.0.1:11434/v1",
      concurrency: "1",
    })
    const typed = applyPreset({ ...empty(), providerID: "home", name: "Home GPU" }, ollama)
    expect(typed).toMatchObject({ providerID: "home", name: "Home GPU" })
    // A taken ID gets the next free one.
    expect(applyPreset(empty(), ollama, ["ollama"]).providerID).toBe("ollama-2")
    expect(freeID("ollama", ["ollama", "ollama-2"])).toBe("ollama-3")
    // Other leaves the address to the user and sets no limit.
    expect(applyPreset(empty(), PRESETS.at(-1)!)).toMatchObject({ kind: "openai", baseURL: "", concurrency: "" })
  })
})

describe("a server Find servers or Identify read", () => {
  test("fills one row per model with what the server reports, leaving out cloud models", () => {
    const applied = applyServer(empty(), OLLAMA)
    expect(applied.skipped).toBe(1)
    expect(COPY.cloudModels(applied.skipped)).toBe("Left out 1 cloud model: Ollama sends their prompts to ollama.com.")
    expect(applied.form).toMatchObject({
      kind: "ollama",
      providerID: "ollama",
      name: "Ollama",
      baseURL: "http://127.0.0.1:11434/v1",
      concurrency: "1",
    })
    expect(
      applied.form.models.map(({ id, context, output, tools, vision }) => ({ id, context, output, tools, vision })),
    ).toEqual([
      { id: "gemma3:12b", context: "", output: "", tools: false, vision: true },
      { id: "qwen3-coder:30b", context: "32768", output: "8192", tools: true, vision: false },
    ])
  })

  test("saves the provider's concurrency and per-model facts, and lists the server with its pin", () => {
    const result = validateCustomProvider({ form: applyServer(empty(), OLLAMA).form, t }).result
    expect(result?.config).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "Ollama",
      options: { baseURL: "http://127.0.0.1:11434/v1", concurrency: 1 },
      models: {
        "gemma3:12b": {
          name: "gemma3:12b",
          tool_call: false,
          modalities: { input: ["text", "image"], output: ["text"] },
        },
        "qwen3-coder:30b": {
          name: "qwen3-coder:30b",
          tool_call: true,
          limit: { context: 32768, output: 8192 },
          modalities: { input: ["text"], output: ["text"] },
        },
      },
    })
    expect(result?.local).toEqual({ origin: OLLAMA.origin, pin: OLLAMA.pin })
  })

  test("an address changed after the server was read is not pinned", () => {
    const form = { ...applyServer(empty(), OLLAMA).form, baseURL: "http://127.0.0.1:11435/v1" }
    expect(validateCustomProvider({ form, t }).result?.local).toBeUndefined()
    expect(labels(form).changedAddress).toBe(true)
    expect(labels(form).identity).toBeUndefined()
  })
})

describe("labels", () => {
  test("Not encrypted for plain http off this computer only", () => {
    expect(labels({ baseURL: "http://10.0.0.5:8000/v1" }).notEncrypted).toBe(true)
    expect(labels({ baseURL: "http://gpu-box:8000/v1" }).notEncrypted).toBe(true)
    expect(labels({ baseURL: "http://127.0.0.1:11434/v1" }).notEncrypted).toBe(false)
    expect(labels({ baseURL: "http://[::1]:11434/v1" }).notEncrypted).toBe(false)
    expect(labels({ baseURL: "https://ml.corp.example.com/v1" }).notEncrypted).toBe(false)
    expect(COPY.notEncrypted).toBe("Not encrypted: prompts to this server travel in plain text on your network.")
  })

  test("who answered, the shared-machine note and forwarding", () => {
    const here = labels(applyServer(empty(), OLLAMA).form)
    expect(here).toMatchObject({
      identity: "Ollama 0.12.6 on this computer",
      sharedMachine: true,
      forwarding: true,
      notEncrypted: false,
    })
    const there = labels(applyServer(empty(), GPU_BOX).form)
    expect(there).toMatchObject({
      identity: "vLLM 0.11.0 on your network",
      sharedMachine: false,
      forwarding: false,
      notEncrypted: true,
    })
    expect(identity({ name: "LM Studio", version: undefined, class: "this-computer" })).toBe(
      "LM Studio on this computer",
    )
    // Hosted servers need each model's context; a cloud API's address does not.
    expect(labels({ baseURL: "http://10.0.0.5:8000/v1" }).hosted).toBe(true)
    expect(labels({ baseURL: "https://api.example.com/v1" }).hosted).toBe(false)
  })

  test("an empty Requests at once says what the engine does with it", () => {
    const slots = ModelSlots.make()
    const cases = [
      ["http://127.0.0.1:11434/v1", "One at a time", 1],
      ["http://10.0.0.5:8000/v1", "One at a time", 1],
      ["https://ml.corp.example.com/v1", "No limit", Number.POSITIVE_INFINITY],
    ] as const
    cases.forEach(([baseURL, shown, permits]) => {
      expect(COPY.concurrencyEmpty(labels({ baseURL }).hosted)).toBe(shown)
      // The engine's own default for a server whose count nobody set.
      expect(slots.queue(new URL(baseURL).origin).permits).toBe(permits)
    })
  })
})

describe("Identify", () => {
  test("sends the typed API key and headers, so a server behind a key answers", () => {
    const form = {
      apiKey: " sk-company ",
      headers: [
        { row: "h0", key: "X-Team", value: "ml", err: {} },
        { row: "h1", key: "", value: "", err: {} },
      ],
    }
    expect(identifyHeaders(form)).toEqual({ authorization: "Bearer sk-company", "X-Team": "ml" })
  })

  test("leaves out a key that names an environment variable, which only the engine can read", () => {
    expect(identifyHeaders({ apiKey: "{env:COMPANY_KEY}", headers: [] })).toEqual({})
    expect(identifyHeaders({ apiKey: "", headers: [] })).toEqual({})
  })
})

describe("per-model fields", () => {
  const form = (model: Partial<FormState["models"][number]>, concurrency = ""): FormState => ({
    ...empty(),
    providerID: "home",
    name: "Home",
    baseURL: "http://127.0.0.1:8080/v1",
    concurrency,
    models: [{ row: "m0", id: "m", name: "M", err: {}, ...model }],
  })

  test("a context without a reply limit takes a quarter of it, at most 8,192", () => {
    expect(validateCustomProvider({ form: form({ context: "16384" }), t }).result?.config.models["m"]).toEqual({
      name: "M",
      limit: { context: 16384, output: 4096 },
    })
    expect(defaultOutput(262144)).toBe(8192)
    expect(defaultOutput(8192)).toBe(2048)
  })

  test("refuses numbers that are not whole, a reply limit past the context, and one without a context", () => {
    expect(validateCustomProvider({ form: form({ context: "16k" }), t }).models[0]?.context).toBe(
      "Use a whole number of tokens",
    )
    expect(validateCustomProvider({ form: form({ context: "4096", output: "8192" }), t }).models[0]?.output).toBe(
      "Must not be more than the context",
    )
    expect(validateCustomProvider({ form: form({ output: "512" }), t }).models[0]?.output).toBe("Set the context too")
    expect(validateCustomProvider({ form: form({}, "0"), t }).err.concurrency).toBe("Use a whole number of 1 or more")
    expect(validateCustomProvider({ form: form({}, "2"), t }).result?.config.options).toEqual({
      baseURL: "http://127.0.0.1:8080/v1",
      concurrency: 2,
    })
  })
})

describe("saving a server Vector read", () => {
  test("adds it to the list once and pins it, keeping the other servers", () => {
    const current = {
      endpoints: ["http://10.0.0.5:8000"],
      pins: { "http://10.0.0.5:8000": { kind: "vllm", version: "0.11.0", models: "sha256:def" } },
    }
    expect(listed(current, { origin: OLLAMA.origin, pin: OLLAMA.pin })).toEqual({
      endpoints: ["http://10.0.0.5:8000", "http://127.0.0.1:11434"],
      pins: {
        "http://10.0.0.5:8000": { kind: "vllm", version: "0.11.0", models: "sha256:def" },
        "http://127.0.0.1:11434": { kind: "ollama", version: "0.12.6", models: "sha256:abc" },
      },
    })
    const again = listed(listed(current, { origin: OLLAMA.origin, pin: OLLAMA.pin }), {
      origin: OLLAMA.origin,
      pin: { ...OLLAMA.pin, spki: "key" },
    })
    expect(again.endpoints).toEqual(["http://10.0.0.5:8000", "http://127.0.0.1:11434"])
    expect(again.pins?.["http://127.0.0.1:11434"]?.spki).toBe("key")
  })

  test("reads the global list, not the merged config, and writes provider and list in one global update", async () => {
    const requests: string[] = []
    const updates: Config[] = []
    const client = createVectorClient({
      baseUrl: "http://fixture.test",
      fetch: Object.assign(
        async (source: RequestInfo | URL, init?: RequestInit) => {
          const request = source instanceof Request ? source : new Request(source, init)
          const pathname = new URL(request.url).pathname
          requests.push(`${request.method} ${pathname}`)
          if (pathname === "/provider") return Response.json({ all: [], connected: [], default: {} })
          // The merged config also holds a company's servers, which must not be copied into the user's file.
          if (pathname === "/config") return Response.json({ local: { endpoints: ["https://company.example.com"] } })
          if (pathname === "/global/config") return Response.json({ local: { endpoints: ["http://10.0.0.5:8000"] } })
          if (pathname.startsWith("/auth/")) return Response.json(false)
          throw new Error(`Unexpected request: ${request.method} ${pathname}`)
        },
        { preconnect() {} },
      ),
    })
    const result = validateCustomProvider({ form: applyServer(empty(), OLLAMA).form, t }).result!
    await saveCustomProvider({
      client,
      result,
      conflictMessage: "Choose a different ID",
      updateConfig: async (config) => {
        updates.push(config)
      },
    })
    expect(requests).toContain("GET /global/config")
    expect(updates).toEqual([
      {
        provider: { ollama: result.config },
        local: {
          endpoints: ["http://10.0.0.5:8000", "http://127.0.0.1:11434"],
          pins: { "http://127.0.0.1:11434": { kind: "ollama", version: "0.12.6", models: "sha256:abc" } },
        },
      },
    ])
  })

  test("through the Local API, writes the provider alone and lists the server only once the owner agrees", async () => {
    const client = createVectorClient({
      baseUrl: "http://fixture.test",
      fetch: Object.assign(
        async (source: RequestInfo | URL, init?: RequestInit) => {
          const request = source instanceof Request ? source : new Request(source, init)
          const pathname = new URL(request.url).pathname
          if (pathname === "/provider") return Response.json({ all: [], connected: [], default: {} })
          if (pathname === "/config") return Response.json({})
          if (pathname.startsWith("/auth/")) return Response.json(false)
          throw new Error(`Unexpected request: ${request.method} ${pathname}`)
        },
        { preconnect() {} },
      ),
    })
    const result = validateCustomProvider({ form: applyServer(empty(), OLLAMA).form, t }).result!
    const save = async (agree: boolean) => {
      const updates: Config[] = []
      const listed: unknown[] = []
      const saved = await saveCustomProvider({
        client,
        result,
        conflictMessage: "Choose a different ID",
        updateConfig: async (config) => {
          updates.push(config)
        },
        list: async (server) => {
          listed.push(listServer(server))
          return agree
        },
      })
      return { updates, listed, saved }
    }
    const agreed = await save(true)
    // The list never goes through the config file, which would only hold it while Vector Local is on.
    expect(agreed.updates).toEqual([{ provider: { ollama: result.config } }])
    expect(agreed.listed).toEqual([
      {
        endpoints: { add: ["http://127.0.0.1:11434"] },
        pins: { "http://127.0.0.1:11434": { kind: "ollama", version: "0.12.6", models: "sha256:abc" } },
      },
    ])
    expect(agreed.saved).toEqual({ listed: true })
    expect((await save(false)).saved).toEqual({ listed: false })
  })
})
