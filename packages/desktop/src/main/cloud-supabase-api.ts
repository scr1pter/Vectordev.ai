import { VECTOR_USER_AGENT } from "./user-agent"
import { getDatabase, redactCloudLog } from "./cloud-console"
import { getSupabaseManagementToken } from "./cloud-connections"

// The two Supabase surfaces Vector drives for a linked project: the Management
// API (api.supabase.com, the user's personal or OAuth token) and the project's
// own service APIs (https://<ref>.supabase.co, its service-role key). Both keys
// live only in the main process; nothing here returns them, and every error
// message is scrubbed of them before it leaves.

export type CloudFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type SupabaseOptions = { request?: CloudFetch }

export const SUPABASE_API = "https://api.supabase.com/v1"

export class SupabaseApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "SupabaseApiError"
  }
}

// The action cannot run until the user does something in Vector first. It is a
// report, not a failure: the agent relays `nextStep` and the console shows it.
export class SupabaseSetupError extends Error {
  constructor(
    message: string,
    readonly nextStep: string,
  ) {
    super(message)
    this.name = "SupabaseSetupError"
  }
}

export type SupabaseContext = {
  projectPath: string
  taskId?: string
  projectRef: string
  projectName: string
  projectUrl: string
  token: string
  request: CloudFetch
  /** Every credential this run read, so errors and output can be scrubbed of them. */
  secrets: string[]
  serviceKey?: string
}

export async function managementToken(options: SupabaseOptions = {}) {
  const token = await getSupabaseManagementToken(options.request ?? fetch).catch(() => undefined)
  if (!token) {
    throw new SupabaseSetupError(
      "Supabase is not connected on this machine.",
      "Connect Supabase in Vector Cloud > Connections (browser sign-in or a personal access token), then try again.",
    )
  }
  return token
}

export async function supabaseContext(
  input: { projectPath: string; taskId?: string },
  options: SupabaseOptions = {},
): Promise<SupabaseContext> {
  const database = getDatabase(input.projectPath, input.taskId)
  if (!database?.projectRef) {
    throw new SupabaseSetupError(
      "No Supabase project is linked to this repository.",
      "Create one or link an existing Supabase project in Vector Cloud > Database (the agent uses create_database or link_database).",
    )
  }
  const token = await managementToken(options)
  return {
    projectPath: input.projectPath,
    taskId: input.taskId,
    projectRef: database.projectRef,
    projectName: database.projectName ?? database.projectRef,
    projectUrl: database.url,
    token,
    request: options.request ?? fetch,
    secrets: [token],
  }
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

export function responseArray(value: unknown, key = "data"): unknown[] {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== "object") return []
  const nested = Reflect.get(value, key)
  return Array.isArray(nested) ? nested : []
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Removes the credentials this run held, the project's stored env values, and
// anything token-shaped. Supabase secret keys and Postgres connection strings
// are not shapes the shared redaction knows, so they are handled here.
export function scrub(context: Pick<SupabaseContext, "projectPath" | "taskId" | "secrets">, value: string) {
  return redactCloudLog(context.projectPath, context.taskId, value, context.secrets)
    .replace(/\bsb_secret_[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\b(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+@/gi, "$1[REDACTED]@")
}

async function readJson(response: Response) {
  const text = await response.text().catch(() => "")
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function providerError(body: unknown, status: number) {
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 500)
  return (
    stringField(body, "message") ??
    stringField(body, "msg") ??
    stringField(body, "error_description") ??
    stringField(body, "error") ??
    `Supabase returned HTTP ${status}.`
  )
}

async function send(context: SupabaseContext, url: string, init: RequestInit & { json?: unknown }, auth: Headers) {
  const headers = new Headers(init.headers)
  for (const [key, value] of auth) headers.set(key, value)
  headers.set("accept", "application/json")
  headers.set("user-agent", VECTOR_USER_AGENT)
  if (init.json !== undefined) headers.set("content-type", "application/json")
  const response = await context.request(url, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    signal: init.signal ?? AbortSignal.timeout(30_000),
  })
  const body = await readJson(response)
  if (response.ok) return body
  throw new SupabaseApiError(scrub(context, providerError(body, response.status)), response.status)
}

// https://supabase.com/docs/reference/api/introduction
export function management(context: SupabaseContext, path: string, init: RequestInit & { json?: unknown } = {}) {
  return send(context, `${SUPABASE_API}${path}`, init, new Headers({ authorization: `Bearer ${context.token}` }))
}

export function refPath(context: SupabaseContext, path: string) {
  return `/projects/${encodeURIComponent(context.projectRef)}${path}`
}

// The service-role key bypasses row level security, so it is fetched only when
// a project API needs it, kept in memory for this one run, and never returned.
// https://supabase.com/docs/reference/api/v1-get-project-api-keys
export async function serviceRoleKey(context: SupabaseContext): Promise<string> {
  if (context.serviceKey) return context.serviceKey
  const keys = responseArray(await management(context, refPath(context, "/api-keys?reveal=true")))
  // A new secret key is preferred; a masked one (the token may not be allowed
  // to reveal it) is useless, so the legacy service_role JWT is the fallback.
  const secret = keys
    .filter((item) => stringField(item, "type") === "secret")
    .map((item) => stringField(item, "api_key"))
    .find((value) => value && /^sb_secret_[A-Za-z0-9_-]+$/.test(value))
  const legacy = keys
    .filter((item) => stringField(item, "name") === "service_role")
    .map((item) => stringField(item, "api_key"))
    .find((value) => value && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))
  const key = secret ?? legacy
  if (!key) {
    throw new SupabaseSetupError(
      `Supabase did not give Vector a service key for ${context.projectName}.`,
      "Reconnect Supabase with a token that can read the Supabase project's API keys (secrets:read), then try again.",
    )
  }
  context.secrets.push(key)
  context.serviceKey = key
  return key
}

// A project's own REST services (auth admin, storage) behind its API gateway.
// A JWT service key also goes in Authorization; a secret key must only be sent
// as apikey: https://supabase.com/docs/guides/api/api-keys
export async function projectService(
  context: SupabaseContext,
  path: string,
  init: RequestInit & { json?: unknown } = {},
) {
  const key = await serviceRoleKey(context)
  const auth = new Headers({ apikey: key })
  if (!key.startsWith("sb_secret_")) auth.set("authorization", `Bearer ${key}`)
  return send(context, `https://${context.projectRef}.supabase.co${path}`, init, auth)
}
