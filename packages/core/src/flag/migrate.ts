import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { Option, Schema } from "effect"
import { parse, type ParseError } from "jsonc-parser"
import TOML from "smol-toml"
import { ConfigPermissionV1 } from "../v1/config/permission"
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
].toSorted((a, b) => b.length - a.length)
const security = new Set([
  "CONFIG_CONTENT",
  "PERMISSION",
  "PURE",
  "DISABLE_PROJECT_CONFIG",
  "SHELL_SANDBOX",
  "SERVER_PASSWORD",
  "SERVER_USERNAME",
  "SERVER_GUEST_PASSWORD",
  "SERVER_GUEST_USERNAME",
  "AUTH_CONTENT",
])
const broad = {
  CONFIG: "AGENT_CONFIG",
  CONFIG_DIR: "AGENT_CONFIG_DIR",
  DB: "AGENT_DB",
  EXPERIMENTAL: "EXPERIMENTAL",
  CLIENT: "CLIENT",
}
const notified = new WeakMap<NodeJS.ProcessEnv, Set<string>>()

/** Import recognizable earlier variables without deleting them or logging their values. */
export function migrateEnvironment(env: NodeJS.ProcessEnv = process.env, notice = persistentNotice) {
  const matches = Object.keys(env).flatMap((key) => {
    if (key.startsWith("VECTOR_") || env[key] === undefined) return []
    const suffix = suffixes.find((suffix) => key.toUpperCase().endsWith(`_${suffix}`))
    return suffix ? [{ key, prefix: key.slice(0, -suffix.length - 1), target: `VECTOR_${suffix}`, suffix }] : []
  })
  const prefixes = new Set(matches.map((item) => item.prefix))
  const aliases = [
    ...matches,
    ...Object.keys(env).flatMap((key) => {
      if (key.startsWith("VECTOR_AGENT_") || env[key] === undefined) return []
      const suffix = Object.keys(broad).find((suffix) => key.toUpperCase().endsWith(`_${suffix}`))
      if (!suffix) return []
      const prefix = key.slice(0, -suffix.length - 1)
      const target = `VECTOR_${broad[suffix as keyof typeof broad]}`
      if (key === target) return []
      const recognized =
        prefixes.has(prefix) ||
        (suffix === "CONFIG" && configFile(env[key]!)) ||
        (suffix === "CONFIG_DIR" && configDirectory(env[key]!))
      return recognized ? [{ key, prefix, target, suffix }] : []
    }),
  ]
  const assignments = new Map<string, string>()
  for (const item of aliases) {
    const value = env[item.key]!
    const existing = assignments.get(item.target)
    if (existing !== undefined && existing !== value)
      throw new SecurityConfigurationError(
        `Multiple earlier variables disagree for ${item.target}. Remove the ambiguity or set only the intended Vector variable before starting.`,
      )
    if (security.has(item.suffix) && env[item.target] !== undefined && env[item.target] !== value)
      throw new SecurityConfigurationError(
        `${item.key} and ${item.target} disagree. Reconcile these security settings before starting Vector.`,
      )
    validate(item.suffix, value, item.key)
    assignments.set(item.target, value)
  }
  for (const [key, value] of assignments) if (env[key] === undefined) env[key] = value
  const prior = notified.get(env) ?? new Set<string>()
  const imported = aliases.filter((item) => !prior.has(item.key))
  imported.forEach((item) => prior.add(item.key))
  notified.set(env, prior)
  if (imported.length)
    notice(
      imported.map((item) => `${item.key} → ${item.target}`),
      env,
    )
  return aliases.map((item) => ({ source: item.key, target: item.target }))
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

function configFile(file: string) {
  if (/^(?:auth|credential|secret|license)(?:[.-]|$)/i.test(path.basename(file))) return false
  const stat = fs.statSync(file, { throwIfNoEntry: false })
  if (!stat?.isFile() || stat.size > 1_048_576) return false
  const text = fs.readFileSync(file, "utf8")
  const errors: ParseError[] = []
  const data: unknown =
    file.endsWith(".toml") || !/^\s*[{/]/.test(text)
      ? Option.getOrUndefined(Option.liftThrowable(TOML.parse)(text))
      : parse(text, errors, { allowTrailingComma: true })
  if (/\$schema["']?\s*[:=]\s*["'][^"']*\/config\.json["']/.test(text) || /["']?permission["']?\s*[:=]/.test(text))
    return true
  if (errors.length || !data || typeof data !== "object" || Array.isArray(data)) return false
  if ("$schema" in data && typeof data.$schema === "string" && /\/config\.json(?:[?#]|$)/.test(data.$schema))
    return true
  // File routing runs before Flag initialization. Full config decoding happens
  // at the normal loader; these distinctive structures avoid importing its cycle.
  return (
    ("permission" in data && Option.isSome(Schema.decodeUnknownOption(ConfigPermissionV1.Info)(data.permission))) ||
    ("mcp" in data && !!data.mcp && typeof data.mcp === "object") ||
    ("provider" in data && !!data.provider && typeof data.provider === "object") ||
    ("provider" in data && typeof data.provider === "string" && "model" in data && typeof data.model === "string") ||
    ("model" in data && typeof data.model === "string" && data.model.includes("/"))
  )
}

function configDirectory(directory: string) {
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return false
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .some(
      (entry) =>
        entry.isFile() && /\.(?:jsonc?|toml)$/.test(entry.name) && configFile(path.join(directory, entry.name)),
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
