import { LayerNode } from "@vectordevai/core/effect/layer-node"
import path from "path"
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto"
import { Effect, Layer, Option, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@vectordevai/core/schema"
import { Global } from "@vectordevai/core/global"
import { FSUtil } from "@vectordevai/core/fs-util"
import { EffectFlock } from "@vectordevai/core/util/effect-flock"

export const OAUTH_DUMMY_KEY = "vector-oauth-dummy-key"

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
  clientId: Schema.optional(Schema.String),
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

export class AuthExistsError extends Schema.TaggedErrorClass<AuthExistsError>()("AuthExistsError", {
  providerID: Schema.String,
}) {
  override get message() {
    return `A credential already exists for ${this.providerID}. Choose a different provider ID.`
  }
}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly exists: (key: string) => Effect.Effect<boolean, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly create: (key: string, info: Info) => Effect.Effect<void, AuthError | AuthExistsError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@vector/Auth") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service
    const lock = () =>
      flock.acquire(`auth:${file}`, path.dirname(file)).pipe(Effect.mapError(fail("Failed to lock auth data")))

    const writeStored = Effect.fn("Auth.writeStored")(function* (data: string) {
      const temporary = `${file}.${randomUUID()}.tmp`
      yield* fsys
        .writeWithDirs(temporary, data, 0o600)
        .pipe(
          Effect.andThen(fsys.rename(temporary, file)),
          Effect.ensuring(fsys.remove(temporary, { force: true }).pipe(Effect.ignore)),
          Effect.mapError(fail("Failed to write auth data")),
        )
    })

    const read = Effect.fn("Auth.read")(function* () {
      const raw = yield* fsys.readFileStringSafe(file).pipe(Effect.mapError(fail("Failed to read auth data")))
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
        yield* writeStored(migrated)
      }
      return data
    })

    const contents = Effect.fn("Auth.contents")(function* () {
      if (process.env.VECTOR_AUTH_CONTENT) {
        const parsed = Option.getOrUndefined(decodeJson(process.env.VECTOR_AUTH_CONTENT))
        if (parsed) return decodeAuthData(parsed)
      }

      return yield* read()
    })

    const all = Effect.fn("Auth.all")(function* () {
      yield* lock()
      return yield* contents()
    }, Effect.scoped)

    const write = Effect.fn("Auth.write")(function* (data: Record<string, Info>) {
      const encoded = yield* Effect.try({
        try: () => encodeStoredAuth(data),
        catch: fail("Failed to encrypt auth data"),
      })
      yield* writeStored(encoded)
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const exists = Effect.fn("Auth.exists")(function* (key: string) {
      yield* lock()
      const norm = key.replace(/\/+$/, "")
      const data = { ...(yield* read()), ...(yield* contents()) }
      return Object.keys(data).some((id) => id.replace(/\/+$/, "") === norm)
    }, Effect.scoped)

    const replace = Effect.fn("Auth.replace")(function* (key: string, info: Info, data: Record<string, Info>) {
      const norm = key.replace(/\/+$/, "")
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      yield* write({ ...data, [norm]: info })
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      yield* lock()
      yield* replace(key, info, yield* contents())
    }, Effect.scoped)

    const create = Effect.fn("Auth.create")(function* (key: string, info: Info) {
      yield* lock()
      const norm = key.replace(/\/+$/, "")
      // Include stored credentials even when runtime auth is supplied through the environment.
      const data = { ...(yield* read()), ...(yield* contents()) }
      if (Object.keys(data).some((id) => id.replace(/\/+$/, "") === norm)) {
        return yield* new AuthExistsError({ providerID: norm })
      }
      yield* replace(key, info, data)
    }, Effect.scoped)

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      yield* lock()
      const norm = key.replace(/\/+$/, "")
      const data = yield* contents()
      delete data[key]
      delete data[norm]
      yield* write(data)
    }, Effect.scoped)

    return Service.of({ get, all, exists, set, create, remove })
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

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node, EffectFlock.node] })

export * as Auth from "."
