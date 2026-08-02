import { randomUUID } from "node:crypto"
import { createServer, type Server } from "node:http"

import {
  applyEnv,
  detectBuildSettings,
  getBuildSettings,
  getDatabase,
  listDeployments,
} from "./cloud-console"
import { publishProject } from "./publish"

const MAX_BODY_BYTES = 64 * 1024

type CloudCommand =
  | "status"
  | "detect_build"
  | "database_status"
  | "prepare_database"
  | "publish"
  | "list_deployments"

type CloudAgentInput = {
  command: CloudCommand
  projectPath: string
  taskId?: string
  production?: boolean
}

let bridgeServer: Server | undefined
let bridgeUrl = ""
let bridgeToken = ""

export async function startCloudAgentBridge() {
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
      .then(() => parseCloudAgentInput(JSON.parse(Buffer.concat(chunks).toString("utf8"))))
      .then(runCloudAgentCommand)
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
  if (!address || typeof address === "string") throw new Error("Vector Cloud agent bridge failed to bind")
  bridgeUrl = `http://127.0.0.1:${address.port}`
  return { url: bridgeUrl, token: bridgeToken }
}

export async function stopCloudAgentBridge() {
  const current = bridgeServer
  bridgeServer = undefined
  bridgeUrl = ""
  bridgeToken = ""
  if (!current) return
  await new Promise<void>((resolve) => current.close(() => resolve()))
}

function parseCloudAgentInput(value: unknown): CloudAgentInput {
  if (!value || typeof value !== "object") throw new Error("Cloud command must be an object.")
  const command = Reflect.get(value, "command")
  const projectPath = Reflect.get(value, "projectPath")
  const taskId = Reflect.get(value, "taskId")
  const production = Reflect.get(value, "production")
  if (
    command !== "status" &&
    command !== "detect_build" &&
    command !== "database_status" &&
    command !== "prepare_database" &&
    command !== "publish" &&
    command !== "list_deployments"
  ) {
    throw new Error("Unsupported Vector Cloud command.")
  }
  if (typeof projectPath !== "string" || !projectPath.trim()) throw new Error("Open a project before using Vector Cloud.")
  if (taskId !== undefined && typeof taskId !== "string") throw new Error("Invalid project session.")
  if (production !== undefined && typeof production !== "boolean") throw new Error("Invalid publish mode.")
  return { command, projectPath, taskId, production }
}

async function runCloudAgentCommand(input: CloudAgentInput) {
  const database = getDatabase(input.projectPath, input.taskId)
  if (input.command === "status") {
    return {
      ok: true,
      configured: Boolean(process.env.VECTOR_CLOUD_URL && process.env.VECTOR_CLOUD_TOKEN),
      build: getBuildSettings(input.projectPath, input.taskId),
      database: database
        ? { connected: true, provider: database.provider, host: new URL(database.url).hostname }
        : { connected: false },
      deployments: deploymentSummaries(input),
    }
  }
  if (input.command === "detect_build") {
    return { ok: true, build: await detectBuildSettings(input.projectPath, input.taskId) }
  }
  if (input.command === "database_status") {
    return {
      ok: true,
      database: database
        ? { connected: true, provider: database.provider, host: new URL(database.url).hostname }
        : { connected: false },
      nextStep: database
        ? "The project database is ready through Vector Cloud."
        : "Ask the user to connect a database in Vector Cloud > Database before implementing persistent auth or data.",
    }
  }
  if (input.command === "prepare_database") {
    if (!database) {
      return {
        ok: false,
        needsSetup: true,
        error: "No Vector Cloud database is connected. Ask the user to open Vector Cloud > Database and connect it.",
      }
    }
    return {
      ok: true,
      database: { connected: true, provider: database.provider, host: new URL(database.url).hostname },
      applied: await applyEnv(input.projectPath, input.taskId),
    }
  }
  if (input.command === "list_deployments") {
    return { ok: true, deployments: deploymentSummaries(input) }
  }
  return publishProject({
    projectPath: input.projectPath,
    taskId: input.taskId,
    target: "vector-cloud",
    production: input.production !== false,
    runId: randomUUID(),
  })
}

function deploymentSummaries(input: CloudAgentInput) {
  return listDeployments(input.projectPath, input.taskId).slice(0, 20).map((deployment) => ({
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
