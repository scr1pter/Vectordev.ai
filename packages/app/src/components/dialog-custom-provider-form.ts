import type { LocalProbe } from "@vectordevai/core/local-mode/probe"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { providerAllowed, providerEnabled } from "@vectordevai/schema/provider-policy"

const PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/
const OPENAI_COMPATIBLE = "@ai-sdk/openai-compatible"

type Translator = (key: string, vars?: Record<string, string | number | boolean>) => string

export type ModelErr = {
  id?: string
  name?: string
  context?: string
  output?: string
}

export type HeaderErr = {
  key?: string
  value?: string
}

export type ModelRow = {
  row: string
  id: string
  name: string
  /** Tokens of context the server runs the model with; empty when unknown. */
  context?: string
  /** The reply limit; empty takes a quarter of the context, at most 8,192. */
  output?: string
  /** Whether the model calls tools; undefined leaves it to Check models. */
  tools?: boolean
  /** Whether it reads images. */
  vision?: boolean
  err: ModelErr
}

export type HeaderRow = {
  row: string
  key: string
  value: string
  err: HeaderErr
}

export type FormState = {
  providerID: string
  name: string
  baseURL: string
  apiKey: string
  models: ModelRow[]
  headers: HeaderRow[]
  /** The kind of server a preset or Detect chose. */
  kind?: LocalProbe.Kind
  /** How many requests the server takes at once; empty leaves it unlimited. */
  concurrency?: string
  /** The server Detect or Identify read at this address, whose identity Vector pins when the provider is saved. */
  server?: LocalProbe.Server
  err: {
    providerID?: string
    name?: string
    baseURL?: string
    concurrency?: string
  }
}

type ValidateArgs = {
  form: FormState
  t: Translator
  existing?: readonly string[]
}

export type Preset = {
  readonly kind: LocalProbe.Kind
  readonly label: string
  /** The provider ID it suggests; another is picked when that one is taken. */
  readonly providerID: string
  readonly name: string
  readonly baseURL: string
  /** How many requests the server takes at once by default; llama.cpp's comes from its slots once it is found. */
  readonly concurrency?: number
}

// Servers people host on their own computer or network, at their usual addresses. The IDs avoid the catalog's own
// providers (the catalog already has one called lmstudio), and Detect fills in what the server reports.
export const PRESETS: readonly Preset[] = [
  {
    kind: "ollama",
    label: "Ollama",
    providerID: "ollama",
    name: "Ollama",
    baseURL: "http://127.0.0.1:11434/v1",
    concurrency: 1,
  },
  {
    kind: "lmstudio",
    label: "LM Studio",
    providerID: "lm-studio",
    name: "LM Studio",
    baseURL: "http://127.0.0.1:1234/v1",
    concurrency: 1,
  },
  {
    kind: "vllm",
    label: "vLLM",
    providerID: "vllm",
    name: "vLLM",
    baseURL: "http://127.0.0.1:8000/v1",
    concurrency: 4,
  },
  {
    kind: "llamacpp",
    label: "llama.cpp",
    providerID: "llama-cpp",
    name: "llama.cpp",
    baseURL: "http://127.0.0.1:8080/v1",
  },
  {
    kind: "sglang",
    label: "SGLang",
    providerID: "sglang",
    name: "SGLang",
    baseURL: "http://127.0.0.1:30000/v1",
    concurrency: 4,
  },
  { kind: "openai", label: "Other", providerID: "", name: "", baseURL: "" },
]

export const COPY = {
  notEncrypted: "Not encrypted: prompts to this server travel in plain text on your network.",
  forwarding:
    "This server may pass your prompts or queries on to services it is set up to use. Vector can't see past it.",
  sharedMachine: "Another user on this computer could run a server on this port.",
  cloudModels: (count: number) =>
    `Left out ${count} cloud ${count === 1 ? "model" : "models"}: Ollama sends their prompts to ollama.com.`,
  unknownContext: "Context unknown: set it here, or Vector's agent will refuse this model on a server you host.",
  changedAddress: "This address is not the server Vector found. Find it again to pin its identity.",
} as const

/** The labels for the address being added: "Not encrypted" for plain http off this computer. */
export function labels(form: Pick<FormState, "baseURL" | "server">) {
  const url = URL.canParse(form.baseURL.trim()) ? new URL(form.baseURL.trim()) : undefined
  const place = url ? LocalPolicy.hostClass(url.hostname) : undefined
  const server = found(form)
  return {
    /** On this computer or the user's network, where Vector's agent needs each model's context to be known. */
    hosted: place !== undefined && place !== "internet",
    notEncrypted: url?.protocol === "http:" && place !== "this-computer",
    sharedMachine: place === "this-computer" && server !== undefined,
    forwarding: server?.forwards !== undefined,
    /** "Ollama 0.12.6 on this computer": who answered at this address, when Detect or Identify read it. */
    identity: server ? identity(server) : undefined,
    changedAddress: form.server !== undefined && server === undefined,
  }
}

const PLACES = {
  "this-computer": "on this computer",
  "your-network": "on your network",
  internet: "on the internet",
} as const

export function identity(server: Pick<LocalProbe.Server, "name" | "version" | "class">) {
  return [server.name, server.version, PLACES[server.class]].filter(Boolean).join(" ")
}

// The server Detect read, while the address still points at it.
function found(form: Pick<FormState, "baseURL" | "server">) {
  if (!form.server) return undefined
  const typed = URL.canParse(form.baseURL.trim()) ? LocalPolicy.origin(form.baseURL.trim()) : undefined
  return typed === form.server.origin ? form.server : undefined
}

/** A provider ID based on `base` that nothing else uses: ollama, then ollama-2, ollama-3… */
export function freeID(base: string, existing: readonly string[] = []) {
  if (!base) return ""
  const taken = (id: string) => providerAllowed(id) || existing.includes(id)
  if (!taken(base)) return base
  return Array.from({ length: 98 }, (_, index) => `${base}-${index + 2}`).find((id) => !taken(id)) ?? ""
}

/** The form with a preset's address and defaults, keeping anything the user already typed in the other fields. */
export function applyPreset(form: FormState, preset: Preset, existing: readonly string[] = []): FormState {
  return {
    ...form,
    kind: preset.kind,
    providerID: form.providerID || freeID(preset.providerID, existing),
    name: form.name || preset.name,
    baseURL: preset.baseURL || form.baseURL,
    concurrency: preset.concurrency ? String(preset.concurrency) : "",
    server: undefined,
    err: {},
  }
}

/**
 * The form filled from a server Detect or Identify read: its address, how many requests it takes, and one row per
 * model with the context, tools and image support the server reports. Cloud models are left out.
 */
export function applyServer(form: FormState, server: LocalProbe.Server, existing: readonly string[] = []) {
  const preset = PRESETS.find((item) => item.kind === server.kind)
  const models = server.models.filter((model) => !model.cloud)
  return {
    form: {
      ...form,
      kind: server.kind,
      providerID: form.providerID || freeID(preset?.providerID ?? "", existing),
      name: form.name || server.name,
      baseURL: server.baseURL,
      concurrency: server.concurrency ? String(server.concurrency) : "",
      server,
      models: models.length
        ? models.map((model) => ({
            ...modelRow(),
            id: model.id,
            name: model.id,
            context: model.context ? String(model.context) : "",
            output: model.output ? String(model.output) : "",
            tools: model.tools,
            vision: model.vision,
          }))
        : form.models,
      err: {},
    } satisfies FormState,
    skipped: server.models.length - models.length,
  }
}

/** The reply limit for a context: a quarter of it and at most 8,192 tokens, as Check models writes it (core's LocalProbe.output). */
export function defaultOutput(context: number) {
  return Math.max(1, Math.min(8192, Math.floor(context / 4)))
}

const WHOLE = /^\d+$/

export function validateCustomProvider(input: ValidateArgs) {
  const providerID = input.form.providerID.trim()
  const name = input.form.name.trim()
  const baseURL = input.form.baseURL.trim()
  const apiKey = input.form.apiKey.trim()
  const concurrency = input.form.concurrency?.trim() ?? ""

  const env = apiKey.match(/^\{env:([^}]+)\}$/)?.[1]?.trim()
  const key = apiKey && !env ? apiKey : undefined

  const idError = !providerID
    ? input.t("provider.custom.error.providerID.required")
    : !providerEnabled(providerID)
      ? input.t("provider.connect.unavailable", { provider: providerID })
      : providerAllowed(providerID) || input.existing?.includes(providerID)
        ? input.t("provider.custom.error.providerID.exists")
        : !PROVIDER_ID.test(providerID)
          ? input.t("provider.custom.error.providerID.format")
          : undefined

  const nameError = !name ? input.t("provider.custom.error.name.required") : undefined
  const urlError = !baseURL
    ? input.t("provider.custom.error.baseURL.required")
    : !/^https?:\/\//.test(baseURL)
      ? input.t("provider.custom.error.baseURL.format")
      : undefined
  const concurrencyError = concurrency && !positive(concurrency) ? "Use a whole number of 1 or more" : undefined

  const seenModels = new Set<string>()
  const models = input.form.models.map((m) => {
    const id = m.id.trim()
    const idError = !id
      ? input.t("provider.custom.error.required")
      : seenModels.has(id)
        ? input.t("provider.custom.error.duplicate")
        : (() => {
            seenModels.add(id)
            return undefined
          })()
    const nameError = !m.name.trim() ? input.t("provider.custom.error.required") : undefined
    const context = m.context?.trim() ?? ""
    const output = m.output?.trim() ?? ""
    const contextError = context && !positive(context) ? "Use a whole number of tokens" : undefined
    const outputError =
      output && !positive(output)
        ? "Use a whole number of tokens"
        : output && !context
          ? "Set the context too"
          : output && positive(context) && Number(output) > Number(context)
            ? "Must not be more than the context"
            : undefined
    return { id: idError, name: nameError, context: contextError, output: outputError }
  })
  const modelsValid = models.every((m) => !m.id && !m.name && !m.context && !m.output)
  const modelConfig = Object.fromEntries(input.form.models.map((m) => [m.id.trim(), modelConfigOf(m)]))

  const seenHeaders = new Set<string>()
  const headers = input.form.headers.map((h) => {
    const key = h.key.trim()
    const value = h.value.trim()

    if (!key && !value) return {}
    const keyError = !key
      ? input.t("provider.custom.error.required")
      : seenHeaders.has(key.toLowerCase())
        ? input.t("provider.custom.error.duplicate")
        : (() => {
            seenHeaders.add(key.toLowerCase())
            return undefined
          })()
    const valueError = !value ? input.t("provider.custom.error.required") : undefined
    return { key: keyError, value: valueError }
  })
  const headersValid = headers.every((h) => !h.key && !h.value)
  const headerConfig = Object.fromEntries(
    input.form.headers
      .map((h) => ({ key: h.key.trim(), value: h.value.trim() }))
      .filter((h) => !!h.key && !!h.value)
      .map((h) => [h.key, h.value]),
  )

  const err = {
    providerID: idError,
    name: nameError,
    baseURL: urlError,
    concurrency: concurrencyError,
  }

  const ok = !idError && !nameError && !urlError && !concurrencyError && modelsValid && headersValid
  if (!ok) return { err, models, headers }

  const server = found(input.form)
  return {
    err,
    models,
    headers,
    result: {
      providerID,
      name,
      key,
      config: {
        npm: OPENAI_COMPATIBLE,
        name,
        ...(env ? { env: [env] } : {}),
        options: {
          baseURL,
          ...(Object.keys(headerConfig).length ? { headers: headerConfig } : {}),
          ...(concurrency ? { concurrency: Number(concurrency) } : {}),
        },
        models: modelConfig,
      },
      // A server Vector read at this address goes on the model server list with the identity it answered with.
      ...(server ? { local: { origin: server.origin, pin: server.pin } } : {}),
    },
  }
}

function positive(text: string) {
  return WHOLE.test(text) && Number(text) >= 1
}

function modelConfigOf(m: ModelRow) {
  const context = m.context?.trim() ? Number(m.context.trim()) : undefined
  const output = m.output?.trim() ? Number(m.output.trim()) : undefined
  return {
    name: m.name.trim(),
    ...(m.tools === undefined ? {} : { tool_call: m.tools }),
    ...(context ? { limit: { context, output: output ?? defaultOutput(context) } } : {}),
    ...(m.vision === undefined ? {} : { modalities: modalities(m.vision) }),
  }
}

function modalities(vision: boolean): { input: ("text" | "image")[]; output: "text"[] } {
  return { input: vision ? ["text", "image"] : ["text"], output: ["text"] }
}

let row = 0

const nextRow = () => `row-${row++}`

export const modelRow = (): ModelRow => ({ row: nextRow(), id: "", name: "", err: {} })
export const headerRow = (): HeaderRow => ({ row: nextRow(), key: "", value: "", err: {} })
