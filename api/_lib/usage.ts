import { Option, Schema } from "effect"
import { UsageSummary } from "../../packages/schema/src/usage-summary.js"
import { verifyCliToken } from "./cli-token.js"
import { designLabOwners, requireDesignLabOwner } from "./design-lab.js"
import { ApiError, type ApiRequest } from "./http.js"

/**
 * Usage counts: how many installs and accounts use Vector each day, never what they do.
 * Rows live in Supabase behind the RPCs in docs/vector/owner-actions/sql/usage.sql and are
 * written only with the server's service-role key. Recording is best effort: every call is
 * bounded by a short timeout and its failure never reaches the request that triggered it.
 */

const RECORD_TIMEOUT_MS = 1_500
// Only the owner's dashboard waits on this, never a user's request.
const SUMMARY_TIMEOUT_MS = 8_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
// process.platform-process.arch, as the CLI reports it in x-vector-platform.
const CLI_PLATFORM =
  /^(aix|android|darwin|freebsd|linux|netbsd|openbsd|sunos|win32)-(arm|arm64|ia32|loong64|ppc64|riscv64|s390x|x64)$/

const Version = Schema.String.check(Schema.isMaxLength(32), Schema.isPattern(VERSION))
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }))

/** The desktop check-in body, exactly as the desktop app sends it. */
export const Checkin = Schema.Struct({
  installId: Schema.String.check(Schema.isUUID(4)),
  client: Schema.Literal("desktop"),
  version: Version,
  platform: Schema.Literals(["darwin", "win32", "linux"]),
  arch: Schema.Literals(["x64", "arm64"]),
  sessions: Count,
  subagentSessions: Count,
})
export const decodeCheckin = Schema.decodeUnknownOption(Checkin, { onExcessProperty: "error" })
const decodeSummary = Schema.decodeUnknownOption(UsageSummary.Summary)

export type UsageRecord =
  | {
      client: "desktop"
      installId: string
      accountId?: string
      version: string
      platform: string
      arch: string
      sessions: number
      subagentSessions: number
    }
  | { client: "cli"; accountId: string; version: string; platform: string; arch: string }

/** Never rejects. Answers nothing when usage storage is not configured. */
export function recordUsage(input: UsageRecord, fetcher: typeof fetch = fetch) {
  return rpc("vector_usage_record", { request: input }, RECORD_TIMEOUT_MS, fetcher).then(
    () => undefined,
    () => undefined,
  )
}

/** Never rejects. */
export function recordDownload(input: { accountId: string; target: string; version: string }, fetcher: typeof fetch = fetch) {
  if (!UUID.test(input.accountId)) return Promise.resolve()
  return rpc("vector_usage_download", { request: input }, RECORD_TIMEOUT_MS, fetcher).then(
    () => undefined,
    () => undefined,
  )
}

/**
 * Records the CLI's daily account verification as one day of CLI use. Only a CLI that sends its
 * version also honours VECTOR_DISABLE_USAGE, so requests without these headers are not counted.
 * Never rejects.
 */
export async function recordCliUsage(
  request: Pick<ApiRequest, "headers">,
  accountId: string,
  fetcher: typeof fetch = fetch,
) {
  if (header(request, "x-vector-usage")?.trim().toLowerCase() === "off") return
  const version = header(request, "x-vector-version")?.trim()
  const platform = CLI_PLATFORM.exec(header(request, "x-vector-platform")?.trim() ?? "")
  if (!version || version.length > 32 || !VERSION.test(version)) return
  if (!platform?.[1] || !platform[2] || !UUID.test(accountId)) return
  await recordUsage({ client: "cli", accountId, version, platform: platform[1], arch: platform[2] }, fetcher)
}

/** Removes every count linked to an account. True only when storage confirmed it. */
export function forgetUsage(accountId: string, fetcher: typeof fetch = fetch) {
  if (!UUID.test(accountId)) return Promise.resolve(false)
  return rpc("vector_usage_forget", { account: accountId }, RECORD_TIMEOUT_MS, fetcher).then(
    (payload) => payload !== undefined,
    () => false,
  )
}

export async function usageSummary(fetcher: typeof fetch = fetch) {
  const unavailable = new ApiError(503, "USAGE_UNAVAILABLE", "Usage counts are not available right now.")
  const payload = await rpc("vector_usage_summary", { request: {} }, SUMMARY_TIMEOUT_MS, fetcher).catch(() => {
    throw unavailable
  })
  const summary = Option.getOrUndefined(decodeSummary(payload))
  if (!summary) throw unavailable
  return summary
}

/**
 * The account behind a desktop check-in, from the Vector account token the desktop already holds.
 * Undefined for a missing, forged or expired token: the check-in is then counted without an account.
 */
export function usageAccount(request: Pick<ApiRequest, "headers">) {
  const token = /^Bearer (vct_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header(request, "authorization") ?? "")?.[1]
  if (!token) return undefined
  const id = Option.getOrUndefined(Option.liftThrowable(verifyCliToken)(token))?.id
  return id && UUID.test(id) ? id : undefined
}

export function usageOwners() {
  const configured = process.env.VECTOR_ADMIN_EMAILS?.split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
  return configured?.length ? configured : designLabOwners()
}

/** The same Google-only owner check as the Design Lab, against the admin allowlist. */
export function requireUsageOwner(request: Pick<ApiRequest, "headers">, fetcher: typeof fetch = fetch) {
  return requireDesignLabOwner(request, fetcher, usageOwners())
}

/**
 * Lets counting finish after the response without delaying it. Vercel keeps a function running
 * only for work registered with its request context, which is the hook @vercel/functions'
 * waitUntil reads; this repository does not depend on that package. Elsewhere the work runs on.
 */
export function afterResponse(work: Promise<unknown>) {
  const settled = work.then(
    () => undefined,
    () => undefined,
  )
  const context = Reflect.get(globalThis, Symbol.for("@vercel/request-context")) as
    | { get?: () => { waitUntil?: (promise: Promise<unknown>) => void } | undefined }
    | undefined
  context?.get?.()?.waitUntil?.(settled)
}

function header(request: Pick<ApiRequest, "headers">, name: string) {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function storage() {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "")
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !key) return undefined
  const origin = URL.parse(url)
  const local =
    process.env.NODE_ENV !== "production" &&
    process.env.VERCEL_ENV !== "production" &&
    origin?.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
  if (
    !origin ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    (origin.protocol !== "https:" && !local)
  )
    return undefined
  return { url, key }
}

/** Undefined when usage storage is not configured; rejects when it is configured but fails. */
async function rpc(name: string, body: unknown, timeout: number, fetcher: typeof fetch) {
  const target = storage()
  if (!target) return undefined
  const response = await fetcher(`${target.url}/rest/v1/rpc/${name}`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
    headers: { "content-type": "application/json", apikey: target.key, authorization: `Bearer ${target.key}` },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`Usage storage answered ${response.status}`)
  }
  return boundedJson(response)
}

async function boundedJson(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  const state = { bytes: 0 }
  while (true) {
    const next = await reader.read()
    if (next.done) break
    state.bytes += next.value.byteLength
    if (state.bytes > 1_000_000) {
      await reader.cancel().catch(() => undefined)
      throw new Error("Usage storage answered too much")
    }
    chunks.push(next.value)
  }
  return Option.getOrNull(
    Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(Buffer.concat(chunks).toString("utf8")),
  )
}
