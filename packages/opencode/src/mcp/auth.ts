import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Global } from "@opencode-ai/core/global"
import { Effect, Layer, Context, Option, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"

export const Tokens = Schema.Struct({
  accessToken: Schema.mutableKey(Schema.String),
  refreshToken: Schema.mutableKey(Schema.optional(Schema.String)),
  expiresAt: Schema.mutableKey(Schema.optional(Schema.Number)),
  scope: Schema.mutableKey(Schema.optional(Schema.String)),
})
export type Tokens = Schema.Schema.Type<typeof Tokens>

export const ClientInfo = Schema.Struct({
  clientId: Schema.mutableKey(Schema.String),
  clientSecret: Schema.mutableKey(Schema.optional(Schema.String)),
  clientIdIssuedAt: Schema.mutableKey(Schema.optional(Schema.Number)),
  clientSecretExpiresAt: Schema.mutableKey(Schema.optional(Schema.Number)),
})
export type ClientInfo = Schema.Schema.Type<typeof ClientInfo>

export const Entry = Schema.Struct({
  tokens: Schema.mutableKey(Schema.optional(Tokens)),
  clientInfo: Schema.mutableKey(Schema.optional(ClientInfo)),
  codeVerifier: Schema.mutableKey(Schema.optional(Schema.String)),
  oauthState: Schema.mutableKey(Schema.optional(Schema.String)),
  serverUrl: Schema.mutableKey(Schema.optional(Schema.String)),
})
export type Entry = Schema.Schema.Type<typeof Entry>

const decodeAuthData = Schema.decodeUnknownOption(Schema.Record(Schema.String, Entry))
type AuthData = Record<string, Entry>
const EncryptedAuthData = Schema.Struct({
  version: Schema.Literal(1),
  iv: Schema.String,
  tag: Schema.String,
  ciphertext: Schema.String,
})
const decodeEncryptedAuthData = Schema.decodeUnknownOption(EncryptedAuthData)
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

const filepath = path.join(Global.Path.data, "mcp-auth.json")
const lockKey = `mcp-auth:${filepath}`

export interface Interface {
  readonly all: () => Effect.Effect<Record<string, Entry>>
  readonly get: (mcpName: string) => Effect.Effect<Entry | undefined>
  readonly getForUrl: (mcpName: string, serverUrl: string) => Effect.Effect<Entry | undefined>
  readonly set: (mcpName: string, entry: Entry, serverUrl?: string) => Effect.Effect<void>
  readonly remove: (mcpName: string) => Effect.Effect<void>
  readonly updateTokens: (mcpName: string, tokens: Tokens, serverUrl?: string) => Effect.Effect<void>
  readonly updateClientInfo: (mcpName: string, clientInfo: ClientInfo, serverUrl?: string) => Effect.Effect<void>
  readonly updateCodeVerifier: (mcpName: string, codeVerifier: string) => Effect.Effect<void>
  readonly clearCodeVerifier: (mcpName: string) => Effect.Effect<void>
  readonly updateOAuthState: (mcpName: string, oauthState: string) => Effect.Effect<void>
  readonly getOAuthState: (mcpName: string) => Effect.Effect<string | undefined>
  readonly clearOAuthState: (mcpName: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/McpAuth") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service

    const read = Effect.fn("McpAuth.read")(function* () {
      const raw = yield* fs.readFileStringSafe(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!raw) return {} as AuthData
      const data = decodeStored(raw)
      if (encryptionKey() && !storedIsEncrypted(raw)) {
        yield* fs.writeWithDirs(filepath, encodeStored(data), 0o600).pipe(Effect.orDie)
      }
      return data
    })

    const all = Effect.fn("McpAuth.all")(function* () {
      return yield* read().pipe(flock.withLock(lockKey), Effect.orDie)
    })

    const mutate = Effect.fn("McpAuth.mutate")(function* (update: (data: AuthData) => AuthData | undefined) {
      yield* Effect.gen(function* () {
        const next = update(yield* read())
        if (!next) return
        yield* fs.writeWithDirs(filepath, encodeStored(next), 0o600).pipe(Effect.orDie)
      }).pipe(flock.withLock(lockKey), Effect.orDie)
    })

    const get = Effect.fn("McpAuth.get")(function* (mcpName: string) {
      const data = yield* all()
      return data[mcpName]
    })

    const getForUrl = Effect.fn("McpAuth.getForUrl")(function* (mcpName: string, serverUrl: string) {
      const entry = yield* get(mcpName)
      if (!entry) return undefined
      if (!entry.serverUrl) return undefined
      if (entry.serverUrl !== serverUrl) return undefined
      return entry
    })

    const set = Effect.fn("McpAuth.set")(function* (mcpName: string, entry: Entry, serverUrl?: string) {
      yield* mutate((data) => ({
        ...data,
        [mcpName]: serverUrl ? { ...entry, serverUrl } : entry,
      }))
    })

    const remove = Effect.fn("McpAuth.remove")(function* (mcpName: string) {
      yield* mutate((data) => {
        const next = { ...data }
        delete next[mcpName]
        return next
      })
    })

    const updateField = <K extends keyof Entry>(field: K, spanName: string) =>
      Effect.fn(`McpAuth.${spanName}`)(function* (mcpName: string, value: NonNullable<Entry[K]>, serverUrl?: string) {
        yield* mutate((data) => {
          const entry = data[mcpName] ?? {}
          entry[field] = value
          if (serverUrl) entry.serverUrl = serverUrl
          return { ...data, [mcpName]: entry }
        })
      })

    const clearField = (field: keyof Entry, spanName: string) =>
      Effect.fn(`McpAuth.${spanName}`)(function* (mcpName: string) {
        yield* mutate((data) => {
          const entry = data[mcpName]
          if (!entry) return undefined
          delete entry[field]
          return { ...data, [mcpName]: entry }
        })
      })

    const updateTokens = updateField("tokens", "updateTokens")
    const updateClientInfo = updateField("clientInfo", "updateClientInfo")
    const updateCodeVerifier = updateField("codeVerifier", "updateCodeVerifier")
    const updateOAuthState = updateField("oauthState", "updateOAuthState")
    const clearCodeVerifier = clearField("codeVerifier", "clearCodeVerifier")
    const clearOAuthState = clearField("oauthState", "clearOAuthState")

    const getOAuthState = Effect.fn("McpAuth.getOAuthState")(function* (mcpName: string) {
      const entry = yield* get(mcpName)
      return entry?.oauthState
    })

    return Service.of({
      all,
      get,
      getForUrl,
      set,
      remove,
      updateTokens,
      updateClientInfo,
      updateCodeVerifier,
      clearCodeVerifier,
      updateOAuthState,
      getOAuthState,
      clearOAuthState,
    })
  }),
)

function encryptionKey() {
  const raw = process.env.VECTOR_CREDENTIAL_KEY ?? process.env.VECTOR_MCP_AUTH_KEY
  if (!raw) return
  const key = Buffer.from(raw, "base64")
  if (key.byteLength === 32) return key
}

function decodeStored(raw: string, key = encryptionKey()): AuthData {
  const parsed = Option.getOrUndefined(decodeJson(raw))
  if (!parsed) return {}
  const encrypted = Option.getOrUndefined(decodeEncryptedAuthData(parsed))
  if (!encrypted) return Option.getOrElse(decodeAuthData(parsed), () => ({}))
  if (!key) throw new Error("MCP OAuth credentials require Vector's secure runtime vault.")
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"))
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"))
    const clear = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8")
    const data = Option.getOrUndefined(decodeJson(clear))
    return Option.getOrElse(decodeAuthData(data), () => ({}))
  } catch (error) {
    throw new Error("Vector could not decrypt the MCP OAuth credential store.", { cause: error })
  }
}

function storedIsEncrypted(raw: string) {
  const parsed = Option.getOrUndefined(decodeJson(raw))
  return parsed ? Option.isSome(decodeEncryptedAuthData(parsed)) : false
}

function encodeStored(data: AuthData, key = encryptionKey()) {
  if (!key) return JSON.stringify(data, null, 2)
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()])
  return JSON.stringify(
    {
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    },
    null,
    2,
  )
}

export const McpAuthStorage = {
  decode: decodeStored,
  encode: encodeStored,
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node, EffectFlock.node] })

export * as McpAuth from "./auth"
