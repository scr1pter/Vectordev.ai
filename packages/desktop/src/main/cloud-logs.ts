import { getCloudProviderProjectLink } from "./cloud-connections"
import { listDeployments, redactCloudLog, type CloudDeployment } from "./cloud-console"
import {
  listVercelDeployments,
  vercelBuildLogs,
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
  return [
    ...(deployment.runtimeLog ? [{ text: deployment.runtimeLog }] : []),
    ...(deployment.log ? [{ text: deployment.log }] : []),
    ...deployment.checks.flatMap((check) =>
      check.output ? [{ text: `[${check.label}] ${check.status}\n${check.output}` }] : [],
    ),
    ...(deployment.healthError ? [{ text: `[error] ${deployment.healthError}` }] : []),
  ]
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
      error: `Deployment ${requested} is not in this repository's history.`,
      nextStep: "Call list_deployments to see the deployment ids this repository knows about.",
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
  if (!recorded && (requested || latest)) return providerLogs(input, requested ?? latest!.id, source, lines, request)
  const deployment = recorded ?? deployments[0]
  if (!deployment) {
    return {
      ok: false,
      needsSetup: true,
      error: "This repository has no deployment history yet.",
      nextStep: "Publish the repository first, then read the logs of the deployment that misbehaved.",
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

  // The build output comes from the linked project, in its own team, as every
  // other Vercel read does; without a link, or when Vercel has none, Vector's
  // own record of the publish stands in.
  const read = linked
    ? await vercelBuildLogs(input.projectPath, deployment.providerDeploymentId ?? deployment.url, lines, { request })
        .then((result) => ({ entries: result.entries, token: result.token }))
        .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }))
    : { error: "No Vercel project is linked, so Vercel's build log cannot be read." }
  const fromProvider = "entries" in read && read.entries.length > 0
  const tail = truncateLogTail(fromProvider ? read.entries : recordedLogEntries(deployment), lines)
  return {
    ok: true,
    deploymentId: deployment.id,
    url: deployment.productionUrl ?? deployment.url,
    logs: {
      provider: deployment.target,
      source: fromProvider ? "provider" : "build",
      environment: deployment.environment,
      status: deployment.status,
      createdAt: deployment.createdAt,
      fetchedAt: new Date().toISOString(),
      detail: fromProvider
        ? undefined
        : "error" in read
          ? `${read.error} Falling back to the build output Vector recorded.`
          : "Vercel returned no build events; showing the build output Vector recorded.",
      lines: tail.lines,
      droppedLines: tail.droppedLines,
      truncated: tail.truncated,
      // Provider output routinely echoes the env vars a build was given, so the
      // tail leaves here through the same redaction the publish log uses.
      tail: redactCloudLog(input.projectPath, deployment.taskId, tail.log, "token" in read ? [read.token] : []),
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
