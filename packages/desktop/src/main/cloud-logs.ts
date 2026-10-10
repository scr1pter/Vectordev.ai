import { VECTOR_USER_AGENT } from "./user-agent"
import { getCloudProviderRuntimeAuth } from "./cloud-connections"
import { listDeployments, redactCloudLog, type CloudDeployment } from "./cloud-console"

// The read side of a shipped app. An agent cannot fix what it cannot see, and
// "paste me the error from your Vercel dashboard" is the step that breaks the
// publish-diagnose-fix loop. Every tail here is capped hard on both lines and
// characters: a build log is unbounded and a context window is not, so a tail
// that cannot be trimmed is worse than no tail at all.

type CloudFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type CloudLogEntry = { at?: number; text: string }

export type CloudLogTail = {
  log: string
  lines: number
  droppedLines: number
  truncated: boolean
}

export type CloudLogsInput = {
  projectPath: string
  taskId?: string
  deploymentId?: string
  limit?: number
}

export type CloudLogReport = {
  ok: boolean
  needsSetup?: boolean
  error?: string
  nextStep?: string
  deploymentId?: string
  url?: string
  logs?: {
    provider: string
    source: "provider" | "build"
    environment: string
    status: string
    createdAt: string
    fetchedAt: string
    detail?: string
    lines: number
    droppedLines: number
    truncated: boolean
    tail: string
  }
}

export const DEFAULT_LOG_LINES = 100
export const MAX_LOG_LINES = 500
const MAX_LOG_CHARS = 12_000
const MAX_LINE_CHARS = 400

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const field = Reflect.get(value, key)
  return typeof field === "string" && field ? field : undefined
}

function numberField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined
  const field = Reflect.get(value, key)
  if (typeof field === "number" && Number.isFinite(field)) return field
  if (typeof field === "string") {
    const parsed = Date.parse(field)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function objectField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined
  return Reflect.get(value, key)
}

function arrayField(value: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== "object") return []
  for (const key of keys) {
    const nested = Reflect.get(value, key)
    if (Array.isArray(nested)) return nested
  }
  return []
}

async function providerJson(token: string, url: string | URL, request: CloudFetch): Promise<unknown> {
  const response = await request(url.toString(), {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "user-agent": VECTOR_USER_AGENT,
    },
    signal: AbortSignal.timeout(20_000),
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (response.ok) return body
  throw new Error(
    stringField(body, "message") ??
      stringField(body, "error_description") ??
      stringField(body, "error") ??
      `Provider returned HTTP ${response.status}.`,
  )
}

export function boundLogLines(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LOG_LINES
  return Math.max(1, Math.min(Math.floor(limit), MAX_LOG_LINES))
}

// Newest-last, because the last thing a failing deployment printed is the thing
// worth reading, and models weight the end of a block more than the start.
export function truncateLogTail(
  entries: CloudLogEntry[],
  limit: number = DEFAULT_LOG_LINES,
  maxChars: number = MAX_LOG_CHARS,
): CloudLogTail {
  const wanted = boundLogLines(limit)
  // Only reorder when every entry is timestamped: a provider that returns its
  // newest events first has to be flipped, but a composed tail (a build log we
  // recorded ourselves) is already in the order it happened.
  const ordered = entries.every((entry) => typeof entry.at === "number")
    ? [...entries].sort((left, right) => (left.at ?? 0) - (right.at ?? 0))
    : entries
  const lines = ordered
    .flatMap((entry) => entry.text.split(/\r?\n/))
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0)
    .map((line) =>
      line.length > MAX_LINE_CHARS
        ? `${line.slice(0, MAX_LINE_CHARS)}… [+${line.length - MAX_LINE_CHARS} chars]`
        : line,
    )

  const kept: string[] = []
  let characters = 0
  for (let index = lines.length - 1; index >= 0 && kept.length < wanted; index--) {
    const line = lines[index]
    const next = characters + line.length + (kept.length ? 1 : 0)
    if (kept.length && next > maxChars) break
    kept.unshift(line)
    characters = next
  }

  return {
    log: kept.join("\n"),
    lines: kept.length,
    droppedLines: lines.length - kept.length,
    truncated: kept.length < lines.length,
  }
}

function levelled(type: string | undefined, text: string): string {
  if (!type) return text
  const level = type.toLowerCase()
  if (level === "stderr" || level === "error" || level === "fatal" || level === "warning") return `[${level}] ${text}`
  return text
}

export function vercelLogEntries(body: unknown): CloudLogEntry[] {
  return arrayField(body, "events", "logs", "result")
    .map((item): CloudLogEntry | undefined => {
      const payload = objectField(item, "payload")
      const text =
        stringField(payload, "text") ??
        stringField(item, "text") ??
        stringField(item, "message") ??
        stringField(payload, "info")
      if (!text) return
      return {
        at: numberField(item, "created") ?? numberField(payload, "date") ?? numberField(item, "timestamp"),
        text: levelled(stringField(item, "type") ?? stringField(item, "level"), text),
      }
    })
    .filter((entry): entry is CloudLogEntry => Boolean(entry))
}

function recordedLogEntries(deployment: CloudDeployment): CloudLogEntry[] {
  const entries: CloudLogEntry[] = []
  if (deployment.runtimeLog) entries.push({ text: deployment.runtimeLog })
  if (deployment.log) entries.push({ text: deployment.log })
  for (const check of deployment.checks) {
    if (!check.output) continue
    entries.push({ text: `[${check.label}] ${check.status}\n${check.output}` })
  }
  if (deployment.healthError) entries.push({ text: levelled("error", deployment.healthError) })
  return entries
}

function deploymentHost(deployment: CloudDeployment): string {
  return URL.canParse(deployment.url) ? new URL(deployment.url).host : deployment.url
}

async function vercelEntries(
  deployment: CloudDeployment,
  lines: number,
  request: CloudFetch,
  auth: { token?: string; teamId?: string },
) {
  if (!auth.token) throw new Error("Connect Vercel in Vector Cloud > Connections to read its deployment logs.")
  const url = new URL(
    `/v3/deployments/${encodeURIComponent(deploymentHost(deployment))}/events`,
    "https://api.vercel.com",
  )
  url.searchParams.set("limit", String(lines))
  url.searchParams.set("direction", "backward")
  if (auth.teamId) url.searchParams.set("teamId", auth.teamId)
  return vercelLogEntries(await providerJson(auth.token, url, request))
}

export async function fetchCloudLogs(input: CloudLogsInput, request: CloudFetch = fetch): Promise<CloudLogReport> {
  const deployments = [...listDeployments(input.projectPath, input.taskId)].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  )
  if (!deployments.length) {
    return {
      ok: false,
      needsSetup: true,
      error: "This project has no deployment history yet.",
      nextStep: "Publish the project first, then read the logs of the deployment that misbehaved.",
    }
  }
  const deployment = input.deploymentId ? deployments.find((item) => item.id === input.deploymentId) : deployments[0]
  if (!deployment) {
    return {
      ok: false,
      needsSetup: true,
      error: `Deployment ${input.deploymentId} is not in this project's history.`,
      nextStep: "Call list_deployments to see the deployment ids this project knows about.",
    }
  }

  const lines = boundLogLines(input.limit)
  let source: "provider" | "build" = "provider"
  let detail: string | undefined
  let entries: CloudLogEntry[] = []
  // Every listed deployment is a Vercel one (see listDeployments).
  const auth = await getCloudProviderRuntimeAuth("vercel")
  try {
    entries = await vercelEntries(deployment, lines, request, auth)
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error)
  }
  if (!entries.length) {
    source = "build"
    detail = detail
      ? `${detail} Falling back to the build output Vector recorded.`
      : "The provider returned no log events; showing the build output Vector recorded."
    entries = recordedLogEntries(deployment)
  }

  const tail = truncateLogTail(entries, lines)
  return {
    ok: true,
    deploymentId: deployment.id,
    url: deployment.productionUrl ?? deployment.url,
    logs: {
      provider: deployment.target,
      source,
      environment: deployment.environment,
      status: deployment.status,
      createdAt: deployment.createdAt,
      fetchedAt: new Date().toISOString(),
      detail,
      lines: tail.lines,
      droppedLines: tail.droppedLines,
      truncated: tail.truncated,
      // Provider output routinely echoes the env vars a build was given, so the
      // tail leaves here through the same redaction the publish log uses.
      tail: redactCloudLog(input.projectPath, deployment.taskId, tail.log, [auth.token]),
    },
  }
}
