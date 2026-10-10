export * as ServerAuth from "./auth"

import { legacyName } from "@vectordevai/core/flag/legacy"
import { SessionV2 } from "@vectordevai/core/session"
import { WorkspaceV2 } from "@vectordevai/core/workspace"
import type { Principal } from "@vectordevai/protocol/middleware/authorization"
import { Config as EffectConfig, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { isIP } from "node:net"

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
  /** Also accepted as the owner username; set only while no username is configured. */
  readonly legacyUsername?: string
  readonly guestPassword?: Option.Option<string>
  readonly guestUsername?: string
  readonly guestWorkspaceIDs?: ReadonlyArray<string>
  readonly guestSessionIDs?: ReadonlyArray<string>
}

export class Config extends Context.Service<Config, Info>()("@vector/ServerAuthConfig") {
  static configLayer(input: Info) {
    return Layer.succeed(this, this.of(input))
  }

  static get layer() {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const config = yield* EffectConfig.all({
          password: EffectConfig.string("VECTOR_SERVER_PASSWORD").pipe(EffectConfig.option),
          username: EffectConfig.string("VECTOR_SERVER_USERNAME").pipe(EffectConfig.option),
          guestPassword: EffectConfig.string("VECTOR_SERVER_GUEST_PASSWORD").pipe(EffectConfig.option),
          guestUsername: EffectConfig.string("VECTOR_SERVER_GUEST_USERNAME").pipe(EffectConfig.withDefault("guest")),
          guestWorkspaces: EffectConfig.string("VECTOR_SERVER_GUEST_WORKSPACES").pipe(EffectConfig.option),
          guestSessions: EffectConfig.string("VECTOR_SERVER_GUEST_SESSIONS").pipe(EffectConfig.option),
        })
        return Config.of({
          password: config.password,
          guestPassword: config.guestPassword,
          guestUsername: config.guestUsername,
          guestWorkspaceIDs: claims(config.guestWorkspaces, Schema.decodeUnknownOption(WorkspaceV2.ID)),
          guestSessionIDs: claims(config.guestSessions, Schema.decodeUnknownOption(SessionV2.ID)),
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

// A guest invited through `vector invite` uses the same API surface as the
// owner, so the v2 routes accept either pair.
export function authorized(credentials: DecodedCredentials, config: Info) {
  return identity(credentials, config) !== undefined
}

export function principal(identity: Identity, config: Info): Principal {
  if (identity === "owner") return { kind: "owner", username: config.username }
  return {
    kind: "guest",
    username: config.guestUsername ?? "guest",
    workspaceIDs: new Set(config.guestWorkspaceIDs ?? []),
    sessionIDs: new Set(config.guestSessionIDs ?? []),
  }
}

export function ownerPrincipal(config: Info): Principal {
  return { kind: "owner", username: config.username }
}

export function isOwnerOnlyRequest(method: string, pathname: string) {
  if (pathname === "/api/session/import" || /\/session\/[^/]+\/share(?:\/|$)/.test(pathname)) return true
  if (pathname.startsWith("/api/pty") || pathname.startsWith("/pty")) return true
  if (pathname.startsWith("/api/credential") || pathname.startsWith("/api/permission/saved")) return true
  if (pathname.startsWith("/experimental/project/") && pathname.includes("/copy")) return true
  if (
    pathname.startsWith("/global/") ||
    pathname === "/experimental/console" ||
    pathname.startsWith("/experimental/console/") ||
    pathname.startsWith("/experimental/control-plane") ||
    pathname.startsWith("/experimental/workspace") ||
    pathname.startsWith("/project") ||
    pathname.startsWith("/sync") ||
    pathname.startsWith("/tui")
  )
    return pathname !== "/global/health"
  if (method === "GET" || method === "HEAD") return false
  return (
    pathname.startsWith("/api/integration") ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/provider/") ||
    pathname.startsWith("/mcp") ||
    pathname === "/config" ||
    pathname === "/instance/dispose"
  )
}

export function assertSecurePasswordTransport(target: string | URL, password: string | undefined) {
  if (!password) return
  if (typeof target === "string" && !target.includes("://")) {
    if (isLoopbackHostname(target)) return
    throw new Error(`Refusing to send or accept a reusable password over cleartext transport to ${target}`)
  }
  const url = target instanceof URL ? target : new URL(target)
  if (url.protocol === "https:" || url.protocol === "wss:" || isLoopbackHostname(url.hostname)) return
  throw new Error(`Refusing to send or accept a reusable password over cleartext transport to ${url.hostname}`)
}

export function unauthorizedMessage(credentials: DecodedCredentials, config: Info) {
  const guestPassword = config.guestPassword ?? Option.none<string>()
  const usernames = [
    ...(Option.isSome(config.password) && config.password.value !== "" ? [config.username] : []),
    ...(Option.isSome(guestPassword) && guestPassword.value !== "" ? [config.guestUsername ?? "guest"] : []),
  ]
  if (
    !credentials.username ||
    credentials.username === config.legacyUsername ||
    usernames.includes(credentials.username)
  )
    return "Authentication required"
  return `Authentication required. Use the configured server username: ${usernames.join(" or ")}.`
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? process.env.VECTOR_SERVER_PASSWORD
  if (!password) return undefined

  return `Basic ${Buffer.from(`${credentials?.username ?? process.env.VECTOR_SERVER_USERNAME ?? "vector"}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}

function claims<A extends string>(input: Option.Option<string>, decode: (input: unknown) => Option.Option<A>) {
  if (Option.isNone(input)) return []
  return input.value
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .flatMap((value): A[] => Option.match(decode(value), { onNone: () => [], onSome: (claim) => [claim] }))
}

function isLoopbackHostname(input: string) {
  const hostname = input
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
  if (hostname === "localhost") return true
  if (isIP(hostname) === 4) return hostname.startsWith("127.")
  if (isIP(hostname) !== 6) return false
  const normalized = new URL(`http://[${hostname}]`).hostname
  return normalized === "[::1]" || /^\[::ffff:7f[\da-f]{2}:[\da-f]{1,4}\]$/.test(normalized)
}
