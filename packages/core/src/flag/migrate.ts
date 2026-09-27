import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { Option, Schema } from "effect"
import { parse, type ParseError } from "jsonc-parser"
import { ConfigPermissionV1 } from "../v1/config/permission"
import { legacyPrefix } from "./legacy"
import { SecurityConfigurationError } from "./security"

const suffixes = [
  "CONFIG_CONTENT",
  "TUI_CONFIG",
  "PERMISSION",
  "PURE",
  "SHELL_SANDBOX",
  "SERVER_PASSWORD",
  "SERVER_USERNAME",
  "SERVER_GUEST_PASSWORD",
  "SERVER_GUEST_USERNAME",
  "DISABLE_PROJECT_CONFIG",
  "GIT_BASH_PATH",
  "AUTO_HEAP_SNAPSHOT",
  "DISABLE_AUTOUPDATE",
  "ALWAYS_NOTIFY_UPDATE",
  "DISABLE_PRUNE",
  "DISABLE_TERMINAL_TITLE",
  "SHOW_TTFD",
  "DISABLE_AUTOCOMPACT",
  "DISABLE_MODELS_FETCH",
  "DISABLE_CHANNEL_DB",
  "DISABLE_MOUSE",
  "FAKE_VCS",
  "DISABLE_FFF",
  "EXPERIMENTAL_FILEWATCHER",
  "EXPERIMENTAL_DISABLE_FILEWATCHER",
  "EXPERIMENTAL_DISABLE_COPY_ON_SELECT",
  "MODELS_URL",
  "MODELS_PATH",
  "WORKSPACE_ID",
  "EXPERIMENTAL_WORKSPACES",
  "EXPERIMENTAL_REFERENCES",
  "PLUGIN_META_FILE",
  "ENABLE_EXA",
  "ENABLE_PARALLEL",
  "EXPERIMENTAL_PLAN_MODE",
  "EXPERIMENTAL_OUTPUT_TOKEN_MAX",
  "EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS",
  "EXPERIMENTAL_TOOL_OUTPUT_MAX_LINES",
  "EXPERIMENTAL_TOOL_OUTPUT_MAX_BYTES",
  "EXPERIMENTAL_LSP_TOOL",
  "EXPERIMENTAL_DISABLE_MCP",
  "DISABLE_LSP_DOWNLOAD",
  "DISABLE_CLAUDE_CODE",
  "DISABLE_CLAUDE_CODE_SKILLS",
  "DISABLE_CLAUDE_CODE_PROMPT",
  "DISABLE_CLAUDE_CODE_CONFIG",
  "AUTH_CONTENT",
]

const renames = [
  ...suffixes.map((suffix) => [suffix, `VECTOR_${suffix}`] as const),
  ["CONFIG", "VECTOR_AGENT_CONFIG"] as const,
  ["CONFIG_DIR", "VECTOR_AGENT_CONFIG_DIR"] as const,
  ["DB", "VECTOR_AGENT_DB"] as const,
  ["EXPERIMENTAL", "VECTOR_EXPERIMENTAL"] as const,
  ["CLIENT", "VECTOR_CLIENT"] as const,
]
const notified = new WeakMap<NodeJS.ProcessEnv, Set<string>>()

/**
 * Import the earlier product's variables without deleting them or logging their values.
 * Only its exact prefix is read. A current Vector variable always wins: a conflicting
 * earlier value is reported once and never stops startup (the desktop sets its own
 * server credentials, so a leftover shell export must not break the engine).
 */
export function migrateEnvironment(env: NodeJS.ProcessEnv = process.env, notice = persistentNotice) {
  if (!legacyPrefix) return []
  const aliases = renames.flatMap(([suffix, target]) => {
    const key = `${legacyPrefix}${suffix}`
    const value = env[key]
    if (value === undefined) return []
    // An empty current variable does not count as set; importing keeps an earlier
    // restrictive setting (a password, a deny rule) from being silently dropped.
    const current = env[target] || undefined
    return [{ key, target, suffix, value, conflict: current !== undefined && current !== value, apply: !current }]
  })
  const applied = aliases.filter((item) => item.apply)
  applied.forEach((item) => validate(item.suffix, item.value, item.key))
  for (const item of applied) env[item.target] = item.value
  const prior = notified.get(env) ?? new Set<string>()
  const fresh = aliases.filter((item) => !prior.has(item.key))
  fresh.forEach((item) => prior.add(item.key))
  notified.set(env, prior)
  if (fresh.length)
    notice(
      fresh.map((item) =>
        item.conflict ? `${item.key} ignored because ${item.target} is set` : `${item.key} → ${item.target}`,
      ),
      env,
    )
  return aliases.map((item) => ({ source: item.key, target: item.target, applied: !item.conflict }))
}

function validate(suffix: string, value: string, name: string) {
  if (
    ["PURE", "DISABLE_PROJECT_CONFIG", "SHELL_SANDBOX"].includes(suffix) &&
    !["true", "false", "1", "0"].includes(value.toLowerCase())
  )
    throw new SecurityConfigurationError(
      `Invalid ${name}. Use true or false before starting Vector; its value was not logged.`,
    )
  if (suffix !== "CONFIG_CONTENT" && suffix !== "PERMISSION") return
  const errors: ParseError[] = []
  const data: unknown = parse(value, errors, { allowTrailingComma: true })
  const record = data && typeof data === "object" && !Array.isArray(data)
  const valid =
    suffix === "PERMISSION"
      ? Option.isSome(Schema.decodeUnknownOption(ConfigPermissionV1.Info)(data))
      : record &&
        (!("permission" in data) || Option.isSome(Schema.decodeUnknownOption(ConfigPermissionV1.Info)(data.permission)))
  if (errors.length || !valid)
    throw new SecurityConfigurationError(
      `Invalid ${name}. Repair its settings before starting Vector; its value was not logged.`,
    )
}

function persistentNotice(mappings: string[], env: NodeJS.ProcessEnv) {
  const state = env.XDG_STATE_HOME ?? path.join(env.HOME ?? os.homedir(), ".local", "state")
  const marker = path.join(
    state,
    "vector",
    "migrations",
    `environment-${createHash("sha256").update(mappings.toSorted().join("\n")).digest("hex")}.json`,
  )
  if (fs.existsSync(marker)) return
  const message = `Vector imported earlier environment settings: ${mappings.join(", ")}. Original variables were kept; update your shell profile when convenient.`
  console.warn(message)
  // A read-only state directory must not discard the imported settings. The notice
  // can repeat next launch if it cannot be recorded, and racing launches are safe.
  Option.liftThrowable(() => {
    fs.mkdirSync(path.dirname(marker), { recursive: true })
    fs.writeFileSync(marker, JSON.stringify({ mappings, version: 1 }), { mode: 0o600, flag: "wx" })
  })()
}
