import { createHash } from "node:crypto"

import {
  arrayField,
  numberField,
  objectField,
  parseJson,
  stringField,
  vercelFailure,
  vercelLinkContext,
  vercelPages,
  vercelRequest,
  vercelResponse,
  wait,
  VercelError,
  type VercelFetch,
  type VercelLinkContext,
} from "./cloud-vercel-api"
import { recordProductionMove, releaseForProviderDeployment } from "./cloud-console"
import { vercelScopeSlug } from "./cloud-vercel-projects"

// Deployments as Vercel knows them, including the ones a git push made, and
// the actions that move production: promote, rollback, redeploy and cancel.

export type VercelDeploymentState =
  | "QUEUED"
  | "INITIALIZING"
  | "BUILDING"
  | "READY"
  | "ERROR"
  | "CANCELED"
  | "BLOCKED"
  | "DELETED"
  | "UNKNOWN"

export type VercelDeployment = {
  id: string
  url: string
  name: string
  state: VercelDeploymentState
  target: "production" | "preview"
  createdAt: string
  /** Production traffic points at this deployment right now. */
  current: boolean
  /**
   * Vercel's readySubstate: STAGED never served production (a build made with
   * --skip-domain and not promoted), PROMOTED has.
   */
  substate?: "STAGED" | "ROLLING" | "PROMOTED"
  source?: string
  branch?: string
  commitSha?: string
  commitMessage?: string
  creator?: string
  inspectorUrl?: string
  errorMessage?: string
  aliases: string[]
}

export type VercelOptions = { request?: VercelFetch; sleep?: (ms: number) => Promise<void> }

export type VercelLogEntry = { at?: number; text: string }

const STATES: VercelDeploymentState[] = [
  "QUEUED",
  "INITIALIZING",
  "BUILDING",
  "READY",
  "ERROR",
  "CANCELED",
  "BLOCKED",
  "DELETED",
]
const RUNNING: VercelDeploymentState[] = ["QUEUED", "INITIALIZING", "BUILDING"]
const SUBSTATES = ["STAGED", "ROLLING", "PROMOTED"] as const

// https://vercel.com/docs/rest-api/deployments/list-deployments
export async function listVercelDeployments(
  projectPath: string,
  input: { limit?: number; target?: "production" | "preview"; state?: VercelDeploymentState } = {},
  options: VercelOptions = {},
) {
  const context = await vercelLinkContext(projectPath)
  const max = Math.max(1, Math.min(Math.floor(input.limit ?? 20), 200))
  const [current, items] = await Promise.all([
    currentProductionId(context, options.request),
    vercelPages(context.auth, "/v6/deployments", "deployments", {
      cursor: "until",
      pageSize: Math.min(max, 100),
      max,
      query: { projectId: context.link.projectId, target: input.target, state: input.state },
      request: options.request,
    }),
  ])
  return items.flatMap((item) => {
    const deployment = deploymentSummary(item, current)
    return deployment ? [deployment] : []
  })
}

// https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url.
// A deployment from another project is reported as missing, so an id the model
// supplies can only act inside the linked project.
export async function inspectVercelDeployment(projectPath: string, idOrUrl: string, options: VercelOptions = {}) {
  const context = await vercelLinkContext(projectPath)
  return inspectInProject(context, idOrUrl, options.request)
}

export async function inspectInProject(context: VercelLinkContext, idOrUrl: string, request?: VercelFetch) {
  const key = deploymentKey(idOrUrl)
  const [body, current] = await Promise.all([
    vercelRequest(context.auth, `/v13/deployments/${encodeURIComponent(key)}`, { request }),
    currentProductionId(context, request),
  ])
  if (stringField(body, "projectId") && stringField(body, "projectId") !== context.link.projectId) {
    throw new VercelError(
      "not_found",
      `Deployment ${key} is not part of the Vercel project ${context.link.projectName}.`,
    )
  }
  const deployment = deploymentSummary(body, current)
  if (!deployment) throw new VercelError("provider", "Vercel returned a deployment without an id or URL.")
  return deployment
}

function deploymentKey(idOrUrl: string) {
  const value = idOrUrl.trim()
  if (!value) throw new VercelError("invalid", "Name a deployment id or URL.")
  return URL.canParse(value) ? new URL(value).host : value.replace(/\/.*$/, "")
}

async function currentProductionId(context: VercelLinkContext, request?: VercelFetch) {
  const project = await vercelRequest(context.auth, `/v9/projects/${encodeURIComponent(context.link.projectId)}`, {
    request,
  })
  return stringField(objectField(objectField(project, "targets"), "production"), "id")
}

function deploymentSummary(value: unknown, current?: string): VercelDeployment | undefined {
  const id = stringField(value, "uid") ?? stringField(value, "id")
  const host = stringField(value, "url")
  if (!id || !host) return
  const meta = objectField(value, "meta")
  const state = String(stringField(value, "readyState") ?? stringField(value, "state") ?? "UNKNOWN").toUpperCase()
  const created = numberField(value, "createdAt") ?? numberField(value, "created")
  const creator = objectField(value, "creator")
  const alias = arrayField(value, "alias").filter((item): item is string => typeof item === "string")
  const substate = stringField(value, "readySubstate")
  return {
    id,
    url: `https://${host.replace(/^https?:\/\//, "")}`,
    name: stringField(value, "name") ?? host,
    state: STATES.find((item) => item === state) ?? "UNKNOWN",
    target: stringField(value, "target") === "production" ? "production" : "preview",
    createdAt: created ? new Date(created).toISOString() : new Date(0).toISOString(),
    current: Boolean(current && current === id),
    substate: SUBSTATES.find((item) => item === substate),
    source: stringField(value, "source"),
    branch:
      stringField(meta, "githubCommitRef") ??
      stringField(meta, "gitlabCommitRef") ??
      stringField(meta, "bitbucketCommitRef"),
    commitSha:
      stringField(meta, "githubCommitSha") ??
      stringField(meta, "gitlabCommitSha") ??
      stringField(meta, "bitbucketCommitSha"),
    commitMessage:
      stringField(meta, "githubCommitMessage") ??
      stringField(meta, "gitlabCommitMessage") ??
      stringField(meta, "bitbucketCommitMessage"),
    creator: stringField(creator, "username") ?? stringField(creator, "email"),
    inspectorUrl: stringField(value, "inspectorUrl"),
    errorMessage: stringField(value, "errorMessage"),
    aliases: alias,
  }
}

// https://vercel.com/docs/rest-api/deployments/get-deployment-events: the build
// output, newest first when direction=backward.
export async function vercelBuildLogs(
  projectPath: string,
  idOrUrl: string,
  limit: number,
  options: VercelOptions = {},
) {
  const context = await vercelLinkContext(projectPath)
  const deployment = await inspectInProject(context, idOrUrl, options.request)
  const body = await vercelRequest(context.auth, `/v3/deployments/${encodeURIComponent(deployment.id)}/events`, {
    query: { limit, direction: "backward" },
    request: options.request,
  })
  return { deployment, entries: vercelLogEntries(body), token: context.auth.token }
}

export function vercelLogEntries(body: unknown): VercelLogEntry[] {
  const events = Array.isArray(body)
    ? body
    : (["events", "logs", "result"].map((key) => objectField(body, key)).find(Array.isArray) ?? [])
  return events.flatMap((item): VercelLogEntry[] => {
    const payload = objectField(item, "payload")
    const text =
      stringField(payload, "text") ??
      stringField(item, "text") ??
      stringField(item, "message") ??
      stringField(payload, "info")
    if (!text) return []
    const at = numberField(item, "created") ?? numberField(payload, "date") ?? numberField(item, "timestamp")
    return [{ at, text: levelled(stringField(item, "type") ?? stringField(item, "level"), text) }]
  })
}

function levelled(type: string | undefined, text: string) {
  const level = type?.toLowerCase()
  if (level === "stderr" || level === "error" || level === "fatal" || level === "warning") return `[${level}] ${text}`
  return text
}

// https://vercel.com/docs/rest-api/logs/get-logs-for-a-deployment answers with
// application/stream+json: one JSON object per line, and the stream stays open
// for new requests. Vector reads what arrives within `waitMs`, then stops.
export async function vercelRuntimeLogs(
  projectPath: string,
  idOrUrl: string,
  limit: number,
  options: VercelOptions & { waitMs?: number; idleMs?: number } = {},
) {
  const context = await vercelLinkContext(projectPath)
  const deployment = await inspectInProject(context, idOrUrl, options.request)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.waitMs ?? 6_000)
  const entries = await vercelResponse(
    context.auth,
    `/v1/projects/${encodeURIComponent(context.link.projectId)}/deployments/${encodeURIComponent(deployment.id)}/runtime-logs`,
    { request: options.request, signal: controller.signal },
  )
    .then(async (response) => {
      if (!response.ok) {
        throw vercelFailure(response.status, await response.json().catch(() => undefined), context.auth.token)
      }
      return readRuntimeLines(response.body, limit, options.idleMs ?? 1_500)
    })
    // Running out of time before Vercel answered is an empty read, not a failure.
    .catch((error: unknown) => {
      if (controller.signal.aborted) return []
      throw error
    })
    .finally(() => {
      clearTimeout(timer)
      controller.abort()
    })
  return { deployment, entries: entries.slice(-limit), token: context.auth.token }
}

// The stream never ends on its own: once lines have arrived, a short silence
// means the backlog is through. A read that fails, as it does when the time
// runs out, ends with what has arrived.
async function readRuntimeLines(body: ReadableStream<Uint8Array> | null, limit: number, idleMs: number) {
  const reader = body?.getReader()
  if (!reader) return []
  const decoder = new TextDecoder()
  const read = async (entries: VercelLogEntry[], buffer: string): Promise<VercelLogEntry[]> => {
    if (entries.length >= limit) return [...entries, ...runtimeEntry(buffer)]
    const chunk = await Promise.race([
      reader.read(),
      ...(entries.length ? [wait(idleMs).then(() => ({ done: true as const, value: undefined }))] : []),
    ]).catch(() => ({ done: true as const, value: undefined }))
    if (chunk.done) return [...entries, ...runtimeEntry(buffer)]
    const lines = (buffer + decoder.decode(chunk.value, { stream: true })).split("\n")
    return read([...entries, ...lines.slice(0, -1).flatMap(runtimeEntry)], lines.at(-1) ?? "")
  }
  return read([], "")
}

function runtimeEntry(line: string): VercelLogEntry[] {
  if (!line.trim()) return []
  const value = parseJson(line)
  const message = stringField(value, "message")
  if (!message) return []
  const at = numberField(value, "timestampInMs")
  const request = [
    stringField(value, "requestMethod"),
    stringField(value, "requestPath"),
    numberField(value, "responseStatusCode"),
  ]
    .filter((item) => item !== undefined && item !== "")
    .join(" ")
  return [
    {
      at,
      text: levelled(stringField(value, "level"), [request, message].filter(Boolean).join(" · ")),
    },
  ]
}

// https://vercel.com/docs/rest-api/deployments/cancel-a-deployment
export async function cancelVercelDeployment(projectPath: string, idOrUrl: string, options: VercelOptions = {}) {
  const context = await vercelLinkContext(projectPath)
  const deployment = await inspectInProject(context, idOrUrl, options.request)
  if (!RUNNING.includes(deployment.state)) {
    throw new VercelError(
      "invalid",
      `Deployment ${deployment.id} is ${deployment.state.toLowerCase()}; only a queued or building deployment can be canceled.`,
    )
  }
  await vercelRequest(context.auth, `/v12/deployments/${encodeURIComponent(deployment.id)}/cancel`, {
    method: "PATCH",
    request: options.request,
  })
  return { ...deployment, state: "CANCELED" as const }
}

// https://vercel.com/docs/rest-api/deployments/create-a-new-deployment: a
// redeploy names the existing deployment and keeps its target. A production
// rebuild is created with autoAssignCustomDomains: false, which is what the
// CLI's --skip-domain sends, so production does not move to an unchecked build;
// promoting it is a separate, approved step.
export async function redeployVercelDeployment(projectPath: string, idOrUrl: string, options: VercelOptions = {}) {
  const context = await vercelLinkContext(projectPath)
  const deployment = await inspectInProject(context, idOrUrl, options.request)
  const created = await vercelRequest(context.auth, "/v13/deployments", {
    method: "POST",
    query: { forceNew: 1 },
    body: {
      name: context.link.projectName,
      project: context.link.projectId,
      deploymentId: deployment.id,
      ...(deployment.target === "production" ? { target: "production", autoAssignCustomDomains: false } : {}),
    },
    request: options.request,
  })
  const summary = deploymentSummary(created)
  if (!summary) throw new VercelError("provider", "Vercel did not return the new deployment.")
  return { from: deployment, deployment: summary }
}

// https://vercel.com/docs/rest-api/projects/point-production-traffic-to-a-given-deployment.
// Promotion does not rebuild, so only a production build can be promoted: a
// preview was built with preview environment variables.
export async function promoteVercelDeployment(projectPath: string, idOrUrl: string, options: VercelOptions = {}) {
  const context = await vercelLinkContext(projectPath)
  const deployment = await inspectInProject(context, idOrUrl, options.request)
  if (deployment.current) return { deployment, productionUrl: await productionUrl(context, deployment.id, options) }
  if (deployment.state !== "READY") {
    throw new VercelError("invalid", `Deployment ${deployment.id} is ${deployment.state.toLowerCase()}, not ready.`)
  }
  if (deployment.target !== "production") {
    throw new VercelError(
      "invalid",
      "This is a preview build, made with preview environment variables, so Vercel cannot point production at it. Publish to production instead: Vector builds it with production settings, checks it, then promotes it.",
    )
  }
  requireVercelChecksPassed(projectPath, deployment)
  await vercelRequest(
    context.auth,
    `/v10/projects/${encodeURIComponent(context.link.projectId)}/promote/${encodeURIComponent(deployment.id)}`,
    { method: "POST", request: options.request },
  )
  const url = await productionUrl(context, deployment.id, options)
  recordProductionMove(projectPath, deployment, { productionUrl: url })
  return { deployment: { ...deployment, current: true }, productionUrl: url }
}

// https://vercel.com/docs/rest-api/projects/point-production-traffic-to-a-previous-production-deployment-by-id.
// Without an id it rolls back to the production deployment before the current one.
export async function rollbackVercelDeployment(projectPath: string, idOrUrl?: string, options: VercelOptions = {}) {
  const context = await vercelLinkContext(projectPath)
  const target = idOrUrl
    ? await inspectInProject(context, idOrUrl, options.request)
    : await previousProduction(projectPath, context, options)
  if (target.current) throw new VercelError("invalid", `Deployment ${target.id} is already serving production.`)
  if (target.target !== "production" || target.state !== "READY") {
    throw new VercelError(
      "invalid",
      "Vercel can only roll back to an earlier production deployment that finished building.",
    )
  }
  requireVercelChecksPassed(projectPath, target)
  const previous = await currentProductionId(context, options.request)
  await vercelRequest(
    context.auth,
    `/v1/projects/${encodeURIComponent(context.link.projectId)}/rollback/${encodeURIComponent(target.id)}`,
    { method: "POST", query: { description: "Rolled back from Vector" }, request: options.request },
  )
  const url = await productionUrl(context, target.id, options)
  recordProductionMove(projectPath, target, { productionUrl: url, rollback: true })
  return { deployment: { ...target, current: true }, replaced: previous, productionUrl: url }
}

// A deployment Vector checked and found broken is not pointed at production,
// whoever asks; deployments Vector did not make carry no checks to consult.
export function requireVercelChecksPassed(projectPath: string, deployment: VercelDeployment) {
  const failed = failedChecks(projectPath, deployment)
  if (!failed.length) return
  throw new VercelError(
    "invalid",
    `Vector's required release checks failed for ${deployment.id} (${failed.map((check) => check.label).join(", ")}), so production was not moved to it. Fix the cause and publish again. If the failure came from outside the release, the user can run its checks again with Run checks in Cloud Services > Deployments.`,
  )
}

function failedChecks(projectPath: string, deployment: VercelDeployment) {
  return (releaseForProviderDeployment(projectPath, deployment)?.checks ?? []).filter(
    (check) => check.required && check.status === "failed",
  )
}

// The deployment a rollback without an id returns production to: the newest
// production deployment before the current one that actually served
// production and that Vector's checks did not fail. A build Vector staged
// with --skip-domain and never promoted is passed over, whatever its age.
export async function previousProduction(projectPath: string, context: VercelLinkContext, options: VercelOptions) {
  const current = await currentProductionId(context, options.request)
  const history = await vercelPages(context.auth, "/v6/deployments", "deployments", {
    cursor: "until",
    pageSize: 20,
    max: 60,
    query: { projectId: context.link.projectId, target: "production", state: "READY" },
    request: options.request,
  })
  const deployments = history.flatMap((item) => {
    const deployment = deploymentSummary(item, current)
    return deployment ? [deployment] : []
  })
  const previous = deployments
    .slice(deployments.findIndex((item) => item.current) + 1)
    .find(
      (item) =>
        !item.current &&
        item.state === "READY" &&
        servedProduction(projectPath, item) &&
        !failedChecks(projectPath, item).length,
    )
  if (!previous) {
    throw new VercelError(
      "not_found",
      `The Vercel project ${context.link.projectName} has no earlier production deployment that served production and passed Vector's checks, so there is nothing to roll back to.`,
    )
  }
  return previous
}

// Vercel's readySubstate says so directly. Without it, a release Vector
// recorded counts only once Vector saw it serve production.
function servedProduction(projectPath: string, deployment: VercelDeployment) {
  if (deployment.substate) return deployment.substate !== "STAGED"
  const release = releaseForProviderDeployment(projectPath, deployment)
  return !release || release.promotedAt !== undefined
}

// Promotion and rollback answer before every domain has moved; production is
// reported once the project names this deployment as its production target.
async function productionUrl(
  context: VercelLinkContext,
  deploymentId: string,
  options: VercelOptions,
  attempt = 0,
): Promise<string | undefined> {
  if (attempt >= 10) return undefined
  const project = await vercelRequest(context.auth, `/v9/projects/${encodeURIComponent(context.link.projectId)}`, {
    request: options.request,
  })
  const production = objectField(objectField(project, "targets"), "production")
  if (stringField(production, "id") !== deploymentId) {
    await (options.sleep ?? wait)(1_500)
    return productionUrl(context, deploymentId, options, attempt + 1)
  }
  const aliases = arrayField(production, "alias").filter((item): item is string => typeof item === "string")
  const host = aliases.find((item) => !item.endsWith(".vercel.app")) ?? aliases[0] ?? stringField(production, "url")
  return host ? `https://${host}` : undefined
}

// The same alias Vercel gives a branch's git deployments
// (https://vercel.com/docs/deployments/generated-urls#url-with-git-branch):
// <project>-git-<branch>-<scope>.vercel.app, so every push of an agent's branch
// keeps one stable preview address.
export function vercelBranchAlias(project: string, branch: string, scope: string) {
  const slug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
  const projectSlug = slug(project)
  const scopeSlug = slug(scope)
  const branchSlug = slug(branch) || "branch"
  const label = `${projectSlug}-git-${branchSlug}-${scopeSlug}`
  if (label.length <= 63) return `${label}.vercel.app`
  // Too long for one DNS label: keep the start of the branch and a hash of all of it.
  const hash = createHash("sha256").update(branch).digest("hex").slice(0, 6)
  const room = Math.max(1, 63 - projectSlug.length - scopeSlug.length - "-git--".length - hash.length - 1)
  const trimmed = `${projectSlug}-git-${branchSlug.slice(0, room).replace(/-+$/, "")}-${hash}-${scopeSlug}`
  return `${trimmed.slice(0, 63).replace(/-+$/, "")}.vercel.app`
}

// https://vercel.com/docs/rest-api/aliases/assign-an-alias
export async function assignVercelBranchAlias(
  context: VercelLinkContext,
  deploymentId: string,
  branch: string,
  request?: VercelFetch,
) {
  const scope = await vercelScopeSlug(context, request)
  if (!scope) throw new VercelError("provider", "Vercel did not return the account's URL slug.")
  const alias = vercelBranchAlias(context.link.projectName, branch, scope)
  await vercelRequest(context.auth, `/v2/deployments/${encodeURIComponent(deploymentId)}/aliases`, {
    method: "POST",
    body: { alias },
    request,
  })
  return `https://${alias}`
}
