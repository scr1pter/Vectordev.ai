import { Sandbox } from "@vercel/sandbox"
import { ApiError } from "./http.js"
import { createComputerToken } from "./companion.js"
import { decryptPlatformValue, platformAdmin, platformConfiguration } from "./platform.js"
import {
  providerAuthorization,
  providerDefinition,
  providerModelId,
  type ProviderDefinition,
  type SavedProviderSecret,
} from "./provider-catalog.js"
import { buildPluginMcp, cloudReadyTool, TOOL_CATALOG } from "./tool-catalog.js"

export type BuilderRun = {
  id: string
  user_id: string
  project_id: string
  name: string
  prompt: string
  repository_url: string | null
  repository_branch: string | null
  workspace_dir: string | null
  provider: string | null
  model: string
  status: "queued" | "starting" | "running" | "needs_input" | "complete" | "failed" | "canceled"
  current_step: string | null
  sandbox_name: string | null
  command_id: string | null
  preview_command_id: string | null
  preview_url: string | null
  preview_port: number | null
  preview_status: "idle" | "launching" | "ready" | "failed"
  selected_tools: string[]
  summary: string | null
  logs: string | null
  diff: string | null
  diff_stats: Record<string, unknown> | null
  error: string | null
  token_usage: Record<string, unknown> | null
  cost_usd: number | null
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

type SavedConnection = {
  id: string
  plugin_id: string | null
  name: string
  kind: "plugin" | "mcp_remote" | "mcp_local"
  encrypted_config: string
}

type SavedProviderConnection = {
  id: string
  provider_id: string
  name: string
  models: string[]
  encrypted_config: string
}

type BrokerRule = { host: string; headers: Record<string, string> }

export type BuilderProviderRuntime = {
  source: string
  provider: ProviderDefinition
  model: string
  apiKey: string
}

const MAX_LOG_BYTES = 300_000
const MAX_DIFF_BYTES = 750_000
const MAX_AGENT_MINUTES = Math.min(
  120,
  Math.max(10, Number(process.env.VECTOR_BUILDER_MAX_MINUTES) || 30),
)

function builderModels() {
  const configured = (
    process.env.VECTOR_BUILDER_MODELS || process.env.VECTOR_BUILDER_MODEL || ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.startsWith("openrouter/"))
  return [...new Set(configured)]
}

function builderEngineCommand() {
  return process.env.VECTOR_BUILDER_ENGINE_COMMAND?.trim() || "opencode"
}

function builderSandboxImage() {
  const configured = process.env.VECTOR_BUILDER_SANDBOX_IMAGE?.trim()
  if (!configured) return undefined
  return configured.replace(/^https?:\/\//, "").replace(/^vcr\.vercel\.com\/[^/]+\/[^/]+\//, "")
}

export function availableBuilderModels() {
  return builderModels()
}

export function requiredBuilderModel(requested?: string) {
  const models = builderModels()
  if (!models.length)
    throw new ApiError(503, "BUILDER_MODEL_MISSING", "Vector Builder does not have a model configured.")
  if (!requested) return models[0]!
  if (!models.includes(requested))
    throw new ApiError(400, "BUILDER_MODEL_INVALID", "Choose an available Vector Builder model.")
  return requested
}

function sandboxEnvironment(runtime: BuilderProviderRuntime) {
  // The real credential is injected by the sandbox firewall and never enters
  // the customer-controlled VM. The provider SDK only needs a placeholder.
  return { [runtime.provider.env]: "vector-brokered" }
}

function sandboxNetworkPolicy(runtime: BuilderProviderRuntime, brokerRules: BrokerRule[] = []) {
  const providerHeaders = {
    [runtime.provider.header]: providerAuthorization(runtime.provider, runtime.apiKey),
    ...(runtime.provider.id === "openrouter"
      ? { "HTTP-Referer": "https://vectordev.ai", "X-OpenRouter-Title": "Vector Builder" }
      : {}),
  }
  const transformed = new Map<string, Record<string, string>>([[runtime.provider.host, providerHeaders]])
  for (const rule of brokerRules) {
    transformed.set(rule.host, { ...transformed.get(rule.host), ...rule.headers })
  }
  const allow = Object.fromEntries(
    [...transformed].map(([host, headers]) => [host, [{ transform: [{ headers }] }]]),
  )
  return {
    allow: {
      ...allow,
      "*": [],
    },
    subnets: {
      deny: [
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
      ],
    },
  }
}

export async function resolveBuilderProvider(
  userId: string,
  connectionId?: string | null,
  requestedModel?: string,
): Promise<BuilderProviderRuntime> {
  if (connectionId) {
    const { data, error } = await platformAdmin()
      .from("vector_model_connections")
      .select("id,provider_id,name,models,encrypted_config")
      .eq("id", connectionId)
      .eq("user_id", userId)
      .eq("enabled", true)
      .maybeSingle<SavedProviderConnection>()
    if (error) throw new ApiError(500, "PROVIDER_LOAD_FAILED", "Vector could not load the selected model provider.")
    if (!data) throw new ApiError(404, "PROVIDER_NOT_FOUND", "Connect this model provider before launching agents.")
    const provider = providerDefinition(data.provider_id)
    const secret = decryptPlatformValue<SavedProviderSecret>(data.encrypted_config)
    const models = [...new Set([...(data.models || []), ...(secret.models || [])])]
    const model = providerModelId(provider.id, requestedModel || models[0] || "")
    const bareModel = model.slice(provider.id.length + 1)
    if (!models.includes(bareModel)) {
      throw new ApiError(400, "BUILDER_MODEL_INVALID", "Choose a model saved with this provider connection.")
    }
    if (!secret.apiKey) throw new ApiError(409, "PROVIDER_KEY_MISSING", "Reconnect this provider's API key.")
    return { source: `byok:${data.id}`, provider, model, apiKey: secret.apiKey }
  }

  const model = requiredBuilderModel(requestedModel)
  const apiKey = process.env.OPENROUTER_API_KEY?.trim()
  if (!apiKey) {
    throw new ApiError(409, "PROVIDER_REQUIRED", "Connect a model provider before launching a Builder.")
  }
  return { source: "platform:openrouter", provider: providerDefinition("openrouter"), model, apiKey }
}

async function providerForRun(run: BuilderRun) {
  const connectionId = run.provider?.startsWith("byok:") ? run.provider.slice(5) : undefined
  return resolveBuilderProvider(run.user_id, connectionId, run.model)
}

function repositorySource(raw?: string | null, branch?: string | null) {
  if (!raw) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ApiError(400, "REPOSITORY_INVALID", "Enter a valid HTTPS Git repository URL.")
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new ApiError(400, "REPOSITORY_INVALID", "Cloud repositories must use a credential-free HTTPS URL.")
  }
  return { type: "git" as const, url: url.toString(), depth: 50, ...(branch ? { revision: branch } : {}) }
}

function repositoryDirectory(raw?: string | null) {
  if (!raw) return "/vercel/sandbox/workspace"
  const pathname = new URL(raw).pathname
  const name =
    pathname
      .split("/")
      .filter(Boolean)
      .at(-1)
      ?.replace(/\.git$/i, "") || "workspace"
  return `/vercel/sandbox/${name.replace(/[^a-zA-Z0-9._-]/g, "-")}`
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? Object.fromEntries(Object.entries(value)) : undefined
}

function sandboxMissing(error: unknown) {
  const value = record(error)
  const status = value?.status || value?.statusCode
  return status === 404 || (error instanceof Error && /(?:not found|does not exist|404)/i.test(error.message))
}

function sandboxErrorMessage(error: unknown) {
  const value = record(error)
  const json = record(value?.json)
  const detail = record(json?.error)
  const message =
    (typeof detail?.message === "string" && detail.message) ||
    (typeof value?.message === "string" && value.message) ||
    "The isolated workspace could not start."
  return message.slice(0, 2_000)
}

async function readText(sandbox: Sandbox, path: string, maximum: number) {
  const value = await sandbox.readFileToBuffer({ path })
  if (!value) return ""
  const clipped = value.byteLength > maximum ? value.subarray(value.byteLength - maximum) : value
  return clipped.toString("utf8")
}

async function selectedMcpConfig(run: BuilderRun, selected: string[]) {
  const userId = run.user_id
  if (!selected.length) return { mcp: {}, browserEnabled: false, brokerRules: [] as BrokerRule[] }
  const { data, error } = await platformAdmin()
    .from("vector_tool_connections")
    .select("id,plugin_id,name,kind,encrypted_config")
    .eq("user_id", userId)
    .eq("enabled", true)
    .in("id", selected)
  if (error) throw new ApiError(500, "TOOLS_LOAD_FAILED", "Vector could not prepare the selected tools.")
  const mcp: Record<string, unknown> = {}
  let browserEnabled = false
  const brokerRules: BrokerRule[] = []
  for (const connection of (data || []) as SavedConnection[]) {
    const config = decryptPlatformValue<Record<string, unknown>>(connection.encrypted_config)
    if (connection.kind === "plugin" && connection.plugin_id) {
      if (connection.plugin_id === "computer-use" && typeof config.deviceId === "string") {
        const token = createComputerToken({ userId, runId: run.id, deviceId: config.deviceId })
        const origin = (process.env.VECTOR_PUBLIC_URL || "https://vectordev.ai").replace(/\/$/, "")
        mcp[connection.name] = {
          type: "remote",
          url: `${origin}/api/mcp/computer?token=${encodeURIComponent(token)}`,
          oauth: false,
          enabled: true,
          timeout: 300_000,
        }
        browserEnabled = true
        continue
      }
      const plugin = TOOL_CATALOG.find((item) => item.id === connection.plugin_id)
      if (!plugin || !cloudReadyTool(plugin)) continue
      const values =
        config.values && typeof config.values === "object" && !Array.isArray(config.values)
          ? (config.values as Record<string, string>)
          : {}
      const built = buildPluginMcp(connection.plugin_id, values)
      if (built) {
        mcp[connection.name] = built
        browserEnabled ||= connection.plugin_id === "playwright"
      }
      continue
    }
    if (connection.kind === "mcp_remote") {
      const url = new URL(String(config.url))
      const headers =
        config.headers && typeof config.headers === "object" && !Array.isArray(config.headers)
          ? Object.fromEntries(
              Object.entries(config.headers as Record<string, unknown>).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1]),
              ),
            )
          : {}
      if (Object.keys(headers).length) brokerRules.push({ host: url.hostname, headers })
      mcp[connection.name] = {
        type: "remote",
        url: url.toString(),
        oauth: false,
        enabled: true,
        timeout: 120_000,
      }
      continue
    }
    if (connection.kind === "mcp_local") {
      const command = Array.isArray(config.command)
        ? config.command.filter((value): value is string => typeof value === "string" && Boolean(value)).slice(0, 24)
        : []
      if (!command.length) throw new ApiError(409, "MCP_COMMAND_INVALID", `${connection.name} has no command.`)
      mcp[connection.name] = { type: "local", command, enabled: true, timeout: 120_000 }
      continue
    }
  }
  return { mcp, browserEnabled, brokerRules }
}

export async function validateBuilderConnections(userId: string, selected: string[]) {
  const unique = [...new Set(selected.filter((value) => typeof value === "string" && value.length <= 100))].slice(0, 24)
  if (!unique.length) return []
  const { data, error } = await platformAdmin()
    .from("vector_tool_connections")
    .select("id,plugin_id,kind,encrypted_config")
    .eq("user_id", userId)
    .eq("enabled", true)
    .in("id", unique)
  if (error) throw new ApiError(500, "TOOLS_LOAD_FAILED", "Vector could not validate the selected tools.")
  const found = new Set<string>()
  for (const item of (data || []) as SavedConnection[]) {
    if (item.kind === "plugin") {
      if (item.plugin_id === "computer-use") {
        const config = decryptPlatformValue<Record<string, unknown>>(item.encrypted_config)
        if (typeof config.deviceId !== "string") {
          throw new ApiError(409, "DEVICE_NOT_CONNECTED", "Reconnect this computer before using it.")
        }
        const { data: device } = await platformAdmin()
          .from("vector_companion_devices")
          .select("id")
          .eq("id", config.deviceId)
          .eq("user_id", userId)
          .eq("status", "connected")
          .maybeSingle()
        if (!device) throw new ApiError(409, "DEVICE_NOT_CONNECTED", "That paired computer is disconnected.")
        found.add(item.id)
        continue
      }
      const plugin = TOOL_CATALOG.find((entry) => entry.id === item.plugin_id)
      if (!plugin || !cloudReadyTool(plugin)) {
        throw new ApiError(409, "PLUGIN_SETUP_REQUIRED", plugin?.cloudNote || "That plugin is not cloud-ready.")
      }
    } else if (item.kind === "mcp_remote") {
      const config = decryptPlatformValue<Record<string, unknown>>(item.encrypted_config)
      if (!config.url) throw new ApiError(409, "MCP_URL_INVALID", "Reconnect this remote MCP server.")
    } else {
      const config = decryptPlatformValue<Record<string, unknown>>(item.encrypted_config)
      if (!Array.isArray(config.command) || !config.command.length) {
        throw new ApiError(409, "MCP_COMMAND_INVALID", "Reconnect this local MCP command.")
      }
    }
    found.add(item.id)
  }
  if (found.size !== unique.length) {
    throw new ApiError(400, "TOOLS_INVALID", "One or more selected tools are missing or disabled.")
  }
  return unique
}

export function buildBuilderConfig(mcp: Record<string, unknown>, model: string, providerId?: string) {
  const selectedProvider = providerId || model.split("/")[0] || "openrouter"
  const providerModel = model.replace(new RegExp(`^${selectedProvider}/`), "")
  return {
    $schema: "https://opencode.ai/config.json",
    enabled_providers: [selectedProvider],
    provider: {
      [selectedProvider]: {
        ...(selectedProvider === "openrouter"
          ? {
              options: {
                headers: {
                  "HTTP-Referer": "https://vectordev.ai",
                  "X-OpenRouter-Title": "Vector Builder",
                },
              },
            }
          : {}),
        models: {
          [providerModel]: {},
        },
      },
    },
    mcp,
    permission: {
      "*": "allow",
      external_directory: "deny",
      bash: {
        "*": "allow",
        "git push": "deny",
        "git push *": "deny",
        "gh pr create *": "deny",
        "rm -rf /": "deny",
        "rm -rf /*": "deny",
        "sudo *": "deny",
      },
    },
  }
}

function agentPrompt(run: BuilderRun, browserEnabled: boolean) {
  return [
    "You are Vector Builder, an autonomous product engineer working inside an isolated, persistent workspace.",
    run.repository_url
      ? "Build the requested product in the attached repository. Inspect the existing application before editing, preserve its conventions, and run relevant checks."
      : "Create a complete, runnable web application from the user's description. Choose a sensible modern web stack, include the required package scripts, and leave the workspace ready to launch in a browser.",
    "Translate product intent into a coherent interface and working behavior. Do not stop at a plan or a placeholder screen.",
    "Use real project files, keep the implementation focused, and verify the app starts successfully before finishing.",
    "Verify concrete claims where possible, record useful evidence, and never print secrets or credentials.",
    browserEnabled
      ? "A controlled browser or approved computer connection is available. Use it only when the task needs website interaction or UI verification and respect every approval gate."
      : "No controlled browser is connected to this run. Never claim that browser testing was performed.",
    "Finish with a concise product summary, changed files, checks run, and any remaining limitations.",
    "\nTask:\n",
    run.prompt,
  ].join("\n")
}

function parseSummary(logs: string) {
  const lines = logs.split("\n").filter(Boolean)
  const text: string[] = []
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>
      const part = event.part as Record<string, unknown> | undefined
      const candidate = part?.text || event.text || event.message
      if (typeof candidate === "string") text.push(candidate)
    } catch {}
  }
  const joined = text.join("\n").trim() || logs.trim()
  return joined.slice(-6_000) || "The builder finished without a written summary."
}

function parseUsage(logs: string) {
  const totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  let cost = 0
  const seen = new Set<string>()
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return
    const record = value as Record<string, unknown>
    const tokens = record.tokens as Record<string, unknown> | undefined
    if (tokens && typeof tokens === "object") {
      const fingerprint = JSON.stringify(tokens)
      if (!seen.has(fingerprint)) {
        seen.add(fingerprint)
        totals.input += Number(tokens.input) || 0
        totals.output += Number(tokens.output) || 0
        totals.reasoning += Number(tokens.reasoning) || 0
        const cache = tokens.cache as Record<string, unknown> | undefined
        totals.cacheRead += Number(cache?.read) || 0
        totals.cacheWrite += Number(cache?.write) || 0
      }
    }
    if (typeof record.cost === "number") cost += record.cost
    for (const nested of Object.values(record)) if (nested && typeof nested === "object") visit(nested)
  }
  for (const line of logs.split("\n")) {
    try {
      visit(JSON.parse(line))
    } catch {}
  }
  return { tokens: totals, cost: Math.round(cost * 1_000_000) / 1_000_000 }
}

export async function startBuilderRun(run: BuilderRun) {
  if (!platformConfiguration().builderAvailable) {
    throw new ApiError(503, "BUILDER_NOT_CONFIGURED", "Vector Builder is not configured on this deployment.")
  }
  const admin = platformAdmin()
  const { data: claimed, error: claimError } = await admin
    .from("vector_agent_runs")
    .update({ status: "starting", current_step: "Creating isolated workspace", started_at: new Date().toISOString() })
    .eq("id", run.id)
    .eq("user_id", run.user_id)
    .eq("status", "queued")
    .select("id")
    .maybeSingle<{ id: string }>()
  if (claimError) throw new ApiError(500, "AGENT_CLAIM_FAILED", "Vector could not claim the queued builder.")
  if (!claimed) return false
  const sandboxName = `vector-${run.id.replaceAll("-", "").slice(0, 24)}`
  const source = repositorySource(run.repository_url, run.repository_branch)
  const workspace = repositoryDirectory(run.repository_url)
  let sandbox: Sandbox | undefined
  try {
    const providerRuntime = await providerForRun(run)
    const selectedMcp = await selectedMcpConfig(run, run.selected_tools || [])
    sandbox = await Sandbox.create({
      name: sandboxName,
      ...(source ? { source } : {}),
      ...(builderSandboxImage() ? { image: builderSandboxImage() } : {}),
      persistent: true,
      timeout: 24 * 60 * 60 * 1_000,
      resources: { vcpus: 4 },
      ports: [3000, 4173, 5173, 8080],
      env: sandboxEnvironment(providerRuntime),
      networkPolicy: sandboxNetworkPolicy(providerRuntime, selectedMcp.brokerRules),
      tags: { product: "vector", user: run.user_id.slice(0, 16), run: run.id.slice(0, 16) },
    })
    if (!source) {
      await sandbox.runCommand("mkdir", ["-p", workspace])
      await sandbox.runCommand({ cmd: "git", args: ["init"], cwd: workspace })
    }
    await sandbox.runCommand({
      cmd: "bash",
      args: [
        "-lc",
        [
          "mkdir -p .git/info",
          "printf '%s\\n' '.vector-builder/' '.vector-builder-config.json' '.vector-builder-prompt.txt' '.vector-builder-follow-up.txt' >> .git/info/exclude",
          "git config user.name 'Vector Builder'",
          "git config user.email 'builder@vectordev.ai'",
          "git rev-parse --verify HEAD >/dev/null 2>&1 || git commit --allow-empty -m 'Vector Builder baseline' --no-gpg-sign >/dev/null",
          "git rev-parse HEAD > .git/vector-builder-base",
        ].join(" && "),
      ],
      cwd: workspace,
    })
    const prompt = agentPrompt(run, selectedMcp.browserEnabled)
    await sandbox.writeFiles([
      {
        path: `${workspace}/.vector-builder-config.json`,
        content: JSON.stringify(
          buildBuilderConfig(selectedMcp.mcp, providerRuntime.model, providerRuntime.provider.id),
          null,
          2,
        ),
      },
      { path: `${workspace}/.vector-builder-prompt.txt`, content: prompt },
    ])
    const script = [
      "set +e",
      "mkdir -p .vector-builder",
      `MODEL=${JSON.stringify(providerRuntime.model)}`,
      `ENGINE_COMMAND=${JSON.stringify(builderEngineCommand())}`,
      "export OPENCODE_CONFIG_CONTENT=$(cat .vector-builder-config.json)",
      "PROMPT=$(cat .vector-builder-prompt.txt)",
      `timeout --signal=TERM --kill-after=30s ${MAX_AGENT_MINUTES}m "$ENGINE_COMMAND" run --format json --auto --model "$MODEL" "$PROMPT" > .vector-builder/agent.log 2>&1`,
      "EXIT=$?",
      "BASE=$(cat .git/vector-builder-base)",
      "git add -N . >/dev/null 2>&1 || true",
      'git diff --binary "$BASE" -- . > .vector-builder/changes.patch 2>/dev/null || true',
      'git diff --numstat "$BASE" -- . > .vector-builder/changes.numstat 2>/dev/null || true',
      "git status --short > .vector-builder/status.txt 2>/dev/null || true",
      "printf '%s' \"$EXIT\" > .vector-builder/exit-code",
    ].join("\n")
    const command = await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", script],
      cwd: workspace,
      detached: true,
      timeoutMs: (MAX_AGENT_MINUTES + 5) * 60_000,
    })
    const { error } = await admin
      .from("vector_agent_runs")
      .update({
        status: "running",
        current_step: "Agent is inspecting and editing the workspace",
        sandbox_name: sandboxName,
        command_id: command.cmdId,
        workspace_dir: workspace,
        preview_status: "idle",
        preview_command_id: null,
        preview_url: null,
        preview_port: null,
      })
      .eq("id", run.id)
    if (error) {
      throw new ApiError(500, "AGENT_START_FAILED", "Vector could not save the builder session.")
    }
    return true
  } catch (error) {
    if (sandbox) await sandbox.delete().catch(() => sandbox?.stop().catch(() => undefined))
    await admin
      .from("vector_agent_runs")
      .update({
        status: "failed",
        current_step: "Workspace launch failed",
        error: sandboxErrorMessage(error),
        completed_at: new Date().toISOString(),
      })
      .eq("id", run.id)
      .eq("user_id", run.user_id)
      .in("status", ["queued", "starting"])
    throw error
  }
}

export async function refreshBuilderRun(run: BuilderRun) {
  if (run.status !== "running" && run.status !== "starting") return run
  if (!run.sandbox_name || !run.workspace_dir) return run
  let sandbox: Sandbox | undefined
  try {
    sandbox = await Sandbox.get({ name: run.sandbox_name })
  } catch (error) {
    if (!sandboxMissing(error)) {
      throw new ApiError(
        503,
        "AGENT_WORKSPACE_UNAVAILABLE",
        "Vector could not reach the isolated workspace. Try again shortly.",
      )
    }
  }
  if (!sandbox) {
    await platformAdmin()
      .from("vector_agent_runs")
      .update({
        status: "failed",
        error: "The isolated workspace is no longer available.",
        completed_at: new Date().toISOString(),
      })
      .eq("id", run.id)
    return { ...run, status: "failed" as const, error: "The isolated workspace is no longer available." }
  }
  const exit = await readText(sandbox, `${run.workspace_dir}/.vector-builder/exit-code`, 64)
  const logs = await readText(sandbox, `${run.workspace_dir}/.vector-builder/agent.log`, MAX_LOG_BYTES)
  if (!exit) {
    await platformAdmin()
      .from("vector_agent_runs")
      .update({ logs, current_step: logs ? "Agent is working" : "Starting the Vector agent engine" })
      .eq("id", run.id)
    return { ...run, logs }
  }
  const diff = await readText(sandbox, `${run.workspace_dir}/.vector-builder/changes.patch`, MAX_DIFF_BYTES)
  const numstat = await readText(sandbox, `${run.workspace_dir}/.vector-builder/changes.numstat`, 100_000)
  const files = numstat
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added, deleted, ...path] = line.split("\t")
      return { path: path.join("\t"), added: Number(added) || 0, deleted: Number(deleted) || 0 }
    })
  const failed = Number(exit.trim()) !== 0
  const usage = parseUsage(logs)
  const updated = {
    status: failed ? "failed" : "complete",
    current_step: failed ? "Agent run failed" : "Ready for review",
    logs,
    diff,
    diff_stats: {
      files,
      changedFiles: files.length,
      additions: files.reduce((total, item) => total + item.added, 0),
      deletions: files.reduce((total, item) => total + item.deleted, 0),
    },
    summary: parseSummary(logs),
    token_usage: usage.tokens,
    cost_usd: usage.cost,
    error: failed ? "The agent command failed. Review the execution log for details." : null,
    completed_at: new Date().toISOString(),
  }
  const { data: finalized } = await platformAdmin()
    .from("vector_agent_runs")
    .update(updated)
    .eq("id", run.id)
    .eq("user_id", run.user_id)
    .in("status", ["running", "starting"])
    .select("id")
    .maybeSingle()
  if (!finalized) return run
  await platformAdmin()
    .from("vector_agent_messages")
    .insert({
      run_id: run.id,
      user_id: run.user_id,
      role: "assistant",
      content: updated.summary,
      metadata: { status: updated.status, diffStats: updated.diff_stats },
    })
  await sandbox.stop().catch(() => undefined)
  return { ...run, ...updated } as BuilderRun
}

async function stopPreviewCommand(sandbox: Sandbox, run: BuilderRun) {
  if (!run.preview_command_id) return
  const command = await sandbox.getCommand(run.preview_command_id).catch(() => undefined)
  await command?.kill("SIGTERM").catch(() => undefined)
}

function packageRunner(packageJson: Record<string, unknown>) {
  const dependencies = {
    ...(record(packageJson.dependencies) || {}),
    ...(record(packageJson.devDependencies) || {}),
  }
  const scripts = record(packageJson.scripts) || {}
  const has = (name: string) => typeof dependencies[name] === "string"
  if (typeof scripts.dev === "string") {
    if (has("next")) return { port: 3000, command: "npm run dev -- --hostname 0.0.0.0 --port 3000" }
    if (has("vite") || has("astro")) return { port: 5173, command: "npm run dev -- --host 0.0.0.0 --port 5173" }
    return { port: 3000, command: "HOST=0.0.0.0 PORT=3000 npm run dev" }
  }
  if (typeof scripts.start === "string") {
    return { port: 3000, command: "HOST=0.0.0.0 PORT=3000 npm run start" }
  }
  if (typeof scripts.preview === "string") {
    return { port: 4173, command: "npm run preview -- --host 0.0.0.0 --port 4173" }
  }
  throw new ApiError(409, "PREVIEW_SCRIPT_MISSING", "The app does not expose a dev, start, or preview script yet.")
}

async function previewRecipe(sandbox: Sandbox, workspace: string) {
  const packageBuffer = await sandbox.readFileToBuffer({ path: `${workspace}/package.json` })
  if (!packageBuffer) {
    const index = await sandbox.readFileToBuffer({ path: `${workspace}/index.html` })
    if (!index) {
      throw new ApiError(409, "PREVIEW_APP_MISSING", "Vector Builder has not produced a launchable web app yet.")
    }
    return { port: 8080, install: "true", command: "python3 -m http.server 8080 --bind 0.0.0.0" }
  }
  let packageJson: Record<string, unknown>
  try {
    packageJson = JSON.parse(packageBuffer.toString("utf8")) as Record<string, unknown>
  } catch {
    throw new ApiError(409, "PREVIEW_PACKAGE_INVALID", "The generated package.json is not valid JSON.")
  }
  const runner = packageRunner(packageJson)
  const install = [
    "if [ ! -d node_modules ]; then",
    "  if [ -f bun.lock ] || [ -f bun.lockb ]; then bun install;",
    "  elif [ -f pnpm-lock.yaml ]; then corepack pnpm install;",
    "  elif [ -f yarn.lock ]; then corepack yarn install;",
    "  elif [ -f package-lock.json ]; then npm ci || npm install;",
    "  else npm install; fi",
    "fi",
  ].join(" ")
  return { ...runner, install }
}

export async function launchBuilderPreview(run: BuilderRun) {
  if (!run.sandbox_name || !run.workspace_dir) {
    throw new ApiError(409, "PREVIEW_WORKSPACE_MISSING", "Finish the first build before opening its preview.")
  }
  const admin = platformAdmin()
  await admin
    .from("vector_agent_runs")
    .update({ preview_status: "launching", preview_url: null })
    .eq("id", run.id)
    .eq("user_id", run.user_id)
  try {
    const sandbox = await Sandbox.get({ name: run.sandbox_name })
    await stopPreviewCommand(sandbox, run)
    const recipe = await previewRecipe(sandbox, run.workspace_dir)
    const install = await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", recipe.install],
      cwd: run.workspace_dir,
      timeoutMs: 240_000,
    })
    if (install.exitCode !== 0) {
      throw new ApiError(409, "PREVIEW_INSTALL_FAILED", "The generated app's dependencies could not be installed.")
    }
    const command = await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", `mkdir -p .vector-builder && ${recipe.command} > .vector-builder/preview.log 2>&1`],
      cwd: run.workspace_dir,
      detached: true,
      timeoutMs: 24 * 60 * 60 * 1_000,
    })
    const readiness = await sandbox.runCommand({
      cmd: "bash",
      args: [
        "-lc",
        `for attempt in $(seq 1 40); do curl -fsS http://127.0.0.1:${recipe.port}/ >/dev/null && exit 0; sleep 1; done; exit 1`,
      ],
      cwd: run.workspace_dir,
      timeoutMs: 45_000,
    })
    if (readiness.exitCode !== 0) {
      const previewLog = await readText(sandbox, `${run.workspace_dir}/.vector-builder/preview.log`, 20_000)
      await command.kill("SIGTERM").catch(() => undefined)
      throw new ApiError(
        409,
        "PREVIEW_START_FAILED",
        previewLog.trim().slice(-1_500) || "The generated app did not become ready in time.",
      )
    }
    const previewUrl = sandbox.domain(recipe.port)
    await admin
      .from("vector_agent_runs")
      .update({
        preview_status: "ready",
        preview_command_id: command.cmdId,
        preview_url: previewUrl,
        preview_port: recipe.port,
      })
      .eq("id", run.id)
      .eq("user_id", run.user_id)
    return { url: previewUrl, port: recipe.port, commandId: command.cmdId, status: "ready" as const }
  } catch (error) {
    await admin
      .from("vector_agent_runs")
      .update({
        preview_status: "failed",
        preview_command_id: null,
        preview_url: null,
        preview_port: null,
      })
      .eq("id", run.id)
      .eq("user_id", run.user_id)
    throw error
  }
}

export async function stopBuilderRun(run: BuilderRun) {
  if (run.sandbox_name) {
    let sandbox: Sandbox | undefined
    try {
      sandbox = await Sandbox.get({ name: run.sandbox_name })
    } catch (error) {
      if (!sandboxMissing(error)) throw error
    }
    if (sandbox) {
      if (run.command_id) {
        const command = await sandbox.getCommand(run.command_id).catch(() => undefined)
        await command?.kill("SIGTERM").catch(() => undefined)
      }
      await stopPreviewCommand(sandbox, run)
      await sandbox.stop()
    }
  }
  await platformAdmin()
    .from("vector_agent_runs")
    .update({ status: "canceled", current_step: "Stopped by user", completed_at: new Date().toISOString() })
    .eq("id", run.id)
    .eq("user_id", run.user_id)
    .in("status", ["queued", "starting", "running", "needs_input"])
}

export async function deleteBuilderWorkspace(run: BuilderRun) {
  if (!run.sandbox_name) return
  let sandbox: Sandbox | undefined
  try {
    sandbox = await Sandbox.get({ name: run.sandbox_name })
  } catch (error) {
    if (!sandboxMissing(error)) throw error
  }
  if (sandbox) await sandbox.delete()
}

export async function continueBuilderRun(run: BuilderRun, prompt: string) {
  if (run.status === "running" || run.status === "starting") {
    throw new ApiError(409, "AGENT_BUSY", "This builder is still working. Wait for it to finish before continuing.")
  }
  if (!run.sandbox_name || !run.workspace_dir)
    throw new ApiError(409, "AGENT_WORKSPACE_MISSING", "This run has no resumable workspace.")
  const { data: claimed } = await platformAdmin()
    .from("vector_agent_runs")
    .update({ status: "starting", current_step: "Preparing the next turn", completed_at: null, error: null })
    .eq("id", run.id)
    .eq("user_id", run.user_id)
    .in("status", ["complete", "failed", "needs_input"])
    .select("id")
    .maybeSingle()
  if (!claimed) throw new ApiError(409, "AGENT_BUSY", "This builder is already working or was stopped.")
  try {
    const sandbox = await Sandbox.get({ name: run.sandbox_name })
    await stopPreviewCommand(sandbox, run)
    const promptPath = `${run.workspace_dir}/.vector-builder-follow-up.txt`
    await sandbox.writeFiles([{ path: promptPath, content: prompt }])
    const script = [
      "set +e",
      "rm -f .vector-builder/exit-code",
      `ENGINE_COMMAND=${JSON.stringify(builderEngineCommand())}`,
      "export OPENCODE_CONFIG_CONTENT=$(cat .vector-builder-config.json)",
      "PROMPT=$(cat .vector-builder-follow-up.txt)",
      `MODEL=${JSON.stringify(run.model)}`,
      `timeout --signal=TERM --kill-after=30s ${MAX_AGENT_MINUTES}m "$ENGINE_COMMAND" run --continue --format json --auto --model "$MODEL" "$PROMPT" >> .vector-builder/agent.log 2>&1`,
      "EXIT=$?",
      "BASE=$(cat .git/vector-builder-base)",
      "git add -N . >/dev/null 2>&1 || true",
      'git diff --binary "$BASE" -- . > .vector-builder/changes.patch 2>/dev/null || true',
      'git diff --numstat "$BASE" -- . > .vector-builder/changes.numstat 2>/dev/null || true',
      "printf '%s' \"$EXIT\" > .vector-builder/exit-code",
    ].join("\n")
    const command = await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", script],
      cwd: run.workspace_dir,
      detached: true,
      timeoutMs: (MAX_AGENT_MINUTES + 5) * 60_000,
    })
    await platformAdmin()
      .from("vector_agent_runs")
      .update({
        status: "running",
        current_step: "Continuing the agent session",
        command_id: command.cmdId,
        completed_at: null,
        error: null,
        preview_status: "idle",
        preview_command_id: null,
        preview_url: null,
        preview_port: null,
      })
      .eq("id", run.id)
      .eq("user_id", run.user_id)
    return command.cmdId
  } catch (error) {
    await platformAdmin()
      .from("vector_agent_runs")
      .update({
        status: "failed",
        current_step: "Continuation failed",
        error: error instanceof Error ? error.message.slice(0, 2_000) : "The builder could not continue.",
        completed_at: new Date().toISOString(),
      })
      .eq("id", run.id)
      .eq("user_id", run.user_id)
      .eq("status", "starting")
    throw error
  }
}
