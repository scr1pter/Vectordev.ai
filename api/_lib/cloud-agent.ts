import { Sandbox } from "@vercel/sandbox"
import { ApiError } from "./http.js"
import { decryptPlatformValue, platformAdmin, platformConfiguration } from "./platform.js"
import { buildPluginMcp, cloudReadyTool, TOOL_CATALOG } from "./tool-catalog.js"

export type CloudAgentRun = {
  id: string
  user_id: string
  team_id: string | null
  role: "worker" | "integrator"
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

const MAX_LOG_BYTES = 300_000
const MAX_DIFF_BYTES = 750_000
const MAX_AGENT_MINUTES = Math.min(120, Math.max(10, Number(process.env.VECTOR_CLOUD_AGENT_MAX_MINUTES) || 30))

function cloudModels() {
  const configured = (process.env.VECTOR_CLOUD_AGENT_MODELS || process.env.VECTOR_CLOUD_AGENT_MODEL || "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.startsWith("openrouter/"))
  return [...new Set(configured)]
}

function cloudEngineCommand() {
  return process.env.VECTOR_CLOUD_AGENT_ENGINE_COMMAND?.trim() || "opencode"
}

function cloudSandboxImage() {
  const configured = process.env.VECTOR_CLOUD_SANDBOX_IMAGE?.trim()
  if (!configured) return undefined
  return configured.replace(/^https?:\/\//, "").replace(/^vcr\.vercel\.com\/[^/]+\/[^/]+\//, "")
}

export function availableCloudModels() {
  return cloudModels()
}

export function requiredCloudModel(requested?: string) {
  const models = cloudModels()
  if (!models.length)
    throw new ApiError(503, "CLOUD_MODEL_MISSING", "Vector Cloud Agents do not have a model configured.")
  if (!requested) return models[0]
  if (!models.includes(requested))
    throw new ApiError(400, "CLOUD_MODEL_INVALID", "Choose an available Vector cloud model.")
  return requested
}

function sandboxEnvironment() {
  // The real credential is injected by the sandbox firewall and never enters
  // the customer-controlled VM. The provider SDK only needs a placeholder.
  return { OPENROUTER_API_KEY: "vector-brokered" }
}

function sandboxNetworkPolicy() {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new ApiError(503, "CLOUD_GATEWAY_MISSING", "Vector Cloud Agents do not have OpenRouter configured.")
  return {
    allow: {
      "openrouter.ai": [{ transform: [{ headers: { Authorization: `Bearer ${key}` } }] }],
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

async function selectedMcpConfig(userId: string, selected: string[]) {
  if (!selected.length) return { mcp: {}, browserEnabled: false }
  const { data, error } = await platformAdmin()
    .from("vector_tool_connections")
    .select("id,plugin_id,name,kind,encrypted_config")
    .eq("user_id", userId)
    .eq("enabled", true)
    .in("id", selected)
  if (error) throw new ApiError(500, "TOOLS_LOAD_FAILED", "Vector could not prepare the selected tools.")
  const mcp: Record<string, unknown> = {}
  let browserEnabled = false
  for (const connection of (data || []) as SavedConnection[]) {
    const config = decryptPlatformValue<Record<string, unknown>>(connection.encrypted_config)
    if (connection.kind === "plugin" && connection.plugin_id) {
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
      mcp[connection.name] = {
        type: "remote",
        url: config.url,
        oauth: false,
        enabled: true,
        timeout: 120_000,
      }
      continue
    }
    throw new ApiError(409, "MCP_LOCAL_UNAVAILABLE", "Local MCP commands cannot run in Vector Cloud Agents.")
  }
  return { mcp, browserEnabled }
}

export async function validateCloudConnections(userId: string, selected: string[]) {
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
      const plugin = TOOL_CATALOG.find((entry) => entry.id === item.plugin_id)
      if (!plugin || !cloudReadyTool(plugin)) {
        throw new ApiError(409, "PLUGIN_SETUP_REQUIRED", plugin?.cloudNote || "That plugin is not cloud-ready.")
      }
    } else if (item.kind === "mcp_remote") {
      const config = decryptPlatformValue<Record<string, unknown>>(item.encrypted_config)
      if (config.headers && Object.keys(config.headers as object).length) {
        throw new ApiError(409, "MCP_SECRET_BROKER_REQUIRED", "Authenticated custom MCP servers are not cloud-ready.")
      }
    } else {
      throw new ApiError(409, "MCP_LOCAL_UNAVAILABLE", "Local MCP commands cannot run in Vector Cloud Agents.")
    }
    found.add(item.id)
  }
  if (found.size !== unique.length) {
    throw new ApiError(400, "TOOLS_INVALID", "One or more selected tools are missing or disabled.")
  }
  return unique
}

export function buildCloudAgentConfig(mcp: Record<string, unknown>, model: string) {
  const providerModel = model.replace(/^openrouter\//, "")
  return {
    $schema: "https://opencode.ai/config.json",
    enabled_providers: ["openrouter"],
    provider: {
      openrouter: {
        options: {
          headers: {
            "HTTP-Referer": "https://vectordev.ai",
            "X-OpenRouter-Title": "Vector Cloud Agents",
          },
        },
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

async function teamContext(run: CloudAgentRun) {
  if (!run.team_id) return ""
  const admin = platformAdmin()
  const [{ data: team }, { data: teammates }] = await Promise.all([
    admin
      .from("vector_agent_teams")
      .select("name,objective")
      .eq("id", run.team_id)
      .eq("user_id", run.user_id)
      .maybeSingle(),
    admin
      .from("vector_agent_runs")
      .select("name,prompt,status,current_step,summary")
      .eq("team_id", run.team_id)
      .eq("user_id", run.user_id)
      .neq("id", run.id)
      .order("created_at")
      .limit(12),
  ])
  const teammateRows = (teammates || []) as Array<{
    name: string
    prompt: string
    status: string
    current_step: string | null
    summary: string | null
  }>
  const roster = teammateRows.length
    ? teammateRows
        .map((item) => `- ${item.name} [${item.status}]: ${item.summary || item.current_step || item.prompt}`)
        .join("\n")
    : "- No teammate runs have started yet."
  const instruction =
    run.role === "integrator"
      ? "Produce one coherent integration and document any unresolved conflict for human review."
      : "Stay within your assigned mission, account for teammate responsibilities, and report integration assumptions clearly."
  return `\n\nAgent team: ${team?.name || "Vector team"}\nShared objective: ${team?.objective || run.prompt}\nTeam roster and current results:\n${roster}\n${instruction}`
}

function agentPrompt(run: CloudAgentRun, teammateContext: string, browserEnabled: boolean) {
  return [
    "You are a Vector Cloud Agent working inside an isolated repository workspace.",
    run.role === "integrator"
      ? "You are the team's integration agent. Teammate patches have already been applied where possible. Resolve conflicts and rejected hunks, combine the implementations into one coherent result, and validate the integrated project."
      : "Stay focused on your assigned mission; an integration agent will combine coordinated team results after the workers finish.",
    "Complete the requested work directly in this workspace. Inspect existing code before editing.",
    "Run relevant checks, fix failures you introduce, and never print secrets or credentials.",
    browserEnabled
      ? "A controlled browser is connected. Use it when the task needs website interaction or UI verification."
      : "No controlled browser is connected to this run. Never claim that browser testing was performed.",
    "Finish with a concise summary, changed files, checks run, remaining risks, and any approval you need.",
    teammateContext,
    "\nTask:\n",
    run.prompt,
  ].join("\n")
}

async function seedTeamPatches(sandbox: Sandbox, run: CloudAgentRun, workspace: string) {
  if (run.role !== "integrator" || !run.team_id) return
  const { data, error } = await platformAdmin()
    .from("vector_agent_runs")
    .select("id,name,diff")
    .eq("team_id", run.team_id)
    .eq("user_id", run.user_id)
    .eq("role", "worker")
    .eq("status", "complete")
    .order("created_at")
  if (error) throw new ApiError(500, "TEAM_PATCHES_FAILED", "Vector could not prepare the team's completed changes.")
  const patchRows = (data || []) as Array<{ id: string; name: string; diff: string | null }>
  const patches = patchRows.filter((item): item is { id: string; name: string; diff: string } =>
    Boolean(typeof item.diff === "string" && item.diff.trim()),
  )
  if (!patches.length) return
  await sandbox.runCommand("mkdir", ["-p", `${workspace}/.git/vector-cloud-team-patches`])
  await sandbox.writeFiles(
    patches.map((item, index) => ({
      path: `${workspace}/.git/vector-cloud-team-patches/${String(index + 1).padStart(2, "0")}-${item.id}.patch`,
      content: item.diff,
    })),
  )
  await sandbox.runCommand({
    cmd: "bash",
    args: [
      "-lc",
      [
        "set +e",
        "for PATCH in .git/vector-cloud-team-patches/*.patch; do",
        '  [ -s "$PATCH" ] || continue',
        '  git apply --3way --whitespace=nowarn "$PATCH" >/dev/null 2>&1 || git apply --reject --whitespace=nowarn "$PATCH" >/dev/null 2>&1 || true',
        "done",
        "exit 0",
      ].join("\n"),
    ],
    cwd: workspace,
  })
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
  return joined.slice(-6_000) || "The cloud agent finished without a written summary."
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

export async function startCloudAgent(run: CloudAgentRun) {
  if (!platformConfiguration().cloudAgentsAvailable) {
    throw new ApiError(503, "CLOUD_AGENTS_NOT_CONFIGURED", "Vector Cloud Agents are not configured on this deployment.")
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
  if (claimError) throw new ApiError(500, "AGENT_CLAIM_FAILED", "Vector could not claim the queued cloud agent.")
  if (!claimed) return false
  const sandboxName = `vector-${run.id.replaceAll("-", "").slice(0, 24)}`
  const source = repositorySource(run.repository_url, run.repository_branch)
  const workspace = repositoryDirectory(run.repository_url)
  let sandbox: Sandbox | undefined
  try {
    sandbox = await Sandbox.create({
      name: sandboxName,
      ...(source ? { source } : {}),
      ...(cloudSandboxImage() ? { image: cloudSandboxImage() } : {}),
      persistent: true,
      timeout: 24 * 60 * 60 * 1_000,
      resources: { vcpus: 4 },
      ports: [3000, 4173, 5173, 8080],
      env: sandboxEnvironment(),
      networkPolicy: sandboxNetworkPolicy(),
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
          "printf '%s\\n' '.vector-cloud/' '.vector-cloud-config.json' '.vector-cloud-prompt.txt' '.vector-cloud-follow-up.txt' >> .git/info/exclude",
          "git config user.name 'Vector Cloud Agent'",
          "git config user.email 'cloud-agent@vectordev.ai'",
          "git rev-parse --verify HEAD >/dev/null 2>&1 || git commit --allow-empty -m 'Vector cloud baseline' --no-gpg-sign >/dev/null",
          "git rev-parse HEAD > .git/vector-cloud-base",
        ].join(" && "),
      ],
      cwd: workspace,
    })
    await seedTeamPatches(sandbox, run, workspace)
    const { mcp, browserEnabled } = await selectedMcpConfig(run.user_id, run.selected_tools || [])
    const prompt = agentPrompt(run, await teamContext(run), browserEnabled)
    await sandbox.writeFiles([
      {
        path: `${workspace}/.vector-cloud-config.json`,
        content: JSON.stringify(buildCloudAgentConfig(mcp, run.model), null, 2),
      },
      { path: `${workspace}/.vector-cloud-prompt.txt`, content: prompt },
    ])
    const script = [
      "set +e",
      "mkdir -p .vector-cloud",
      `MODEL=${JSON.stringify(run.model)}`,
      `ENGINE_COMMAND=${JSON.stringify(cloudEngineCommand())}`,
      "export OPENCODE_CONFIG_CONTENT=$(cat .vector-cloud-config.json)",
      "PROMPT=$(cat .vector-cloud-prompt.txt)",
      `timeout --signal=TERM --kill-after=30s ${MAX_AGENT_MINUTES}m "$ENGINE_COMMAND" run --format json --auto --model "$MODEL" "$PROMPT" > .vector-cloud/agent.log 2>&1`,
      "EXIT=$?",
      "BASE=$(cat .git/vector-cloud-base)",
      "git add -N . >/dev/null 2>&1 || true",
      'git diff --binary "$BASE" -- . > .vector-cloud/changes.patch 2>/dev/null || true',
      'git diff --numstat "$BASE" -- . > .vector-cloud/changes.numstat 2>/dev/null || true',
      "git status --short > .vector-cloud/status.txt 2>/dev/null || true",
      "printf '%s' \"$EXIT\" > .vector-cloud/exit-code",
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
      })
      .eq("id", run.id)
    if (error) {
      throw new ApiError(500, "AGENT_START_FAILED", "Vector could not save the cloud agent session.")
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

export async function refreshCloudAgent(run: CloudAgentRun) {
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
  const exit = await readText(sandbox, `${run.workspace_dir}/.vector-cloud/exit-code`, 64)
  const logs = await readText(sandbox, `${run.workspace_dir}/.vector-cloud/agent.log`, MAX_LOG_BYTES)
  if (!exit) {
    await platformAdmin()
      .from("vector_agent_runs")
      .update({ logs, current_step: logs ? "Agent is working" : "Starting the Vector agent engine" })
      .eq("id", run.id)
    return { ...run, logs }
  }
  const diff = await readText(sandbox, `${run.workspace_dir}/.vector-cloud/changes.patch`, MAX_DIFF_BYTES)
  const numstat = await readText(sandbox, `${run.workspace_dir}/.vector-cloud/changes.numstat`, 100_000)
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
  if (run.team_id) {
    const { count } = await platformAdmin()
      .from("vector_agent_runs")
      .select("id", { count: "exact", head: true })
      .eq("team_id", run.team_id)
      .eq("user_id", run.user_id)
      .in("status", ["queued", "starting", "running", "needs_input"])
    if (!count) await reconcileAgentTeam(run.team_id, run.user_id)
  }
  await sandbox.stop().catch(() => undefined)
  return { ...run, ...updated } as CloudAgentRun
}

export async function reconcileAgentTeam(teamId: string, userId: string) {
  const admin = platformAdmin()
  const [{ data: team, error: teamError }, { data: runs, error: runsError }] = await Promise.all([
    admin
      .from("vector_agent_teams")
      .select("id,user_id,name,objective,mode,status")
      .eq("id", teamId)
      .eq("user_id", userId)
      .maybeSingle(),
    admin.from("vector_agent_runs").select("*").eq("team_id", teamId).eq("user_id", userId).order("created_at"),
  ])
  if (teamError || runsError || !team) return
  const records = (runs || []) as CloudAgentRun[]
  if (records.some((item) => ["queued", "starting", "running", "needs_input"].includes(item.status))) return
  const workers = records.filter((item) => item.role !== "integrator")
  const integrator = records.find((item) => item.role === "integrator")
  if (integrator) {
    await admin.from("vector_agent_teams").update({ status: "review" }).eq("id", teamId).eq("user_id", userId)
    return
  }
  if (team.mode === "isolated" || workers.some((item) => item.status !== "complete")) {
    await admin.from("vector_agent_teams").update({ status: "review" }).eq("id", teamId).eq("user_id", userId)
    return
  }
  const source = workers[0]
  if (!source) return
  const summaries = workers
    .map((item) => `- ${item.name}: ${(item.summary || "Completed without a summary.").slice(0, 1_500)}`)
    .join("\n")
  const prompt = [
    `Integrate the completed missions for team "${team.name}".`,
    `Shared objective: ${team.objective}`,
    "Worker results:",
    summaries,
    "Resolve overlapping edits and rejected patches, run the appropriate project checks, and leave one reviewable integrated diff.",
  ].join("\n\n")
  const { data: created, error: createError } = await admin
    .from("vector_agent_runs")
    .insert({
      user_id: userId,
      team_id: teamId,
      role: "integrator",
      name: `${team.name} integration`.slice(0, 100),
      prompt: prompt.slice(0, 50_000),
      repository_url: source.repository_url,
      repository_branch: source.repository_branch,
      provider: "vector-cloud",
      model: source.model,
      status: "queued",
      current_step: "Waiting to integrate team changes",
      selected_tools: source.selected_tools || [],
    })
    .select("*")
    .single<CloudAgentRun>()
  if (createError || !created) {
    if (createError?.code === "23505") return
    await admin.from("vector_agent_teams").update({ status: "review" }).eq("id", teamId).eq("user_id", userId)
    return
  }
  await admin
    .from("vector_agent_messages")
    .insert({ run_id: created.id, user_id: userId, role: "user", content: created.prompt })
  await admin.from("vector_agent_teams").update({ status: "integrating" }).eq("id", teamId).eq("user_id", userId)
}

export async function stopCloudAgent(run: CloudAgentRun) {
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

export async function deleteCloudAgentWorkspace(run: CloudAgentRun) {
  if (!run.sandbox_name) return
  let sandbox: Sandbox | undefined
  try {
    sandbox = await Sandbox.get({ name: run.sandbox_name })
  } catch (error) {
    if (!sandboxMissing(error)) throw error
  }
  if (sandbox) await sandbox.delete()
}

export async function continueCloudAgent(run: CloudAgentRun, prompt: string) {
  if (run.status === "running" || run.status === "starting") {
    throw new ApiError(409, "AGENT_BUSY", "This cloud agent is still working. Wait for it to finish before continuing.")
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
  if (!claimed) throw new ApiError(409, "AGENT_BUSY", "This cloud agent is already working or was stopped.")
  try {
    const sandbox = await Sandbox.get({ name: run.sandbox_name })
    const promptPath = `${run.workspace_dir}/.vector-cloud-follow-up.txt`
    await sandbox.writeFiles([{ path: promptPath, content: prompt }])
    const script = [
      "set +e",
      "rm -f .vector-cloud/exit-code",
      `ENGINE_COMMAND=${JSON.stringify(cloudEngineCommand())}`,
      "export OPENCODE_CONFIG_CONTENT=$(cat .vector-cloud-config.json)",
      "PROMPT=$(cat .vector-cloud-follow-up.txt)",
      `MODEL=${JSON.stringify(run.model)}`,
      `timeout --signal=TERM --kill-after=30s ${MAX_AGENT_MINUTES}m "$ENGINE_COMMAND" run --continue --format json --auto --model "$MODEL" "$PROMPT" >> .vector-cloud/agent.log 2>&1`,
      "EXIT=$?",
      "BASE=$(cat .git/vector-cloud-base)",
      "git add -N . >/dev/null 2>&1 || true",
      'git diff --binary "$BASE" -- . > .vector-cloud/changes.patch 2>/dev/null || true',
      'git diff --numstat "$BASE" -- . > .vector-cloud/changes.numstat 2>/dev/null || true',
      "printf '%s' \"$EXIT\" > .vector-cloud/exit-code",
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
        error: error instanceof Error ? error.message.slice(0, 2_000) : "The cloud agent could not continue.",
        completed_at: new Date().toISOString(),
      })
      .eq("id", run.id)
      .eq("user_id", run.user_id)
      .eq("status", "starting")
    throw error
  }
}
