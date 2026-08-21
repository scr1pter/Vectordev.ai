import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { Effect, Layer, Option, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const EncryptedAuthData = Schema.Struct({
  version: Schema.Literal(1),
  iv: Schema.String,
  tag: Schema.String,
  ciphertext: Schema.String,
})
const decodeEncryptedAuthData = Schema.decodeUnknownOption(EncryptedAuthData)

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>
const decodeInfo = Schema.decodeUnknownOption(Info)

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service

    const read = Effect.fn("Auth.read")(function* () {
      const raw = yield* fsys.readFileStringSafe(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!raw) return {}
      const data = yield* Effect.try({
        try: () => decodeStoredAuth(raw),
        catch: fail("Failed to read encrypted auth data"),
      })
      if (credentialKey() && !storedAuthIsEncrypted(raw)) {
        const migrated = yield* Effect.try({
          try: () => encodeStoredAuth(data),
          catch: fail("Failed to encrypt legacy auth data"),
        })
        yield* fsys.writeWithDirs(file, migrated, 0o600).pipe(Effect.mapError(fail("Failed to migrate auth data")))
      }
      return data
    })

    const all = Effect.fn("Auth.all")(function* () {
      if (process.env.OPENCODE_AUTH_CONTENT) {
        const parsed = Option.getOrUndefined(decodeJson(process.env.OPENCODE_AUTH_CONTENT))
        if (parsed) return decodeAuthData(parsed)
      }

      return yield* read()
    })

    const write = Effect.fn("Auth.write")(function* (data: Record<string, Info>) {
      const encoded = yield* Effect.try({
        try: () => encodeStoredAuth(data),
        catch: fail("Failed to encrypt auth data"),
      })
      yield* fsys.writeWithDirs(file, encoded, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      yield* write({ ...data, [norm]: info })
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      delete data[key]
      delete data[norm]
      yield* write(data)
    })

    return Service.of({ get, all, set, remove })
  }),
)

function credentialKey() {
  const raw = process.env.VECTOR_CREDENTIAL_KEY
  if (!raw) return
  const key = Buffer.from(raw, "base64")
  if (key.byteLength === 32) return key
}

function decodeAuthData(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  return Record.filterMap(input as Record<string, unknown>, (value) =>
    Result.fromOption(decodeInfo(value), () => undefined),
  )
}

function decodeStoredAuth(raw: string, key = credentialKey()) {
  const parsed = Option.getOrUndefined(decodeJson(raw))
  if (!parsed) return {}
  const encrypted = Option.getOrUndefined(decodeEncryptedAuthData(parsed))
  if (!encrypted) return decodeAuthData(parsed)
  if (!key) throw new Error("Provider credentials require Vector's secure runtime vault.")
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"))
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"))
    return decodeAuthData(
      Option.getOrUndefined(
        decodeJson(
          Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64")), decipher.final()]).toString(
            "utf8",
          ),
        ),
      ),
    )
  } catch (error) {
    throw new Error("Vector could not decrypt the provider credential store.", { cause: error })
  }
}

function storedAuthIsEncrypted(raw: string) {
  const parsed = Option.getOrUndefined(decodeJson(raw))
  return parsed ? Option.isSome(decodeEncryptedAuthData(parsed)) : false
}

function encodeStoredAuth(data: Record<string, Info>, key = credentialKey()) {
  if (!key) {
    if (process.env.VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE === "1" && Object.keys(data).length > 0) {
      throw new Error("Provider credentials require Vector's secure runtime vault.")
    }
    return JSON.stringify(data, null, 2)
  }
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

export const AuthStorage = {
  decode: decodeStoredAuth,
  encode: encodeStoredAuth,
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node] })

export * as Auth from "."
