import { VECTOR_USER_AGENT } from "./user-agent"
import { getCloudProviderProjectLink, getCloudProviderRuntimeAuth } from "./cloud-connections"
import { listDeployments, redactCloudLog, type CloudDeployment } from "./cloud-console"
import {
  listVercelDeployments,
  vercelBuildLogs,
  vercelLogEntries,
  vercelRuntimeLogs,
  type VercelDeployment,
} from "./cloud-vercel-deployments"

export { vercelLogEntries } from "./cloud-vercel-deployments"

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
  /** A deployment id from list_deployments: Vector's own, Vercel's dpl_ id, or its URL. */
  deploymentId?: string
  limit?: number
  /** build: what the build printed; runtime: what the running app logged. */
  source?: "build" | "runtime"
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
    source: "provider" | "runtime" | "build"
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

function recordedLogEntries(deployment: CloudDeployment): CloudLogEntry[] {
  const entries: CloudLogEntry[] = []
  if (deployment.runtimeLog) entries.push({ text: deployment.runtimeLog })
  if (deployment.log) entries.push({ text: deployment.log })
  for (const check of deployment.checks) {
    if (!check.output) continue
    entries.push({ text: `[${check.label}] ${check.status}\n${check.output}` })
  }
  if (deployment.healthError) entries.push({ text: `[error] ${deployment.healthError}` })
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
  const lines = boundLogLines(input.limit)
  const source = input.source ?? "build"
  const deployments = [...listDeployments(input.projectPath, input.taskId)].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  )
  const linked = Boolean(getCloudProviderProjectLink(input.projectPath, input.taskId, "vercel"))
  const requested = input.deploymentId?.trim()
  const recorded = requested
    ? deployments.find(
        (item) =>
          item.id === requested ||
          item.providerDeploymentId === requested ||
          (URL.canParse(requested) ? item.url === new URL(requested).toString() : false),
      )
    : undefined
  if (requested && !recorded && !linked) {
    return {
      ok: false,
      needsSetup: true,
      error: `Deployment ${requested} is not in this project's history.`,
      nextStep: "Call list_deployments to see the deployment ids this project knows about.",
    }
  }
  // A linked project reads Vercel's own history, so a deployment a git push
  // made is as readable as one Vector published.
  const latest =
    !requested && linked
      ? await listVercelDeployments(input.projectPath, { limit: 1 }, { request })
          .then((items) => items[0])
          .catch(() => undefined)
      : undefined
  const fromProvider = !recorded && (requested || latest)
  if (fromProvider) return providerLogs(input, requested ?? latest!.id, source, lines, request)
  const deployment = recorded ?? deployments[0]
  if (!deployment) {
    return {
      ok: false,
      needsSetup: true,
      error: "This project has no deployment history yet.",
      nextStep: "Publish the project first, then read the logs of the deployment that misbehaved.",
    }
  }
  if (source === "runtime") {
    if (!linked) {
      return {
        ok: false,
        needsSetup: true,
        error: "Runtime logs come from the linked Vercel project, and none is linked.",
        nextStep: "Link the Vercel project with link_project, or read the build logs instead.",
      }
    }
    return providerLogs(input, deployment.providerDeploymentId ?? deployment.url, source, lines, request, deployment)
  }

  let logSource: "provider" | "build" = "provider"
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
    logSource = "build"
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
      source: logSource,
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

async function providerLogs(
  input: CloudLogsInput,
  key: string,
  source: "build" | "runtime",
  lines: number,
  request: CloudFetch,
  recorded?: CloudDeployment,
): Promise<CloudLogReport> {
  const result = await (
    source === "runtime"
      ? vercelRuntimeLogs(input.projectPath, key, lines, { request })
      : vercelBuildLogs(input.projectPath, key, lines, { request })
  ).catch((error: unknown) => error)
  if (result instanceof Error || !result || typeof result !== "object") {
    return { ok: false, error: result instanceof Error ? result.message : "Vercel's logs could not be read." }
  }
  const read = result as { deployment: VercelDeployment; entries: CloudLogEntry[]; token: string }
  const tail = truncateLogTail(read.entries, lines)
  return {
    ok: true,
    deploymentId: recorded?.id ?? read.deployment.id,
    url: read.deployment.url,
    logs: {
      provider: "vercel",
      source: source === "runtime" ? "runtime" : "provider",
      environment: read.deployment.target,
      status: read.deployment.state.toLowerCase(),
      createdAt: read.deployment.createdAt,
      fetchedAt: new Date().toISOString(),
      detail:
        source === "runtime" && !tail.lines
          ? "Vercel streamed no runtime log lines in the few seconds Vector listened. Send a request to the app, then read again."
          : undefined,
      lines: tail.lines,
      droppedLines: tail.droppedLines,
      truncated: tail.truncated,
      tail: redactCloudLog(input.projectPath, recorded?.taskId, tail.log, [read.token]),
    },
  }
}
