export * as ServerAuth from "./auth"
export { unauthorizedMessage } from "@vectordevai/server/auth"

import { Flag } from "@vectordevai/core/flag/flag"
import { legacyName } from "@vectordevai/core/flag/legacy"
import { Config as EffectConfig, Context, Effect, Layer, Option, Redacted } from "effect"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

/** Which configured credential pair a request matched. */
export type Identity = "owner" | "guest"

// Guest fields are optional: owner-only configs (existing call sites, tests,
// and `@vectordevai/server`'s twin of this service) stay assignable.
export type Info = {
  readonly password: Option.Option<string>
  readonly username: string
  /** Also accepted as the owner username; set only while no username is configured. */
  readonly legacyUsername?: string
  readonly guestPassword?: Option.Option<string>
  readonly guestUsername?: string
}

export class Config extends Context.Service<Config, Info>()("@vector/ServerAuthConfig") {
  /** Provide already-parsed config, useful in tests. */
  static configLayer(input: Info) {
    return Layer.succeed(this, this.of(input))
  }

  /** Parse config once from the active Effect ConfigProvider and provide the service. */
  static get layer() {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const config = yield* EffectConfig.all({
          password: EffectConfig.string("VECTOR_SERVER_PASSWORD").pipe(EffectConfig.option),
          username: EffectConfig.string("VECTOR_SERVER_USERNAME").pipe(EffectConfig.option),
          guestPassword: EffectConfig.string("VECTOR_SERVER_GUEST_PASSWORD").pipe(EffectConfig.option),
          guestUsername: EffectConfig.string("VECTOR_SERVER_GUEST_USERNAME").pipe(EffectConfig.withDefault("guest")),
        })
        return Config.of({
          ...config,
          username: Option.getOrElse(config.username, () => "vector"),
          // The earlier product defaulted the owner username to its own name, and saved
          // connections and scripts still send it. The password is still required.
          legacyUsername: Option.isNone(config.username) ? legacyName : undefined,
        })
      }),
    )
  }
}

// Any configured credential turns authentication on. Reading only the owner
// password would leave a server started with just a guest password wide open —
// the opposite of what configuring a password means.
export function required(config: Info) {
  const set = (value: Option.Option<string> | undefined) =>
    Option.isSome(value ?? Option.none()) && (value as Option.Some<string>).value !== ""
  return set(config.password) || set(config.guestPassword)
}

/** The identity a credential pair matches, or undefined when it matches neither. */
export function identity(credentials: DecodedCredentials, config: Info): Identity | undefined {
  const password = Redacted.value(credentials.password)
  if (
    Option.isSome(config.password) &&
    config.password.value !== "" &&
    (credentials.username === config.username || credentials.username === config.legacyUsername) &&
    password === config.password.value
  )
    return "owner"
  const guestPassword = config.guestPassword ?? Option.none<string>()
  if (
    Option.isSome(guestPassword) &&
    guestPassword.value !== "" &&
    credentials.username === (config.guestUsername ?? "guest") &&
    password === guestPassword.value
  )
    return "guest"
  return undefined
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  return identity(credentials, config) !== undefined
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? Flag.VECTOR_SERVER_PASSWORD
  if (!password) return undefined

  const username = credentials?.username ?? Flag.VECTOR_SERVER_USERNAME ?? "vector"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
