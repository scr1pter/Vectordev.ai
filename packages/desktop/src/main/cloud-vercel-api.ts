import { Option, Schema } from "effect"

import { VECTOR_USER_AGENT } from "./user-agent"
import {
  getCloudProviderProjectLink,
  getCloudProviderRuntimeAuth,
  type CloudProviderProjectLink,
} from "./cloud-connections"

// The Vercel REST API (https://vercel.com/docs/rest-api). Every call runs with
// the token the user connected in Vector and, for a team, `teamId`, which every
// endpoint accepts to act on behalf of that team.

export type VercelFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type VercelAuth = { token: string; teamId?: string }

// A team scope picked for a project link: a team id, or null for the personal
// account. Undefined means "whatever the connection's default scope is".
export type VercelScopeChoice = string | null | undefined

export type VercelErrorCode =
  | "not_connected"
  | "not_linked"
  | "no_node"
  | "token_rejected"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid"
  | "provider"

// Codes that mean the user has to do something in Vector before the action can
// run. The bridge relays them as setup steps rather than as failed runs.
export const VERCEL_SETUP_CODES: VercelErrorCode[] = ["not_connected", "not_linked", "no_node", "token_rejected"]

export class VercelError extends Error {
  constructor(
    readonly code: VercelErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "VercelError"
  }
}

export const VERCEL_TOKEN_REJECTED =
  "Vercel rejected Vector's saved token: it expired, was revoked or lost access. Reconnect Vercel in Vector Cloud > Connections."

const DEFAULT_TIMEOUT_MS = 20_000
const MAX_PAGES = 50

export function vercelApiBase() {
  return (process.env.VECTOR_VERCEL_API_URL?.trim() || "https://api.vercel.com").replace(/\/$/, "")
}

export function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const field = Reflect.get(value, key)
  return typeof field === "string" && field ? field : undefined
}

export function numberField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined
  const field = Reflect.get(value, key)
  return typeof field === "number" && Number.isFinite(field) ? field : undefined
}

export function booleanField(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object") return undefined
  const field = Reflect.get(value, key)
  return typeof field === "boolean" ? field : undefined
}

export function objectField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined
  return Reflect.get(value, key)
}

export function arrayField(value: unknown, key: string): unknown[] {
  const field = objectField(value, key)
  return Array.isArray(field) ? field : []
}

export async function vercelRequest(
  auth: VercelAuth,
  path: string,
  options: {
    method?: string
    query?: Record<string, string | number | boolean | undefined>
    body?: unknown
    request?: VercelFetch
    signal?: AbortSignal
    /** /v2/user and /v2/teams describe the token itself, never a team. */
    unscoped?: boolean
  } = {},
): Promise<unknown> {
  const response = await vercelResponse(auth, path, options)
  const text = await response.text().catch(() => "")
  const body: unknown = text ? parseJson(text) : undefined
  if (response.ok) return body
  throw vercelFailure(response.status, body, auth.token)
}

// The raw response, for the one endpoint that streams (runtime logs).
export async function vercelResponse(
  auth: VercelAuth,
  path: string,
  options: {
    method?: string
    query?: Record<string, string | number | boolean | undefined>
    body?: unknown
    request?: VercelFetch
    signal?: AbortSignal
    unscoped?: boolean
  } = {},
) {
  const url = new URL(`${vercelApiBase()}${path}`)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  if (auth.teamId && !options.unscoped) url.searchParams.set("teamId", auth.teamId)
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${auth.token}`,
    "user-agent": VECTOR_USER_AGENT,
  })
  if (options.body !== undefined) headers.set("content-type", "application/json")
  return (options.request ?? fetch)(url.toString(), {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    // A redirect would carry the bearer token to wherever it points.
    redirect: "error",
    signal: options.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw new VercelError(
      "provider",
      `Could not reach Vercel: ${error instanceof Error ? error.message.split(auth.token).join("[redacted]") : "network error"}.`,
    )
  })
}

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

// Undefined for text that is not JSON, such as an HTML error page.
export function parseJson(text: string): unknown {
  return Option.getOrUndefined(decodeJson(text))
}

// Vercel answers errors as { error: { code, message, invalidToken? } }.
export function vercelFailure(status: number, body: unknown, token: string) {
  const error = objectField(body, "error")
  const message = (stringField(error, "message") ?? stringField(body, "message") ?? `HTTP ${status}`)
    .split(token)
    .join("[redacted]")
  if (status === 401 || booleanField(error, "invalidToken") === true) {
    return new VercelError("token_rejected", VERCEL_TOKEN_REJECTED, status)
  }
  if (status === 403) {
    return new VercelError(
      "forbidden",
      `Vercel refused the request: ${message} The connected token may not have access to this team or Vercel project.`,
      status,
    )
  }
  if (status === 404) return new VercelError("not_found", `Vercel could not find it: ${message}`, status)
  if (status === 409) return new VercelError("conflict", `Vercel reported a conflict: ${message}`, status)
  if (status === 400 || status === 422)
    return new VercelError("invalid", `Vercel rejected the request: ${message}`, status)
  return new VercelError("provider", `Vercel returned HTTP ${status}: ${message}`, status)
}

// Vercel list endpoints answer { <key>: [...], pagination: { count, next } }.
// `next` goes back as `until` on most endpoints; the projects list takes it as
// `from` (https://vercel.com/docs/rest-api/projects/retrieve-a-list-of-projects).
export async function vercelPages(
  auth: VercelAuth,
  path: string,
  key: string,
  options: {
    cursor: "until" | "from"
    pageSize?: number
    max?: number
    query?: Record<string, string | number | boolean | undefined>
    request?: VercelFetch
    unscoped?: boolean
  },
): Promise<unknown[]> {
  const max = options.max ?? 1_000
  const page = async (items: unknown[], cursor: number | string | undefined, count: number): Promise<unknown[]> => {
    const body = await vercelRequest(auth, path, {
      query: {
        ...options.query,
        limit: Math.min(options.pageSize ?? 100, max - items.length),
        [options.cursor]: cursor,
      },
      request: options.request,
      unscoped: options.unscoped,
    })
    // A few older endpoints answer with a bare array and no pagination.
    if (Array.isArray(body)) return [...items, ...body].slice(0, max)
    const collected = [...items, ...arrayField(body, key)]
    const next = objectField(objectField(body, "pagination"), "next")
    const more = (typeof next === "number" || typeof next === "string") && next !== "" && next !== cursor
    if (!more || collected.length >= max || count + 1 >= MAX_PAGES) return collected.slice(0, max)
    return page(collected, next, count + 1)
  }
  return page([], undefined, 0)
}

export async function vercelAuth(scope?: VercelScopeChoice): Promise<VercelAuth> {
  const runtime = await getCloudProviderRuntimeAuth("vercel")
  if (!runtime.token) {
    throw new VercelError("not_connected", "Vercel is not connected. Connect it in Vector Cloud > Connections.")
  }
  return { token: runtime.token, teamId: scope === null ? undefined : (scope ?? runtime.teamId) }
}

// Links saved before teams were picked per link stored the team as accountId.
export function linkTeamId(link: CloudProviderProjectLink): string | undefined {
  if (link.teamId) return link.teamId
  return link.accountId?.startsWith("team_") ? link.accountId : undefined
}

export type VercelLinkContext = { link: CloudProviderProjectLink; auth: VercelAuth }

export async function vercelLinkContext(projectPath: string): Promise<VercelLinkContext> {
  const link = getCloudProviderProjectLink(projectPath, undefined, "vercel")
  if (!link) {
    throw new VercelError(
      "not_linked",
      "No Vercel project is linked to this repository. Link or create one in Vector Cloud > Connections.",
    )
  }
  const auth = await vercelAuth(linkTeamId(link) ?? null)
  return { link, auth }
}

export function vercelErrorReport(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (!(error instanceof VercelError)) return { ok: false as const, error: message }
  if (!VERCEL_SETUP_CODES.includes(error.code)) return { ok: false as const, error: message, errorCode: error.code }
  return {
    ok: false as const,
    needsSetup: true,
    errorCode: error.code,
    error: message,
    nextStep: setupStep(error.code),
  }
}

function setupStep(code: VercelErrorCode) {
  if (code === "no_node") return "Ask the user to install Node.js 18 or later, then publish again."
  if (code === "token_rejected")
    return "Ask the user to reconnect Vercel in Vector Cloud > Connections with a new token."
  if (code === "not_linked")
    return "Link an existing Vercel project with link_project (see vercel_projects), create one with create_project, or ask the user to pick one in Vector Cloud > Connections."
  return "Ask the user to connect Vercel in Vector Cloud > Connections (Use access token), then try again."
}

export function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}
