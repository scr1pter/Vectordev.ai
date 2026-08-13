import { verifyComputerToken } from "../_lib/companion.js"
import { ApiError, handleApiError, json, queryValue, readJson, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { platformAdmin } from "../_lib/platform.js"

type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

export const maxDuration = 300

const browserOperations = [
  "openUrl",
  "click",
  "type",
  "press",
  "wait",
  "waitForSelector",
  "waitForText",
  "takeScreenshot",
  "inspectDom",
  "inspectComputedStyles",
  "inspectPageHtml",
  "reload",
  "goBack",
  "goForward",
  "scroll",
] as const

function rpc(response: ApiResponse, id: RpcRequest["id"], result: unknown) {
  json(response, 200, { jsonrpc: "2.0", id: id ?? null, result })
}

function toolResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  }
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

async function waitForCommand(id: string) {
  const admin = platformAdmin()
  const deadline = Date.now() + 4 * 60 * 1_000
  while (Date.now() < deadline) {
    const { data } = await admin
      .from("vector_companion_commands")
      .select("status,result,error")
      .eq("id", id)
      .maybeSingle()
    if (!data) return toolResult("The computer command disappeared before it completed.", true)
    if (["success", "failed", "denied", "canceled"].includes(data.status)) {
      if (data.status === "success") return toolResult(data.result || { ok: true })
      return toolResult(data.error || `The user ${data.status} this computer command.`, true)
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  return toolResult("The computer did not answer before this command timed out.", true)
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    if (request.method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use POST for this MCP server.")
    const identity = verifyComputerToken(queryValue(request, "token"))
    const body = await readJson<RpcRequest>(request, 256_000)
    if (body.method === "notifications/initialized") {
      response.statusCode = 202
      response.end()
      return
    }
    if (body.method === "initialize") {
      rpc(response, body.id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "Vector Computer Companion", version: "1.0.0" },
      })
      return
    }
    if (body.method === "tools/list") {
      rpc(response, body.id, {
        tools: [
          {
            name: "computer_status",
            description: "Check whether the user's explicitly paired Vector desktop is online.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
          {
            name: "computer_browser",
            description:
              "Control the paired computer's isolated Vector browser. Every action is shown to the user for approval.",
            inputSchema: {
              type: "object",
              required: ["operation"],
              properties: {
                operation: { type: "string", enum: browserOperations },
                url: { type: "string" },
                selector: { type: "string" },
                text: { type: "string" },
                key: { type: "string" },
                milliseconds: { type: "number" },
                deltaY: { type: "number" },
              },
              additionalProperties: false,
            },
          },
          {
            name: "computer_shell",
            description:
              "Run one exact terminal command on the paired computer after the user reviews and approves the command locally.",
            inputSchema: {
              type: "object",
              required: ["command"],
              properties: { command: { type: "string", maxLength: 12000 }, cwd: { type: "string", maxLength: 4096 } },
              additionalProperties: false,
            },
          },
        ],
      })
      return
    }
    if (body.method !== "tools/call") {
      throw new ApiError(400, "MCP_METHOD_INVALID", "That MCP method is not supported.")
    }
    const name = typeof body.params?.name === "string" ? body.params.name : ""
    const args = objectValue(body.params?.arguments) || {}
    const admin = platformAdmin()
    const { data: device } = await admin
      .from("vector_companion_devices")
      .select("id,status,last_seen_at,permissions")
      .eq("id", identity.deviceId)
      .eq("user_id", identity.userId)
      .eq("status", "connected")
      .maybeSingle()
    if (!device) {
      rpc(response, body.id, toolResult("The paired computer is disconnected.", true))
      return
    }
    const permissions = Array.isArray(device.permissions)
      ? device.permissions.filter((permission: unknown): permission is string => typeof permission === "string")
      : []
    if (name === "computer_status") {
      const lastSeen = device.last_seen_at ? new Date(device.last_seen_at).getTime() : 0
      rpc(response, body.id, toolResult({ connected: true, online: Date.now() - lastSeen < 30_000, lastSeenAt: device.last_seen_at }))
      return
    }
    let action: "browser" | "shell"
    let payload: Record<string, unknown>
    if (name === "computer_browser") {
      const operation = typeof args.operation === "string" ? args.operation : ""
      if (!permissions.includes("browser") || !browserOperations.some((candidate) => candidate === operation)) {
        rpc(response, body.id, toolResult("Browser control is not permitted or the operation is invalid.", true))
        return
      }
      action = "browser"
      payload = { ...args, operation, contextId: `builder-${identity.runId}` }
    } else if (name === "computer_shell") {
      if (!permissions.includes("shell") || typeof args.command !== "string" || !args.command.trim()) {
        rpc(response, body.id, toolResult("Terminal access is not enabled for this computer.", true))
        return
      }
      action = "shell"
      payload = { command: args.command.slice(0, 12_000), cwd: typeof args.cwd === "string" ? args.cwd.slice(0, 4_096) : undefined }
    } else {
      rpc(response, body.id, toolResult("That computer tool does not exist.", true))
      return
    }
    const { data: command, error } = await admin
      .from("vector_companion_commands")
      .insert({
        user_id: identity.userId,
        device_id: identity.deviceId,
        run_id: identity.runId,
        action,
        payload,
        risk: action === "shell" ? "high" : "medium",
      })
      .select("id")
      .single()
    if (error || !command) throw new ApiError(500, "COMPUTER_COMMAND_FAILED", "Vector could not queue the computer command.")
    rpc(response, body.id, await waitForCommand(command.id))
  } catch (error) {
    handleApiError(response, error)
  }
}
