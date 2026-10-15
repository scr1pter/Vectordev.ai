import { randomUUID } from "node:crypto"
import { createServer, type Server } from "node:http"

import { applyEnv, detectBuildSettings, getBuildSettings, getDatabase, listDeployments } from "./cloud-console"
import {
  cachedCloudProviderConnection,
  getCloudProviderProjectLink,
  listCloudProviderConnections,
  listCloudProviderProjectLinks,
} from "./cloud-connections"
import { fetchCloudLogs } from "./cloud-logs"
import { applyCloudMigrations } from "./cloud-migrations"
import { recordPublishAttempt } from "./cloud-overview"
import { createCloudDatabase } from "./cloud-provision"
import {
  describeReleaseSettings,
  isReleaseCommand,
  parseReleaseFields,
  RELEASE_COMMANDS,
  runReleaseCommand,
  type ReleaseSettingsFields,
} from "./cloud-release-commands"
import { resolveCloudScope, type CloudScope, type CloudWorkspace } from "./cloud-scope"
import { describeSupabaseCommand, isSupabaseCommand, runSupabaseCommand } from "./cloud-supabase"
import type { CloudFetch } from "./cloud-supabase-api"
import { publishProject, type PublishResult } from "./publish"
import {
  describeVercelAction,
  parseVercelFields,
  runVercelCommand,
  vercelStatusSummary,
  VERCEL_COMMANDS,
  VERCEL_DESCRIBABLE,
  type VercelBridgeOptions,
  type VercelCommandFields,
} from "./cloud-vercel-bridge"
import { vercelLinkContext, type VercelFetch } from "./cloud-vercel-api"
import { protectsDeployment } from "./cloud-vercel-checks"
import { readVercelProject, vercelProjectCandidate } from "./cloud-vercel-projects"

const MAX_BODY_BYTES = 64 * 1024

const COMMANDS = [
  "status",
  "detect_build",
  "database_status",
  "create_database",
  "prepare_database",
  "prepare_auth",
  "cloud_connections",
  "sync_environment",
  "publish",
  "list_deployments",
  "logs",
  "apply_migrations",
  "describe",
  ...VERCEL_COMMANDS,
  ...RELEASE_COMMANDS,
] as const

// The actions that change something in the user's cloud accounts or project.
// The agent tool asks permission for each, after `describe` names the provider,
// project and environment it would touch.
const DESCRIBABLE = [
  "publish",
  "sync_environment",
  "create_database",
  "prepare_database",
  "prepare_auth",
  "apply_migrations",
  "set_release_settings",
  ...VERCEL_DESCRIBABLE,
] as const

type CloudCommand = (typeof COMMANDS)[number]
type CloudAction = (typeof DESCRIBABLE)[number]

type CloudCommandInput = VercelCommandFields & {
  release: ReleaseSettingsFields
  command: CloudCommand
  action?: CloudAction
  projectPath: string
  taskId?: string
  production?: boolean
  provider?: "vercel"
  deploymentId?: string
  limit?: number
  source?: "build" | "runtime"
  dryRun?: boolean
  organizationId?: string
  region?: string
  force?: boolean
  approvalID?: string
}

let bridgeServer: Server | undefined
let bridgeUrl = ""
let bridgeToken = ""

type CloudBridgeOptions = {
  publish?: typeof publishProject
  /** A fake Vercel API, for tests. */
  vercel?: VercelBridgeOptions
  /** The desktop's parallel workspaces, so an agent's worktree resolves to its project. */
  workspaces?: () => CloudWorkspace[] | Promise<CloudWorkspace[]>
  /** Provider HTTP for the Supabase commands; tests point it at a local fake. */
  request?: CloudFetch
}

export async function startCloudBridge(options: CloudBridgeOptions = {}) {
  if (bridgeServer) return { url: bridgeUrl, token: bridgeToken }

  bridgeToken = randomUUID()
  bridgeServer = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8")
    if (request.method !== "POST" || request.url !== "/command") {
      response.statusCode = 404
      response.end(JSON.stringify({ error: "Not found" }))
      return
    }
    if (request.headers.authorization !== `Bearer ${bridgeToken}`) {
      response.statusCode = 401
      response.end(JSON.stringify({ error: "Unauthorized" }))
      return
    }

    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.byteLength
      if (bytes > MAX_BODY_BYTES) {
        response.statusCode = 413
        response.end(JSON.stringify({ error: "Request too large" }))
        request.destroy()
        return
      }
      chunks.push(buffer)
    }

    const result = await Promise.resolve()
      .then(() => routeCloudCommand(JSON.parse(Buffer.concat(chunks).toString("utf8")), options))
      .catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }))
    response.statusCode = result.ok ? 200 : 400
    response.end(JSON.stringify(result))
  })

  await new Promise<void>((resolve, reject) => {
    bridgeServer!.once("error", reject)
    bridgeServer!.listen(0, "127.0.0.1", () => resolve())
  })
  const address = bridgeServer.address()
  if (!address || typeof address === "string") throw new Error("Vector Cloud bridge failed to bind")
  bridgeUrl = `http://127.0.0.1:${address.port}`
  return { url: bridgeUrl, token: bridgeToken }
}

export async function stopCloudBridge() {
  const current = bridgeServer
  bridgeServer = undefined
  bridgeUrl = ""
  bridgeToken = ""
  if (!current) return
  await new Promise<void>((resolve) => current.close(() => resolve()))
}

// Everything Vector does with a linked Supabase project beyond the original
// commands runs through the same entry point as the Cloud console, as the agent.
async function routeCloudCommand(body: unknown, options: CloudBridgeOptions) {
  const command = body && typeof body === "object" ? Reflect.get(body, "command") : undefined
  const action = body && typeof body === "object" ? Reflect.get(body, "action") : undefined
  const original = (value: unknown) => COMMANDS.some((item) => item === value)
  if (command === "describe" && isSupabaseCommand(action) && !original(action)) {
    return describeSupabaseCommand(action, body, (await options.workspaces?.()) ?? [], { request: options.request })
  }
  if (isSupabaseCommand(command) && !original(command)) {
    return runSupabaseCommand(command, body, {
      caller: "agent",
      workspaces: options.workspaces,
      request: options.request,
    })
  }
  return runCloudCommand(parseCloudCommandInput(body), options)
}

function parseCloudCommandInput(value: unknown): CloudCommandInput {
  if (!value || typeof value !== "object") throw new Error("Cloud command must be an object.")
  const command = Reflect.get(value, "command")
  const action = Reflect.get(value, "action")
  const projectPath = Reflect.get(value, "projectPath")
  const taskId = Reflect.get(value, "taskId")
  const production = Reflect.get(value, "production")
  const provider = Reflect.get(value, "provider")
  const deploymentId = Reflect.get(value, "deploymentId")
  const limit = Reflect.get(value, "limit")
  const dryRun = Reflect.get(value, "dryRun")
  const organizationId = Reflect.get(value, "organizationId")
  const region = Reflect.get(value, "region")
  const force = Reflect.get(value, "force")
  const source = Reflect.get(value, "source")
  const approvalID = Reflect.get(value, "approvalID")
  const known = COMMANDS.find((item) => item === command)
  if (!known) throw new Error("Unsupported Vector Cloud command.")
  const describable = DESCRIBABLE.find((item) => item === action)
  if (known === "describe" && !describable) throw new Error("Choose a Vector Cloud action to describe.")
  if (typeof projectPath !== "string" || !projectPath.trim())
    throw new Error("Open a project before using Vector Cloud.")
  if (taskId !== undefined && typeof taskId !== "string") throw new Error("Invalid project session.")
  if (production !== undefined && typeof production !== "boolean") throw new Error("Invalid publish mode.")
  if (provider !== undefined && provider !== "vercel") {
    throw new Error("Invalid cloud provider.")
  }
  if (deploymentId !== undefined && typeof deploymentId !== "string") throw new Error("Invalid deployment.")
  if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit))) {
    throw new Error("Invalid log line limit.")
  }
  if (dryRun !== undefined && typeof dryRun !== "boolean") throw new Error("Invalid migration mode.")
  if (organizationId !== undefined && (typeof organizationId !== "string" || !organizationId.trim())) {
    throw new Error("Invalid Supabase organization.")
  }
  if (region !== undefined && (typeof region !== "string" || !region.trim())) {
    throw new Error("Invalid database region.")
  }
  if (force !== undefined && typeof force !== "boolean") throw new Error("Invalid database creation mode.")
  if (approvalID !== undefined && (typeof approvalID !== "string" || approvalID.length > 100))
    throw new Error("Invalid migration approval.")
  if (source !== undefined && source !== "build" && source !== "runtime") throw new Error("Invalid log source.")
  return {
    ...parseVercelFields(value),
    release: parseReleaseFields(value),
    approvalID,
    source,
    command: known,
    action: describable,
    projectPath,
    taskId,
    production,
    provider,
    deploymentId,
    limit,
    dryRun,
    organizationId,
    region,
    force,
  }
}

// Vercel is the only hosting destination: a project publishes once Vercel is
// connected and one of its projects is linked to this repository.
function configuredPublishTargets(input: CloudCommandInput) {
  const link = getCloudProviderProjectLink(input.projectPath, input.taskId, "vercel")
  if (!link || !cachedCloudProviderConnection("vercel").connected) return []
  return [{ id: "vercel" as const, label: "Vercel", projectName: link.projectName }]
}

// What a changing action would touch, worded for the permission prompt: the
// provider, the provider-side project and the environment. A report that is not
// ok means the action cannot run yet, so the tool relays it without asking.
async function describeCloudAction(input: CloudCommandInput, workspace: CloudScope, request?: VercelFetch) {
  // Vector's local Supabase and publish descriptions are below; every Vercel
  // action, including the environment sync, describes itself.
  const scope = (provider: "Vercel" | "Supabase", project: string, environment: string, summary: string) => ({
    ok: true,
    scope: { provider, project, environment, summary },
  })
  if (input.action === "publish") {
    const target = configuredPublishTargets(input)[0]
    if (!target) return publishSetup()
    // Vercel makes a project's first deployment production whatever it was
    // asked for, so that publish is described as the production release it is.
    const project = await vercelLinkContext(input.projectPath)
      .then((context) => readVercelProject(context, request))
      .catch(() => undefined)
    if (project && !project.productionDeploymentId) {
      return scope(
        "Vercel",
        target.projectName,
        "production",
        `Publish ${workspace.directory !== workspace.projectPath ? "this agent workspace" : "this project"} to the Vercel project ${target.projectName}. It has never been deployed, and Vercel makes a project's first deployment production, so this goes live at its production address; release checks run after.`,
      )
    }
    if (workspace.directory !== workspace.projectPath) {
      return scope(
        "Vercel",
        target.projectName,
        "preview",
        `Publish this agent workspace to the Vercel project ${target.projectName} as a preview at its branch address. Production changes only after it is merged into the main project.`,
      )
    }
    // Nothing to approve when Deployment Protection would keep the checks out
    // of the production build: production would not move.
    const settings = getBuildSettings(input.projectPath, input.taskId)
    const checked = (settings?.requiredChecks.health ?? true) || (settings?.requiredChecks.browser ?? true)
    if (
      input.production === true &&
      project &&
      checked &&
      !project.protection.bypassReady &&
      protectsDeployment(project.protection, "production")
    ) {
      return {
        ok: false,
        needsSetup: true,
        errorCode: "checks_blocked",
        error: `Vercel Deployment Protection covers the production builds of ${target.projectName}, and Vector has no Protection Bypass for Automation secret, so its release checks could not open the build and production would not move.`,
        nextStep:
          "Offer enable_protection_bypass (the user approves it) so the checks can open protected builds, then publish to production again.",
      }
    }
    return input.production === true
      ? scope(
          "Vercel",
          target.projectName,
          "production",
          `Build this project for production on the Vercel project ${target.projectName} and run the release checks on that build. Production traffic moves to it only if they pass.`,
        )
      : scope(
          "Vercel",
          target.projectName,
          "preview",
          `Publish this project to the Vercel project ${target.projectName} as a preview. Production does not change.`,
        )
  }
  const database = getDatabase(input.projectPath, input.taskId)
  const name = database ? (database.projectName ?? database.projectRef ?? new URL(database.url).hostname) : ""
  if (input.action === "create_database") {
    if (database && input.force !== true) {
      return scope(
        "Supabase",
        name,
        "production",
        `Keep the Supabase project ${name} that is already connected; nothing new is created.`,
      )
    }
    return scope(
      "Supabase",
      "a new project",
      "production",
      `Create a new Supabase project${input.organizationId ? ` in organization ${input.organizationId}` : ""} in ${input.region ?? "us-east-1"}. Supabase bills it to that organization.`,
    )
  }
  if (!database) {
    return {
      ok: false,
      needsSetup: true,
      error: "No Vector Cloud database is connected.",
      nextStep:
        "Run create_database to create one on the user's connected Supabase account, or link the user's existing project with link_database (supabase_projects lists them).",
    }
  }
  if (input.action === "apply_migrations") {
    if (input.dryRun)
      return scope(
        "Supabase",
        name,
        "production",
        `Read which migrations the Supabase project ${name} has applied. Nothing changes.`,
      )
    const plan = await applyCloudMigrations({ ...input, directory: workspace.directory, prepare: true }, request)
    if (!plan.ok || plan.migrations?.failed) return { ...plan, ok: false }
    return {
      ...scope(
        "Supabase",
        name,
        "production",
        `Apply the reviewed SQL to the Supabase project ${name}. This changes its live database.`,
      ),
      noop: !plan.migrations?.pending.length,
      statements: plan.statements,
      approved: { approvalID: plan.approvalID },
    }
  }
  return scope(
    "Supabase",
    name,
    "local .env",
    `Write the Supabase project ${name}'s public client settings to this project's .env.`,
  )
}

function publishSetup() {
  return {
    ok: false,
    needsSetup: true,
    targets: [],
    error: "Connect and link a Vercel project in Vector Cloud before publishing.",
    nextStep: "Ask the user to connect Vercel and link a project in Vector Cloud > Connections.",
  }
}

async function runCloudCommand(request: CloudCommandInput, options: CloudBridgeOptions) {
  // Cloud state is keyed by the main project; files are read and written in the
  // directory the agent is working in, which is a worktree for a parallel agent.
  const scope = await resolveCloudScope(request.projectPath, (await options.workspaces?.()) ?? [])
  const input = { ...request, projectPath: scope.projectPath }
  if (input.command === "describe") {
    if (input.action === "set_release_settings") {
      return describeReleaseSettings({ ...input.release, ...input, directory: scope.directory })
    }
    return input.action === "sync_environment" || VERCEL_DESCRIBABLE.some((item) => item === input.action)
      ? describeVercelAction(input, scope, options.vercel)
      : describeCloudAction(input, scope, options.request ?? options.vercel?.request)
  }
  if (isReleaseCommand(input.command)) {
    return runReleaseCommand({ ...input.release, ...input, directory: scope.directory })
  }
  if (
    VERCEL_COMMANDS.some((item) => item === input.command) ||
    ["sync_environment", "list_deployments"].includes(input.command)
  ) {
    return runVercelCommand(input, scope, options.vercel)
  }
  const database = getDatabase(input.projectPath, input.taskId)
  if (input.command === "status") {
    const connections = (["vercel", "supabase"] as const).map(cachedCloudProviderConnection)
    const targets = configuredPublishTargets(input)
    // A .vercel/project.json is only a suggestion: linking asks the user first.
    const candidate = getCloudProviderProjectLink(input.projectPath, input.taskId, "vercel")
      ? undefined
      : await vercelProjectCandidate(input.projectPath, scope.directory)
    return {
      ok: true,
      configured: targets.length > 0,
      targets,
      build: getBuildSettings(input.projectPath, input.taskId),
      database: database
        ? {
            connected: true,
            provider: database.provider,
            host: new URL(database.url).hostname,
            projectRef: database.projectRef,
            projectName: database.projectName,
          }
        : { connected: false },
      deployments: deploymentSummaries(input),
      connections,
      vercel: vercelStatusSummary(input.projectPath),
      nextStep: candidate
        ? `This repository's .vercel/project.json names the Vercel project ${candidate.projectId}${candidate.teamId ? ` (teamId ${candidate.teamId})` : ""}. Link it with link_project, which the user approves, before publishing.`
        : undefined,
    }
  }
  if (input.command === "detect_build") {
    return { ok: true, build: await detectBuildSettings(input.projectPath, input.taskId, scope.directory) }
  }
  if (input.command === "database_status") {
    return {
      ok: true,
      database: database
        ? {
            connected: true,
            provider: database.provider,
            host: new URL(database.url).hostname,
            projectRef: database.projectRef,
            projectName: database.projectName,
          }
        : { connected: false },
      nextStep: database
        ? "The project database is ready through Vector Cloud."
        : "No database is connected. Offer to create one with create_database, which creates a real Supabase project on the user's connected Supabase account; if the user already has a Supabase project for this app, find it with supabase_projects and link it with link_database (the user approves both).",
    }
  }
  if (input.command === "create_database") {
    return createCloudDatabase({
      projectPath: input.projectPath,
      taskId: input.taskId,
      directory: scope.directory,
      organizationId: input.organizationId,
      region: input.region,
      force: input.force,
    })
  }
  if (input.command === "prepare_database" || input.command === "prepare_auth") {
    if (!database) {
      return {
        ok: false,
        needsSetup: true,
        error: "No Vector Cloud database is connected.",
        nextStep:
          "Run create_database to create one on the user's connected Supabase account, or link the user's existing project with link_database (supabase_projects lists them).",
      }
    }
    return {
      ok: true,
      database: { connected: true, provider: database.provider, host: new URL(database.url).hostname },
      applied: await applyEnv(input.projectPath, input.taskId, scope.directory),
      purpose: input.command === "prepare_auth" ? "authentication" : "database",
    }
  }
  if (input.command === "cloud_connections") {
    return {
      ok: true,
      connections: await listCloudProviderConnections(),
      links: listCloudProviderProjectLinks(input.projectPath, input.taskId),
    }
  }
  if (input.command === "logs") {
    return fetchCloudLogs({
      projectPath: input.projectPath,
      taskId: input.taskId,
      deploymentId: input.deploymentId,
      limit: input.limit,
      source: input.source,
    })
  }
  if (input.command === "apply_migrations") {
    return applyCloudMigrations(
      {
        projectPath: input.projectPath,
        taskId: input.taskId,
        directory: scope.directory,
        dryRun: input.dryRun === true,
        approvalID: input.approvalID,
      },
      options.request,
    )
  }
  if (!configuredPublishTargets(input).length) return publishSetup()
  // An agent workspace publishes a preview from its worktree, at its branch's
  // stable address. Production only moves once the work is merged and the
  // user asked for production.
  const isolated = scope.directory !== scope.projectPath
  const production = !isolated && input.production === true
  const result = await (options.publish ?? publishProject)({
    projectPath: scope.directory,
    taskId: input.taskId,
    scopeProjectPath: scope.projectPath,
    scopeTaskId: input.taskId,
    workspaceId: scope.workspace?.id,
    workspaceName: scope.workspace?.name,
    target: "vercel",
    production,
    runId: randomUUID(),
  })
  // Vercel makes a project's first deployment production whatever was asked,
  // so a failure is remembered under the environment it actually reached.
  recordPublishAttempt(scope.projectPath, production || result.environment === "production", result)
  return {
    ...result,
    environment: result.environment ?? (production ? "production" : "preview"),
    needsSetup: result.errorCode ? SETUP_CODES.includes(result.errorCode) : undefined,
    nextStep: publishNextStep(result, isolated),
  }
}

const SETUP_CODES = ["not_connected", "not_linked", "no_node", "token_rejected"]

function publishNextStep(result: PublishResult, isolated: boolean) {
  if (result.ok) {
    if (result.environment === "production") {
      return isolated
        ? `Vercel made this agent workspace's release production, because it was the project's first deployment: it is live at ${result.url}. Tell the user.`
        : undefined
    }
    return isolated
      ? `This agent workspace's preview is at ${result.url}; tell the user. Merge the workspace into the main project before promoting it to production.`
      : "This is a preview; production did not change. Publish with production: true only when the user asks to ship to production."
  }
  if (result.errorCode === "no_node")
    return "Ask the user to install Node.js 18 or later (nodejs.org), then publish again."
  if (result.errorCode === "token_rejected")
    return "Ask the user to reconnect Vercel with a new token in Vector Cloud > Connections."
  if (result.errorCode === "not_linked" || result.errorCode === "not_connected") {
    return "Link a project with link_project (see vercel_projects) or create_project, or ask the user to connect Vercel in Vector Cloud > Connections."
  }
  if (result.errorCode === "build_failed") return "Read the build output above, fix the cause, and publish again."
  if (result.errorCode === "checks_blocked") {
    return "Production did not change. Offer enable_protection_bypass (the user approves it) so the checks can open protected builds, then publish to production again."
  }
  if (result.errorCode === "checks_failed") {
    return result.environment === "production"
      ? "Production is serving a release whose checks failed. Offer to roll back with rollback (with no deploymentId it returns to the last deployment that served production and passed Vector's checks), then fix and publish again."
      : "Read the failed checks above, fix the cause, and publish again."
  }
  return "Read the error and log above before trying again."
}

function deploymentSummaries(input: CloudCommandInput) {
  return listDeployments(input.projectPath, input.taskId)
    .slice(0, 20)
    .map((deployment) => ({
      id: deployment.id,
      name: deployment.name,
      url: deployment.productionUrl ?? deployment.url,
      environment: deployment.environment,
      status: deployment.status,
      releaseStatus: deployment.releaseStatus,
      createdAt: deployment.createdAt,
      checks: deployment.checks.map((check) => ({
        label: check.label,
        status: check.status,
        required: check.required,
      })),
    }))
}
