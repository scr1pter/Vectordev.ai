import { configEnv, readEnv } from "@vectordevai/core/flag/compat"
export * as ServerAuth from "./auth"

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

// Guest fields are optional so owner-only configs (and the vector package's
// twin of this service, which shares the key id) stay mutually assignable.
export type Info = {
  readonly password: Option.Option<string>
  readonly username: string
  readonly guestPassword?: Option.Option<string>
  readonly guestUsername?: string
}

export class Config extends Context.Service<Config, Info>()("@vector/ServerAuthConfig") {
  static configLayer(input: Info) {
    return Layer.succeed(this, this.of(input))
  }

  static get layer() {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        return Config.of(
          yield* EffectConfig.all({
            password: configEnv("VECTOR_SERVER_PASSWORD", EffectConfig.string).pipe(EffectConfig.option),
            username: configEnv("VECTOR_SERVER_USERNAME", EffectConfig.string).pipe(EffectConfig.withDefault("vector")),
            guestPassword: configEnv("VECTOR_SERVER_GUEST_PASSWORD", EffectConfig.string).pipe(EffectConfig.option),
            guestUsername: configEnv("VECTOR_SERVER_GUEST_USERNAME", EffectConfig.string).pipe(
              EffectConfig.withDefault("guest"),
            ),
          }),
        )
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
    credentials.username === config.username &&
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

// A guest invited through `vector invite` uses the same API surface as the
// owner, so the v2 routes accept either pair.
export function authorized(credentials: DecodedCredentials, config: Info) {
  return identity(credentials, config) !== undefined
}

export function unauthorizedMessage(credentials: DecodedCredentials, config: Info) {
  const guestPassword = config.guestPassword ?? Option.none<string>()
  const usernames = [
    ...(Option.isSome(config.password) && config.password.value !== "" ? [config.username] : []),
    ...(Option.isSome(guestPassword) && guestPassword.value !== "" ? [config.guestUsername ?? "guest"] : []),
  ]
  if (!credentials.username || usernames.includes(credentials.username)) return "Authentication required"
  return `Authentication required. Use the configured server username: ${usernames.join(" or ")}.`
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? readEnv("VECTOR_SERVER_PASSWORD")
  if (!password) return undefined

  return `Basic ${Buffer.from(`${credentials?.username ?? readEnv("VECTOR_SERVER_USERNAME") ?? "vector"}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
