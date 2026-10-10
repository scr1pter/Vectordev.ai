import { randomUUID } from "node:crypto"
import { createServer, type Server } from "node:http"

import { applyEnv, detectBuildSettings, getBuildSettings, getDatabase, listDeployments, listEnv } from "./cloud-console"
import {
  cachedCloudProviderConnection,
  getCloudProviderProjectLink,
  getSupabaseServiceSnapshot,
  listCloudProviderConnections,
  listCloudProviderProjectLinks,
  syncCloudProviderEnvironment,
} from "./cloud-connections"
import { fetchCloudLogs } from "./cloud-logs"
import { applyCloudMigrations } from "./cloud-migrations"
import { createCloudDatabase } from "./cloud-provision"
import { resolveCloudScope, type CloudScope, type CloudWorkspace } from "./cloud-scope"
import { publishProject } from "./publish"

const MAX_BODY_BYTES = 64 * 1024

const COMMANDS = [
  "status",
  "detect_build",
  "database_status",
  "create_database",
  "prepare_database",
  "prepare_auth",
  "cloud_connections",
  "supabase_services",
  "sync_environment",
  "publish",
  "list_deployments",
  "logs",
  "apply_migrations",
  "describe",
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
] as const

type CloudCommand = (typeof COMMANDS)[number]
type CloudAction = (typeof DESCRIBABLE)[number]

type CloudCommandInput = {
  command: CloudCommand
  action?: CloudAction
  projectPath: string
  taskId?: string
  production?: boolean
  provider?: "vercel"
  deploymentId?: string
  limit?: number
  dryRun?: boolean
  organizationId?: string
  region?: string
  force?: boolean
}

let bridgeServer: Server | undefined
let bridgeUrl = ""
let bridgeToken = ""

type CloudBridgeOptions = {
  publish?: typeof publishProject
  /** The desktop's parallel workspaces, so an agent's worktree resolves to its project. */
  workspaces?: () => CloudWorkspace[] | Promise<CloudWorkspace[]>
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
      .then(() => parseCloudCommandInput(JSON.parse(Buffer.concat(chunks).toString("utf8"))))
      .then((input) => runCloudCommand(input, options))
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
  return {
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
function describeCloudAction(input: CloudCommandInput, workspace: CloudScope) {
  const scope = (provider: "Vercel" | "Supabase", project: string, environment: string, summary: string) => ({
    ok: true,
    scope: { provider, project, environment, summary },
  })
  if (input.action === "publish") {
    const target = configuredPublishTargets(input)[0]
    if (!target) return publishSetup()
    if (workspace.directory !== workspace.projectPath) {
      return scope(
        "Vercel",
        target.projectName,
        "preview",
        `Publish this agent workspace to the Vercel project ${target.projectName} as a preview release. Production changes only after it is merged into the main project.`,
      )
    }
    const environment = input.production === false ? "preview" : "production"
    return scope(
      "Vercel",
      target.projectName,
      environment,
      `Publish this project to the Vercel project ${target.projectName} as a ${environment} release.`,
    )
  }
  if (input.action === "sync_environment") {
    const link = getCloudProviderProjectLink(input.projectPath, input.taskId, "vercel")
    if (!link) {
      return {
        ok: false,
        needsSetup: true,
        error: "No Vercel project is linked to this project.",
        nextStep: "Ask the user to connect Vercel and link a project in Cloud Services > Integrations.",
      }
    }
    const count = listEnv(input.projectPath, input.taskId).length
    return scope(
      "Vercel",
      link.projectName,
      "production, preview and development",
      `Write ${count} environment ${count === 1 ? "variable" : "variables"} to the Vercel project ${link.projectName} for production, preview and development.`,
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
        "Run create_database to create one on the user's connected Supabase account, or ask them to link an existing project in Cloud Services > Database.",
    }
  }
  if (input.action === "apply_migrations") {
    return input.dryRun
      ? scope(
          "Supabase",
          name,
          "production",
          `Read which migrations the Supabase project ${name} has applied. Nothing changes.`,
        )
      : scope(
          "Supabase",
          name,
          "production",
          `Apply this project's pending migrations to the Supabase project ${name}. This changes its live database.`,
        )
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
    nextStep: "Ask the user to connect Vercel and link a project in Cloud Services > Integrations.",
  }
}

async function runCloudCommand(request: CloudCommandInput, options: CloudBridgeOptions) {
  // Cloud state is keyed by the main project; files are read and written in the
  // directory the agent is working in, which is a worktree for a parallel agent.
  const scope = await resolveCloudScope(request.projectPath, (await options.workspaces?.()) ?? [])
  const input = { ...request, projectPath: scope.projectPath }
  if (input.command === "describe") return describeCloudAction(input, scope)
  const database = getDatabase(input.projectPath, input.taskId)
  if (input.command === "status") {
    const connections = (["vercel", "supabase"] as const).map(cachedCloudProviderConnection)
    const targets = configuredPublishTargets(input)
    return {
      ok: true,
      configured: targets.length > 0,
      targets,
      build: getBuildSettings(input.projectPath, input.taskId),
      database: database
        ? { connected: true, provider: database.provider, host: new URL(database.url).hostname }
        : { connected: false },
      deployments: deploymentSummaries(input),
      connections,
    }
  }
  if (input.command === "detect_build") {
    return { ok: true, build: await detectBuildSettings(input.projectPath, input.taskId, scope.directory) }
  }
  if (input.command === "database_status") {
    return {
      ok: true,
      database: database
        ? { connected: true, provider: database.provider, host: new URL(database.url).hostname }
        : { connected: false },
      nextStep: database
        ? "The project database is ready through Vector Cloud."
        : "No database is connected. Offer to create one with create_database, which creates a real Supabase project on the user's connected Supabase account; if the user already has a Supabase project for this app, ask them to link it in Vector Cloud > Database instead.",
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
          "Run create_database to create one on the user's connected Supabase account, or ask them to link an existing project in Vector Cloud > Database.",
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
  if (input.command === "supabase_services") {
    return { ok: true, services: await getSupabaseServiceSnapshot(input.projectPath, input.taskId) }
  }
  if (input.command === "sync_environment") {
    return {
      ok: true,
      sync: await syncCloudProviderEnvironment(input.projectPath, input.taskId, input.provider ?? "vercel"),
    }
  }
  if (input.command === "list_deployments") {
    return { ok: true, deployments: deploymentSummaries(input) }
  }
  if (input.command === "logs") {
    return fetchCloudLogs({
      projectPath: input.projectPath,
      taskId: input.taskId,
      deploymentId: input.deploymentId,
      limit: input.limit,
    })
  }
  if (input.command === "apply_migrations") {
    return applyCloudMigrations({
      projectPath: input.projectPath,
      taskId: input.taskId,
      directory: scope.directory,
      dryRun: input.dryRun === true,
    })
  }
  if (!configuredPublishTargets(input).length) return publishSetup()
  // An agent workspace publishes a preview from its worktree. Production only
  // moves once the work is merged into the main project.
  const isolated = scope.directory !== scope.projectPath
  const result = await (options.publish ?? publishProject)({
    projectPath: scope.directory,
    taskId: input.taskId,
    scopeProjectPath: scope.projectPath,
    scopeTaskId: input.taskId,
    workspaceId: scope.workspace?.id,
    workspaceName: scope.workspace?.name,
    target: "vercel",
    production: !isolated && input.production !== false,
    runId: randomUUID(),
  })
  if (!isolated) return result
  return {
    ...result,
    nextStep:
      "This agent workspace was published as a preview. Merge it into the main project before promoting it to production.",
  }
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
