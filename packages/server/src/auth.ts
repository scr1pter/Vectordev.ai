export * as ServerAuth from "./auth"

import { legacyName } from "@vectordevai/core/flag/legacy"
import { SessionV2 } from "@vectordevai/core/session"
import { WorkspaceV2 } from "@vectordevai/core/workspace"
import type { Principal } from "@vectordevai/protocol/middleware/authorization"
import { Config as EffectConfig, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { realpathSync, statSync } from "node:fs"
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
  readonly guestWorkspaceDirectories?: Readonly<Record<string, string>>
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
          guestWorkspaceDirectories: EffectConfig.string("VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES").pipe(
            EffectConfig.option,
          ),
          guestSessions: EffectConfig.string("VECTOR_SERVER_GUEST_SESSIONS").pipe(EffectConfig.option),
        })
        return Config.of({
          password: config.password,
          guestPassword: config.guestPassword,
          guestUsername: config.guestUsername,
          guestWorkspaceIDs: claims(config.guestWorkspaces, Schema.decodeUnknownOption(WorkspaceV2.ID)),
          guestWorkspaceDirectories: directoryClaims(config.guestWorkspaceDirectories),
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
    Option.match(value ?? Option.none(), { onNone: () => false, onSome: (item) => item !== "" })
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
    workspaceDirectories: canonicalDirectories(config.guestWorkspaceDirectories),
    sessionIDs: new Set(config.guestSessionIDs ?? []),
  }
}

function directoryClaims(input: Option.Option<string>) {
  if (Option.isNone(input)) return {}
  const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(input.value)
  if (Option.isNone(json)) return {}
  return Option.getOrElse(
    Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.String))(json.value),
    () => ({}),
  )
}

function canonicalDirectories(input: Readonly<Record<string, string>> | undefined) {
  return new Map(
    Object.entries(input ?? {}).flatMap(([workspaceID, directory]) => {
      try {
        const canonical = realpathSync(directory)
        if (!statSync(canonical).isDirectory()) return []
        return [[workspaceID, canonical] as const]
      } catch {
        return []
      }
    }),
  )
}

export function ownerPrincipal(config: Info): Principal {
  return { kind: "owner", username: config.username }
}

export function isOwnerOnlyRequest(method: string, pathname: string) {
  const canonical = canonicalAuthorizationPath(pathname)
  if (!canonical) return true
  if (canonical === "/api/session/import" || /\/session\/[^/]+\/share(?:\/|$)/.test(canonical)) return true
  if (canonical.startsWith("/api/pty") || canonical.startsWith("/pty")) return true
  if (canonical.startsWith("/api/credential") || canonical.startsWith("/api/permission/saved")) return true
  if (canonical.startsWith("/experimental/project/") && canonical.includes("/copy")) return true
  if (
    canonical.startsWith("/global/") ||
    canonical === "/experimental/console" ||
    canonical.startsWith("/experimental/console/") ||
    canonical.startsWith("/experimental/control-plane") ||
    canonical.startsWith("/experimental/workspace") ||
    canonical.startsWith("/project") ||
    canonical.startsWith("/sync") ||
    canonical.startsWith("/tui")
  )
    return canonical !== "/global/health"
  if (method === "GET" || method === "HEAD") return false
  return (
    canonical.startsWith("/api/integration") ||
    canonical.startsWith("/auth/") ||
    canonical.startsWith("/provider/") ||
    canonical.startsWith("/mcp") ||
    canonical === "/config" ||
    canonical === "/instance/dispose"
  )
}

function canonicalAuthorizationPath(pathname: string, remaining = 4): string | undefined {
  if (!pathname.includes("%")) return pathname
  if (!remaining) return undefined
  try {
    const decoded = decodeURIComponent(pathname)
    return decoded === pathname ? decoded : canonicalAuthorizationPath(decoded, remaining - 1)
  } catch {
    return undefined
  }
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
