export * as FreeModels from "./free-models"

import path from "node:path"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { Context, Effect, Layer, Option, Schema } from "effect"
import {
  FreeModelCatalog,
  FreeModelInfo,
  FREE_MODEL_FALLBACKS,
  FreeModelsLimitError,
  parseFreeModelLimit,
} from "@vectordevai/schema/free-model"
import { Integration } from "@vectordevai/schema/integration"
import { Credential } from "./credential"
import { Flag } from "./flag/flag"
import { Global } from "./global"
import { VectorAccount } from "./vector-account"
import { makeGlobalNode } from "./effect/app-node"
import { FreeModelMetadata, eligibleFreeModel, freeModelInfo, isFreeModelID } from "./free-model-catalog"

export const CATALOG_URL = "https://vectordev.ai/api/free-models/models"
export const SHARED_CHAT_URL = "https://vectordev.ai/api/free-models/chat"
export const OPENROUTER_ROOT = "https://openrouter.ai/api/v1"
export const OPENROUTER_CHAT_URL = `${OPENROUTER_ROOT}/chat/completions`
const OFF: FreeModelCatalog = { enabled: false, updatedAt: 0, models: [] }
const TTL = 5 * 60_000

const MetadataList = Schema.Struct({ data: Schema.Array(Schema.Unknown) })

export function createClient(
  input: {
    file?: string
    request?: (url: string, init: RequestInit) => Promise<Response>
    now?: () => number
    disabled?: () => boolean
    /** How long a non-forced catalog read waits for vectordev.ai before answering without it. */
    wait?: number
  } = {},
) {
  const now = input.now ?? Date.now
  const request = input.request ?? fetch
  const state: { value?: FreeModelCatalog; expires: number; pending?: Promise<FreeModelCatalog> } = { expires: 0 }
  const users = new Map<string, { expires: number; models: FreeModelInfo[] }>()
  const catalog = async (force = false): Promise<FreeModelCatalog> => {
    if (!force && state.value && state.expires > now()) return state.value
    const saved =
      state.value ??
      (input.file
        ? await readFile(input.file, "utf8")
            .then((text) =>
              Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(FreeModelCatalog))(text)),
            )
            .catch(() => undefined)
        : undefined)
    const refresh = state.pending ?? load(saved)
    if (force) return refresh
    // Provider loading and every free-model chat wait here, so they must never stall on vectordev.ai.
    // A known OFF answer is served at once while the refresh lands for the next caller. Otherwise the
    // wait is short and then serves the last catalog seen, stale, or OFF on a first run; only a request
    // that actually fails falls back to the reviewed list, inside load().
    if (saved && !saved.enabled) return OFF
    return Promise.race([
      refresh,
      new Promise<FreeModelCatalog>((resolve) => setTimeout(() => resolve(saved ?? OFF), input.wait ?? 1_500).unref()),
    ])
  }
  const load = (saved: FreeModelCatalog | undefined) => {
    const pending = (async () => {
      const response = input.disabled?.()
        ? undefined
        : await request(CATALOG_URL, {
            redirect: "error",
            signal: AbortSignal.timeout(8_000),
            headers: { accept: "application/json" },
          }).catch(() => undefined)
      const parsed = response?.ok
        ? Option.getOrUndefined(
            Schema.decodeUnknownOption(FreeModelCatalog)(await response.json().catch(() => undefined)),
          )
        : undefined
      const valid =
        parsed &&
        (!parsed.enabled ||
          parsed.models.every(
            (model) =>
              isFreeModelID(model.id) &&
              Number.isSafeInteger(model.contextLength) &&
              model.contextLength > 0 &&
              Number.isSafeInteger(model.maxOutputTokens) &&
              model.maxOutputTokens > 0 &&
              model.providers.length > 0 &&
              model.providers.every((provider) => !!provider.id.trim()),
          ))
      const value = valid ? (parsed.enabled ? parsed : OFF) : unreachable(saved)
      state.value = value
      state.expires = now() + TTL
      if (input.file && valid) {
        const file = input.file
        const temporary = `${file}.${randomUUID()}.tmp`
        // This optional cache must not block provider startup or discard an explicit OFF response.
        await mkdir(path.dirname(file), { recursive: true })
          .then(() => writeFile(temporary, JSON.stringify(value), { mode: 0o600 }))
          .then(() => rename(temporary, file))
          .catch(() => rm(temporary, { force: true }).catch(() => undefined))
      }
      return value
    })().finally(() => {
      state.pending = undefined
    })
    state.pending = pending
    return pending
  }
  const forKey = async (key: string, force = false) => {
    if (!key || input.disabled?.()) return []
    const digest = createHash("sha256").update(key).digest("hex")
    const cached = users.get(digest)
    if (!force && cached && cached.expires > now()) return cached.models
    // Personal access depends only on OpenRouter, not the optional hosted shared allowance.
    const read = async <T>(url: string, schema: Schema.Decoder<T>, authenticated = false) => {
      const response = await request(url, {
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
        headers: authenticated
          ? {
              Authorization: `Bearer ${key}`,
              "HTTP-Referer": "https://vectordev.ai/",
              "X-OpenRouter-Title": "Vector",
            }
          : { accept: "application/json" },
      }).catch(() => undefined)
      return response?.ok
        ? Option.getOrUndefined(Schema.decodeUnknownOption(schema)(await response.json().catch(() => undefined)))
        : undefined
    }
    const [available, endpoints] = await Promise.all([
      read(`${OPENROUTER_ROOT}/models/user`, MetadataList, true),
      read(`${OPENROUTER_ROOT}/endpoints/zdr`, MetadataList),
    ])
    // A rejected key or changed price/privacy policy must never revive stale models.
    if (!available || !endpoints) {
      users.delete(digest)
      return []
    }
    const candidates = available.data.flatMap((value) => {
      const model = Schema.decodeUnknownOption(FreeModelMetadata)(value)
      return Option.isSome(model) && eligibleFreeModel(model.value, now()) ? [model.value] : []
    })
    const models = candidates
      .map((model) => freeModelInfo(model, endpoints.data, { zdr: true }))
      .filter((model): model is FreeModelInfo => model !== undefined)
      .sort((a, b) => b.contextLength - a.contextLength || a.id.localeCompare(b.id))
    users.set(digest, { expires: now() + TTL, models })
    return models
  }
  return { catalog, forKey }
}

/** The catalog to use when vectordev.ai cannot answer: the reviewed fallbacks only if free models were last seen on. */
function unreachable(saved: FreeModelCatalog | undefined): FreeModelCatalog {
  if (!saved?.enabled) return OFF
  return { enabled: true, updatedAt: saved.updatedAt, models: [...FREE_MODEL_FALLBACKS] }
}

export class Service extends Context.Service<
  Service,
  {
    readonly catalog: (force?: boolean) => Effect.Effect<FreeModelCatalog>
    readonly forKey: (key: string, force?: boolean) => Effect.Effect<FreeModelInfo[]>
  }
>()("@vector/FreeModels") {}

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.sync(Service, () => {
    const client = createClient({
      file: path.join(Global.Path.cache, "free-models.json"),
      disabled: () => Flag.VECTOR_DISABLE_MODELS_FETCH,
    })
    return Service.of({
      catalog: (force) => Effect.promise(() => client.catalog(force)),
      forKey: (key, force) => Effect.promise(() => client.forKey(key, force)),
    })
  }),
  deps: [],
})

export class CredentialsService extends Context.Service<
  CredentialsService,
  {
    readonly get: (provider: "vector" | "openrouter") => Effect.Effect<string | undefined>
  }
>()("@vector/FreeModelCredentials") {}

export const credentialsNode = makeGlobalNode({
  service: CredentialsService,
  layer: Layer.effect(
    CredentialsService,
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      return CredentialsService.of({
        get: Effect.fn("FreeModels.credential")(function* (provider) {
          const environment = process.env[provider === "vector" ? "VECTOR_CLI_TOKEN" : "OPENROUTER_API_KEY"]
          if (environment) return environment
          const stored = (yield* credentials.list(Integration.ID.make(provider))).find(
            (item) => item.value.type === "key",
          )
          if (stored?.value.type === "key") return stored.value.key
          if (provider === "vector") return yield* Effect.promise(() => VectorAccount.readVectorToken())
          return undefined
        }),
      })
    }),
  ),
  deps: [Credential.node],
})

export async function resolveRoute(input: {
  provider: "vector" | "openrouter"
  modelID: string
  catalog: () => Promise<FreeModelCatalog>
  forKey: (key: string) => Promise<FreeModelInfo[]>
  credential: (provider: "vector" | "openrouter") => Promise<string | undefined>
}) {
  const ownKey = await input.credential("openrouter")
  if (ownKey) {
    const models = await input.forKey(ownKey)
    if (!models.some((model) => model.id === input.modelID))
      throw new Error(
        "This free model is unavailable for your OpenRouter account or privacy settings. Choose another free model.",
      )
    return { url: OPENROUTER_CHAT_URL, key: ownKey, models, source: "openrouter" as const }
  }
  if (input.provider === "openrouter") throw new Error("Connect OpenRouter to use your own free allowance.")
  const catalog = await input.catalog()
  if (!catalog.enabled || !catalog.models.some((model) => model.id === input.modelID))
    throw new Error("That free model is unavailable. Choose another model in Vector.")
  const token = await input.credential("vector")
  if (!token) throw new Error("Sign in to Vector to use the shared free allowance, or connect OpenRouter.")
  return { url: SHARED_CHAT_URL, key: token, models: catalog.models, source: "shared" as const }
}

/** Preserve quota metadata before compatible SDKs reduce an SSE error to its message string. */
export function preserveLimit(response: Response) {
  if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream"))
    return response
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const state = { pending: "" }
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  const emit = (frame: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    const limit = parseFreeModelLimit(data)
    if (limit) throw new FreeModelsLimitError({ reason: limit.reason, resetAt: limit.resetAt, message: limit.message })
    controller.enqueue(encoder.encode(frame))
  }
  return new Response(
    response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          state.pending += decoder.decode(chunk, { stream: true })
          if (state.pending.length > 4_500_000) throw new Error("The free model returned an oversized stream event.")
          const frames = state.pending.split(/(\r?\n\r?\n)/)
          state.pending = frames.pop() ?? ""
          for (let index = 0; index < frames.length; index += 2) emit(frames[index] + frames[index + 1], controller)
        },
        flush(controller) {
          state.pending += decoder.decode()
          if (state.pending) emit(state.pending, controller)
        },
      }),
    ),
    { status: response.status, statusText: response.statusText, headers },
  )
}
