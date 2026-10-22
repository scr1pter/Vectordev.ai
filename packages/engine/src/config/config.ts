import { ConfigMigration } from "@vectordevai/core/config/migration"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { serviceUse } from "@vectordevai/core/effect/service-use"
import path from "path"
import { createHash } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "url"
import os from "os"
import { mergeDeep, omit } from "remeda"
import { Global } from "@vectordevai/core/global"
import fsNode from "fs/promises"
import { Flag } from "@vectordevai/core/flag/flag"
import { Auth } from "../auth"
import { Teams } from "@vectordevai/core/teams"
import { Env } from "../env"
import { applyEdits, modify, parse } from "jsonc-parser"
import { InstallationLocal } from "@vectordevai/core/installation/version"
import { existsSync, readFileSync, renameSync, watch, writeFileSync } from "fs"
import { isRecord } from "@/util/record"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Redaction } from "@vectordevai/core/redaction"
import { InstanceState } from "@/effect/instance-state"
import { Context, Duration, Effect, Fiber, Layer, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { EffectFlock } from "@vectordevai/core/util/effect-flock"
import type { InstanceContext } from "../project/instance-context"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { ConfigMCPV1 } from "@vectordevai/core/v1/config/mcp"
import { RemoteAuthError } from "@vectordevai/core/v1/config/error"
import { ConfigPermissionV1 } from "@vectordevai/core/v1/config/permission"
import { ConfigPluginV1 } from "@vectordevai/core/v1/config/plugin"
import { ConfigAgent } from "./agent"
import { ConfigCommand } from "./command"
import { ConfigManaged } from "./managed"
import { ConfigParse } from "./parse"
import { ConfigSchema } from "./schema"
import { ConfigPaths } from "./paths"
import { ConfigImport } from "./import-settings"
import { GlobalBus } from "@/bus/global"
import { TuiEvent } from "@/server/tui-event"
import { ConfigPlugin } from "./plugin"
import { ConfigDependencies } from "./dependencies"
import { ConfigVariable } from "./variable"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { ConfigLocalV1 } from "@vectordevai/core/v1/config/local"
import { ChildEnvironment } from "@vectordevai/core/child-environment"

// Custom merge function that concatenates array fields instead of replacing them
// Keep remeda's deep conditional merge type out of hot config-loading paths; TS profiling showed it dominates here.
function mergeConfig(target: Info, source: Info): Info {
  return mergeDeep(target, source) as Info
}

function mergeConfigConcatArrays(target: Info, source: Info): Info {
  const merged = mergeConfig(target, source)
  if (target.instructions && source.instructions) {
    merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
  }
  return merged
}

function normalizeLoadedConfig(data: unknown) {
  if (!isRecord(data)) return data
  const copy = { ...data }
  const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy
  if (!hadLegacy) return copy
  delete copy.theme
  delete copy.keybinds
  delete copy.tui
  return copy
}

function projectExecutableConfig(config: Info, trusted: boolean, base: Info): Info {
  const next = { ...config }
  // A repository's own local block never applies, trusted or not: only the user's config and the company's policy
  // set Vector Local, so a cloned repository can neither loosen it nor turn it off.
  delete next.local
  // Spend limits are one overall set across every repository, so a repository's own budget.run is ignored, trusted
  // or not. Its loop switch still follows the trust rules below.
  if (next.budget?.run) {
    const budget = { ...next.budget }
    delete budget.run
    if (Object.keys(budget).length) next.budget = budget
    else delete next.budget
  }
  if (!trusted) {
    const permission = authorityNarrowingPermission(next.permission)
    if (permission) next.permission = permission
    else delete next.permission
    if (next.tools) {
      next.tools = Object.fromEntries(Object.entries(next.tools).filter(([, enabled]) => !enabled))
      if (!Object.keys(next.tools).length) delete next.tools
    }
    delete next.plugin
    delete next.mcp
    delete next.lsp
    delete next.formatter
    delete next.command
    delete next.provider
    delete next.agent
    delete next.mode
    delete next.shell
    delete next.instructions
    delete next.model
    delete next.small_model
    delete next.default_agent
    delete next.skills
    if (next.enabled_providers && base.enabled_providers) {
      const enabled = new Set(base.enabled_providers)
      next.enabled_providers = next.enabled_providers.filter((provider) => enabled.has(provider))
    }
    if (next.disabled_providers) {
      next.disabled_providers = Array.from(new Set([...(base.disabled_providers ?? []), ...next.disabled_providers]))
    }
    // Sharing and undo snapshots may only get safer: an untrusted project can turn sharing down or off, never on,
    // and cannot turn snapshots off.
    if (next.share && (base.share === "disabled" || next.share === "auto")) delete next.share
    if (next.autoshare) delete next.autoshare
    if (next.snapshot === false) delete next.snapshot
    // Loop limits may only get stricter too: a cloned repository cannot switch loop pauses off, or keep the agent
    // going after a denied tool call.
    if (next.budget) {
      if (next.budget.loop?.enabled === true) next.budget = { loop: { enabled: true } }
      else delete next.budget
    }
    // Task sizing may only get cheaper too: a cloned repository can switch the judge off, but cannot turn automatic
    // sizing off (the full harness on every request) or have the judge run on the user's account.
    if (next.sizing) {
      const sizing = next.sizing.judge === "off" ? { judge: "off" as const } : undefined
      if (sizing) next.sizing = sizing
      else delete next.sizing
    }
    if (next.experimental?.continue_loop_on_deny === true && base.experimental?.continue_loop_on_deny !== true) {
      const experimental = { ...next.experimental }
      delete experimental.continue_loop_on_deny
      next.experimental = experimental
    }
    return next
  }
  if (next.provider) {
    next.provider = Object.fromEntries(
      Object.entries(next.provider).filter(([, provider]) => projectProviderEndpointsAllowed(provider)),
    )
  }
  return next
}

function bindTrustedProjectExecutables(
  config: Info,
  trusted: WorkspaceTrust.TrustedSnapshot,
  workspace: string,
  source: string,
): Info {
  const next = { ...config }
  if (next.shell) {
    const shell = trustedExecutableValue(next.shell, path.dirname(source), trusted)
    if (shell) next.shell = shell
    else delete next.shell
  }
  if (next.plugin) {
    next.plugin = next.plugin.flatMap((item) => {
      const mapped = trustedExecutableValue(ConfigPlugin.pluginSpecifier(item), path.dirname(source), trusted, true)
      if (!mapped) return []
      return [Array.isArray(item) ? ([mapped, item[1]] as ConfigPluginV1.Spec) : mapped]
    })
  }
  if (isRecord(next.formatter)) {
    next.formatter = rewriteCommandEntries(next.formatter, workspace, trusted) as Info["formatter"]
  }
  if (isRecord(next.lsp)) next.lsp = rewriteCommandEntries(next.lsp, workspace, trusted) as Info["lsp"]
  if (isRecord(next.mcp)) {
    next.mcp = Object.fromEntries(
      Object.entries(next.mcp)
        .map(([name, entry]) => {
          // A project's remote server gets HTTPS or loopback HTTP only; plain HTTP to the user's network is for
          // servers the user adds themselves.
          if ("url" in entry && typeof entry.url === "string")
            return [name, WorkspaceTrust.remoteUrlAllowed(entry.url) ? entry : undefined]
          if (!("command" in entry) || !Array.isArray(entry.command)) return [name, entry]
          const cwd = "cwd" in entry && typeof entry.cwd === "string" ? path.resolve(workspace, entry.cwd) : workspace
          const command = WorkspaceTrust.materializedCommand(trusted, entry.command, cwd, entry.environment)
          if (!command) return [name, undefined]
          return [
            name,
            {
              ...entry,
              command: command.command,
              cwd: command.cwd,
            },
          ]
        })
        .filter((entry) => entry[1] !== undefined),
    ) as Info["mcp"]
  }
  return next
}

function rewriteCommandEntries(value: Record<string, unknown>, base: string, trusted: WorkspaceTrust.TrustedSnapshot) {
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, entry]) => {
      if (!isRecord(entry)) return [[name, entry]]
      // An entry without a command overrides a built-in formatter, which still launches with this environment, so a
      // PATH or preload variable would run live, unapproved programs just as a project command would.
      const environment = "environment" in entry ? entry.environment : "env" in entry ? entry.env : undefined
      const projectEnvironment = stringEnvironment(environment)
      if (
        environment !== undefined &&
        (!projectEnvironment || WorkspaceTrust.unsafeProjectEnvironment(projectEnvironment))
      )
        return []
      if (!Array.isArray(entry.command)) {
        if (typeof entry.cwd !== "string") return [[name, entry]]
        const cwd = WorkspaceTrust.materializedPathOption(trusted, path.resolve(base, entry.cwd))
        if (!cwd) return []
        return [[name, { ...entry, cwd }]]
      }
      if (!entry.command.every((item): item is string => typeof item === "string")) return []
      const cwd = typeof entry.cwd === "string" ? path.resolve(base, entry.cwd) : base
      const command = WorkspaceTrust.materializedCommand(trusted, entry.command, cwd, projectEnvironment)
      if (!command) return []
      return [[name, { ...entry, command: command.command, cwd: command.cwd }]]
    }),
  )
}

function stringEnvironment(value: unknown) {
  if (!isRecord(value)) return
  const entries = Object.entries(value)
  if (entries.some(([, item]) => typeof item !== "string")) return
  return Object.fromEntries(entries) as Record<string, string>
}

function trustedExecutableValue(
  value: unknown,
  base: string,
  trusted: WorkspaceTrust.TrustedSnapshot,
  preserveFileUrl = false,
) {
  if (typeof value !== "string") return
  if (value.startsWith("file:")) {
    const target = WorkspaceTrust.materializedPathOption(trusted, fileURLToPath(value))
    if (!target) return
    return preserveFileUrl ? pathToFileURL(target).href : target
  }
  if (/^[A-Za-z]:/.test(value) || value.startsWith("\\\\")) {
    const target = WorkspaceTrust.materializedPathOption(trusted, value)
    if (!target) return
    return preserveFileUrl ? pathToFileURL(target).href : target
  }
  if (URL.canParse(value)) return value
  if (preserveFileUrl && !path.isAbsolute(value) && !value.startsWith(".") && !/^[A-Za-z]:[\\/]/.test(value)) {
    return value
  }
  if (!path.isAbsolute(value) && !value.includes("/") && !value.includes("\\"))
    return WorkspaceTrust.hostExecutable(trusted, value)
  const target = WorkspaceTrust.materializedPathOption(trusted, path.resolve(base, value))
  if (!target) return
  return preserveFileUrl ? pathToFileURL(target).href : target
}

function authorityNarrowingPermission(permission: ConfigPermissionV1.Info | undefined) {
  if (!permission) return
  const entries = Object.entries(permission)
    .map(([name, rule]) => {
      if (rule === "deny") return [name, rule] as const
      if (typeof rule === "string") return
      const patterns = Object.fromEntries(Object.entries(rule).filter(([, action]) => action === "deny"))
      if (Object.keys(patterns).length) return [name, patterns] as const
    })
    .filter((entry) => entry !== undefined)
  if (entries.length) return Object.fromEntries(entries)
}

function toolPermissions(tools: Record<string, boolean>) {
  return Object.fromEntries(
    Object.entries(tools).map(([tool, enabled]) => [
      tool === "write" || tool === "patch" ? "edit" : tool,
      enabled ? "allow" : "deny",
    ]),
  ) as Record<string, ConfigPermissionV1.Action>
}

// Whether a project source allows or asks for anything, which could replace a user deny once merged.
function grantsPermission(config: Pick<Info, "permission" | "tools" | "agent" | "mode">) {
  const permissions = [
    config.permission,
    ...Object.values(config.agent ?? {}).map((agent) => agent?.permission),
    ...Object.values(config.mode ?? {}).map((mode) => mode?.permission),
  ]
  return (
    Object.values(config.tools ?? {}).some(Boolean) ||
    permissions.some((permission) =>
      Object.values(permission ?? {}).some((rule) =>
        typeof rule === "string" ? rule !== "deny" : Object.values(rule).some((action) => action !== "deny"),
      ),
    )
  )
}

function projectProviderEndpointsAllowed(provider: unknown) {
  if (!isRecord(provider)) return true
  const options = isRecord(provider.options) ? provider.options : undefined
  for (const value of [options?.baseURL, options?.baseUrl]) {
    if (typeof value === "string" && !WorkspaceTrust.remoteUrlAllowed(value)) return false
  }
  if (!isRecord(provider.models)) return true
  return Object.values(provider.models).every((model) => {
    if (!isRecord(model) || !isRecord(model.options)) return true
    return [model.options.baseURL, model.options.baseUrl].every(
      (value) => typeof value !== "string" || WorkspaceTrust.remoteUrlAllowed(value),
    )
  })
}

async function substituteWellKnownRemoteConfig(input: {
  value: unknown
  dir: string
  source: string
  env: Record<string, string>
}) {
  if (!isRecord(input.value) || typeof input.value.url !== "string") return undefined

  const url = await ConfigVariable.substitute({
    text: input.value.url,
    type: "virtual",
    dir: input.dir,
    source: input.source,
    env: input.env,
  })
  const headers = isRecord(input.value.headers)
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(input.value.headers)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .map(async ([key, value]) => [
              key,
              await ConfigVariable.substitute({
                text: value,
                type: "virtual",
                dir: input.dir,
                source: input.source,
                env: input.env,
              }),
            ]),
        ),
      )
    : undefined

  return { url, headers }
}

async function resolveLoadedPlugins<T extends { plugin?: ConfigPluginV1.Spec[] }>(config: T, filepath: string) {
  if (!config.plugin) return config
  for (let i = 0; i < config.plugin.length; i++) {
    // Normalize path-like plugin specs while we still know which config file declared them.
    // This prevents `./plugin.ts` from being reinterpreted relative to some later merge location.
    config.plugin[i] = await ConfigPlugin.resolvePluginSpec(config.plugin[i], filepath)
  }
  return config
}

type Info = ConfigV1.Info & {
  // plugin_origins is derived state, not a persisted config field. It keeps each winning plugin spec together
  // with the file and scope it came from so later runtime code can make location-sensitive decisions.
  plugin_origins?: ConfigPlugin.Origin[]
}

type State = {
  config: Info
  /** A repository's own local block was left out, which the Vector Local pane says. */
  repositoryLocal: boolean
  directories: string[]
  configDirectory: string | undefined
  deps: Fiber.Fiber<void>[]
  trust: WorkspaceTrust.Snapshot
  trusted: boolean
  trustedSnapshot: WorkspaceTrust.TrustedSnapshot | undefined
  ceiling: PermissionCeiling | undefined
}

export type TrustStatus = WorkspaceTrust.Status & {
  /**
   * The project is not trusted and that holds something back: its config, .vector or skills content, or the
   * language servers, formatters and local MCP servers the user enabled (see startsInWorkspace).
   */
  ignored: boolean
  /** The project has settings of its own (config, .vector or skills content) that trust decides on. */
  settings: boolean
}

// The permissions the user's own config sources declare, merged without any project file. Set only when a
// trusted project grants something, because the merged config then lets a project allow replace a user deny.
export type PermissionCeiling = {
  permission: ConfigPermissionV1.Info
  agent: Record<string, ConfigPermissionV1.Info>
}

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly update: (config: Info) => Effect.Effect<void>
  readonly updateGlobal: (config: Info) => Effect.Effect<{ info: Info; changed: boolean }>
  readonly updateMcpLocal: (name: string, entry: ConfigMCPV1.Info | { enabled: boolean }) => Effect.Effect<void>
  readonly removeMcpLocal: (name: string) => Effect.Effect<void>
  readonly storedMcp: (name: string) => Effect.Effect<Record<string, unknown>>
  readonly invalidate: () => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
  readonly trustedPath: (path: string) => Effect.Effect<string | undefined>
  readonly waitForDependencies: () => Effect.Effect<void>
  readonly trust: () => Effect.Effect<TrustStatus>
  readonly approve: () => Effect.Effect<void>
  readonly permissionCeiling: () => Effect.Effect<PermissionCeiling | undefined>
  /**
   * The Vector Local policy in effect (Config.local()) as this instance reports it: with a note when the repository's
   * own config has a local block, which never applies.
   */
  readonly localPolicy: () => Effect.Effect<LocalMode.Policy>
}

export class Service extends Context.Service<Service, Interface>()("@vector/Config") {}

export const use = serviceUse(Service)

// Machine-local config layer inside .vector directories. Runtime MCP installs (and their
// tokens/headers) are written here instead of the committable vector.json, so the files
// must stay gitignored.
const LOCAL_CONFIG_FILES = ["vector.local.json", "vector.local.jsonc"]
// How many repository files the ignored budget.run notice remembers having told the user about.
const IGNORED_BUDGETS_KEPT = 200

/**
 * Where the integrations a user adds from the app are kept for one project. They are the user's choice, not the
 * repository's, so they live outside the workspace: trust neither drops them nor is revoked when they change, and a
 * cloned repository cannot plant one.
 */
export function integrationStore(root: string) {
  return path.join(
    Global.Path.state,
    "integrations",
    `${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 32)}.json`,
  )
}

/**
 * Whether the user's own config starts something in the project that the project's files can take over: language
 * servers, formatters or a local MCP server. Until the project is trusted the first two stay off and MCP servers start
 * outside it.
 */
function startsInWorkspace(config: Info) {
  return (
    Boolean(config.lsp || config.formatter) ||
    Object.values(config.mcp ?? {}).some(
      (entry) => "type" in entry && entry.type === "local" && entry.enabled !== false,
    )
  )
}

function globalConfigFile() {
  const candidates = ["vector.jsonc", "vector.json", "config.json"].map((file) => path.join(Global.Path.config, file))
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return candidates[0]
}

function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
  if (!isRecord(patch)) {
    const edits = modify(input, path, patch, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    return applyEdits(input, edits)
  }

  return Object.entries(patch).reduce((result, [key, value]) => patchJsonc(result, value, [...path, key]), input)
}

function writable(info: Info) {
  const { plugin_origins: _plugin_origins, ...next } = info
  return next
}

function writableGlobal(info: Info) {
  const next = writable(info)
  // When a user changes config from a value back to default in the Desktop app, we don't want to leave a blank `"shell": "",` key
  if ("shell" in next && next.shell === "") return { ...next, shell: undefined }
  return next
}

// Vector Local's policy for this process. It is process-global, not per repository, and it is resolved synchronously
// when this module loads: before any layer is built, so before any startup fetch (the model catalog, the free-models
// and plans catalogs), and with nothing to wait on, so a fetch that asks for it never waits. It comes from the managed
// policy and the user's own config only: the global config folder and, for the desktop, its own config folder
// (VECTOR_AGENT_CONFIG_DIR). The environment (LocalPolicy.resolve), VECTOR_CONFIG_CONTENT, VECTOR_AGENT_CONFIG and any
// other VECTOR_AGENT_CONFIG_DIR can only tighten it, and a repository's own local block is never read. Config.local()
// is the only reader of it: the merged config (Config.get()) carries no local block.
//
// A change that would loosen it waits for the owner: an edit to the user's config, and a change to an override, whose
// files are read at start and may only tighten what was in effect after it. The parts of a change that tighten apply
// at once: the policy in effect is the stricter of what the owner last let apply and the change, setting by setting.
// The baseline is what is in effect while this process runs and, at start, the copy of the user's block the last
// process saved in Vector's state folder, so an edit made while Vector was closed is held too. A missing or unreadable
// copy counts as the user's block at start.
//
// The copy is the user's to change, like the config itself, so it is a check and not a boundary: whatever can write
// the state folder can rewrite or delete it, and what stops the agent there is the ask on its own writes to these
// files. What the copy does stop is a nested vector laundering an edit. A process under the agent marker, which every
// untrusted child of Vector carries (a program the agent started, or Vector's own terminal), never reads or writes it,
// cannot confirm, and adds no model server from VECTOR_LOCAL_POLICY, so the user's config can only tighten the floor it
// inherited. And an edit the environment or the company's policy hides, such as turning the user's own block off while
// VECTOR_LOCAL keeps Local on, is held as well, so it never becomes the block a later start compares with. The floor and
// the marker live in the environment, so a program that clears it (env -i) drops them: they are advisory, and the
// network asks and the sandbox are the boundary.

export type LocalChange =
  | { readonly type: "updated"; readonly policy: LocalMode.Policy }
  | {
      readonly type: "loosening"
      readonly policy: LocalMode.Policy
      readonly proposed: LocalMode.Policy
      readonly changes: readonly string[]
    }

const LOCAL_GLOBAL_FILES = ["config.json", "vector.json", "vector.jsonc"]
const LOCAL_DIRECTORY_FILES = ["vector.json", "vector.jsonc", ...LOCAL_CONFIG_FILES]
// A local block Vector cannot decode keeps Vector Local on, with no web, until it is fixed.
const LOCAL_FAIL_CLOSED: ConfigLocalV1.Info = { enabled: true, web: "none" }
const LOCAL_WEB_LABELS: Record<LocalMode.Web, string> = { ask: "Ask", network: "Your network only", none: "None" }
const LocalConfirmed = Schema.Struct({ local: Schema.NullOr(ConfigLocalV1.Info) })
const LOCAL_OFF = "turns Vector Local off"

type LocalBlock = {
  readonly source: string
  readonly block?: ConfigLocalV1.Info
  /** "block": the file's local block does not decode. "file": Vector could not read the file at all. */
  readonly unreadable?: "block" | "file"
}
/** What Vector Local is resolved from besides the company's policy and the environment. */
type LocalInputs = {
  readonly user: ConfigLocalV1.Info | undefined
  /** VECTOR_CONFIG_CONTENT and the config-path overrides, which may only tighten it. */
  readonly overrides: readonly LocalBlock[]
}
type LocalPending = {
  readonly proposed: LocalMode.Policy
  readonly changes: readonly string[]
  readonly inputs: LocalInputs
}

const localState: {
  policy: LocalMode.Policy
  /** The inputs in effect: what the owner last let apply, with what has tightened it since. Set at the first resolution. */
  confirmed: LocalInputs | undefined
  /** The user's block as the state folder holds it, as JSON, so it is written only when it changes. */
  saved: string | undefined
  pending: LocalPending | undefined
  /** The held change a repository's config load last announced, so each one is announced there once. */
  announced: string | undefined
  watchers: number
  stop: (() => void) | undefined
  readonly listeners: Set<(change: LocalChange) => void>
} = {
  policy: LocalPolicy.PENDING,
  confirmed: undefined,
  saved: undefined,
  pending: undefined,
  announced: undefined,
  watchers: 0,
  stop: undefined,
  listeners: new Set(),
}

/** The Vector Local policy in effect for this process. Nothing else may be read for Vector Local's settings. */
export function local() {
  return localState.policy
}

/** The edit to the user's config that would loosen Vector Local and waits for the owner, if there is one. */
export function localPending() {
  const pending = localState.pending
  if (!pending) return undefined
  return { proposed: pending.proposed, changes: pending.changes }
}

/**
 * Where the user's block the owner last let apply is kept between runs, one file per user config location, so the
 * desktop and the CLI, which read different config folders, never hold back each other's settings.
 */
export function localConfirmedFile() {
  const key = createHash("sha256")
    .update(JSON.stringify([Global.Path.config, localFiles().desktop ?? ""]))
    .digest("hex")
    .slice(0, 16)
  return path.join(Global.Path.state, `local-confirmed-${key}.json`)
}

/**
 * Reads Vector Local's sources again and applies them, except the part of a change that would loosen it: that keeps
 * the stricter setting in effect until `confirmLocal`. The watcher calls this, and so should anything that has just
 * written the user's config.
 */
export function refreshLocal() {
  const next = evaluateLocal()
  const changed = JSON.stringify(next.policy) !== JSON.stringify(localState.policy)
  const asked = next.pending !== undefined && pendingKey(next.pending) !== pendingKey(localState.pending)
  localState.policy = next.policy
  localState.pending = next.pending
  localState.confirmed = next.confirmed
  saveLocalConfirmed(next.confirmed.user)
  // Children inherit the floor of the policy in effect, and the agent marker: every untrusted child of this process
  // may be the agent or a program it started.
  ChildEnvironment.inherit({ local: next.policy, agent: true })
  if (changed) localState.listeners.forEach((listener) => listener({ type: "updated", policy: next.policy }))
  if (next.pending && asked) {
    const pending = next.pending
    localState.listeners.forEach((listener) =>
      listener({ type: "loosening", policy: next.policy, proposed: pending.proposed, changes: pending.changes }),
    )
    toastHeldLocal(pending)
  }
  return next.policy
}

/**
 * Lets the held change apply. Only the owner's own answer may lead here, from the app's confirmation dialog or a
 * prompt in a terminal, never the agent: a process under the agent marker cannot confirm, and `vector local` refuses
 * there too.
 */
export function confirmLocal() {
  const pending = localState.pending
  if (pending && !agentMarked()) localState.confirmed = pending.inputs
  return refreshLocal()
}

/**
 * Announces a held change once a repository's config loads. The first resolution runs when this module loads, before
 * anything listens, so a change held at start would otherwise go unannounced.
 */
function announceHeldLocal() {
  const pending = localState.pending
  if (!pending || pendingKey(pending) === localState.announced) return
  localState.announced = pendingKey(pending)
  toastHeldLocal(pending)
}

function toastHeldLocal(pending: LocalPending) {
  // Confirming in the app or with `vector local` comes with the Local API; until then the owner applies a held change
  // by starting again without the copy the next start compares with.
  const apply = agentMarked()
    ? "An agent or Vector's own terminal started this Vector, so it cannot apply a change like this."
    : `To apply it, quit Vector, delete ${localConfirmedFile()} and start Vector again.`
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: TuiEvent.ToastShow.type,
      properties: {
        title: "Vector Local change held",
        message: `A change to your config would loosen Vector Local: it ${pending.changes.join(", ")}. Vector applies the parts that make it stricter and holds the rest. ${apply}`,
        variant: "warning",
        duration: 15_000,
      },
    },
  })
}

function pendingKey(pending: LocalPending | undefined) {
  return pending && JSON.stringify([pending.changes, pending.proposed])
}

// Every untrusted child of a process that runs agents carries the marker, whatever its value.
function agentMarked() {
  return process.env[ChildEnvironment.AGENT_MARKER] !== undefined
}

export function subscribeLocal(listener: (change: LocalChange) => void) {
  localState.listeners.add(listener)
  return () => {
    localState.listeners.delete(listener)
  }
}

/**
 * Watches the files Vector Local reads, so an edit applies (or is held) while Vector runs. The macOS profile and the
 * Windows policy key apply at the next start. Each caller stops its own watch; the last one closes the watchers.
 */
export function watchLocal() {
  localState.watchers += 1
  if (localState.watchers === 1) localState.stop = startLocalWatchers()
  const stopped = { done: false }
  return () => {
    if (stopped.done) return
    stopped.done = true
    localState.watchers -= 1
    if (localState.watchers > 0) return
    localState.stop?.()
    localState.stop = undefined
  }
}

function evaluateLocal() {
  const sources = readLocalSources()
  const start = localState.confirmed === undefined
  const confirmed = localState.confirmed ?? startConfirmed(sources)
  // A user block Vector cannot decode applies its fail-closed policy at once, and while a user file cannot be read at
  // all the block in effect stays. Neither counts as let apply, so fixing it needs no confirmation.
  const current = {
    user: sources.failed || sources.readable ? sources.user : confirmed.user,
    overrides: sources.overrides,
  }
  const proposed = resolveLocal(sources, current)
  const kept = resolveLocal(sources, confirmed)
  const changes = sources.failed ? [] : heldChanges(kept, proposed, confirmed.user, current.user)
  const held = changes.length > 0
  // A held change still applies where it tightens: on if either turns Local on, the stricter Web access, only what
  // both list, and every site either denies.
  const effect = held
    ? {
        user: stricterLocal(confirmed.user, current.user),
        overrides: [
          ...new Map(
            [...confirmed.overrides, ...current.overrides].map((item) => [JSON.stringify(item), item]),
          ).values(),
        ],
      }
    : current
  const policy = held ? resolveLocal(sources, effect) : proposed
  // A source Vector could not read at all might say anything, so where Vector Local was on it stays on with no web.
  const on = [policy, kept, ...(start ? [] : [localState.policy])].some((item) => item.enabled)
  return {
    policy:
      sources.unread.length > 0 && on
        ? {
            ...policy,
            enabled: true,
            web: "none" as const,
            warnings: [
              ...policy.warnings,
              `Vector Local stays on with Web access None until Vector can read ${sources.unread.join(", ")}.`,
            ],
          }
        : policy,
    confirmed: sources.failed ? confirmed : effect,
    pending: held ? { proposed, changes, inputs: current } : undefined,
  }
}

// What the last process let apply, read once, at start: the saved copy of the user's block, or the user's block as it
// is now where there is no copy Vector can read. The overrides are read at start too. Under the agent marker the copy
// is neither trusted nor read and the user's block counts for nothing, so the user's config (wherever XDG_CONFIG_HOME
// points) can only tighten what this process inherited.
function startConfirmed(sources: ReturnType<typeof readLocalSources>) {
  if (agentMarked()) return { user: undefined, overrides: sources.overrides }
  const text = readLocalText(localConfirmedFile())
  const saved = text
    ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(LocalConfirmed))(text))
    : undefined
  localState.saved = saved && JSON.stringify(saved.local)
  if (saved) return { user: saved.local ?? undefined, overrides: sources.overrides }
  return { user: sources.readable ? sources.user : undefined, overrides: sources.overrides }
}

/**
 * What a change loosens: in the policy in effect, and in the user's own block as if it alone turned Vector Local on,
 * so a change the environment or the company's policy hides today is held too. Nothing is held while Local is off.
 */
function heldChanges(
  kept: LocalMode.Policy,
  proposed: LocalMode.Policy,
  before: ConfigLocalV1.Info | undefined,
  after: ConfigLocalV1.Info | undefined,
) {
  if (!kept.enabled) return []
  const own = (block: ConfigLocalV1.Info | undefined) => LocalPolicy.resolve({ global: { ...block, enabled: true } })
  const changes = [
    ...new Set([
      ...loosening(kept, proposed),
      ...(before?.enabled === true && after?.enabled !== true ? [LOCAL_OFF] : []),
      ...loosening(own(before), own(after)),
    ]),
  ]
  return changes.includes(LOCAL_OFF) ? [LOCAL_OFF] : changes
}

// The stricter of two user blocks, setting by setting. The rest of the block (pins, checks) is the newer one's.
function stricterLocal(before: ConfigLocalV1.Info | undefined, after: ConfigLocalV1.Info | undefined) {
  const endpoints = new Set((before?.endpoints ?? []).map((item) => LocalPolicy.origin(item) ?? item))
  const allows = new Set((before?.allow ?? []).map(allowedKey))
  const sites = new Set(before?.web_domains?.allow ?? [])
  const web = before?.web || after?.web ? LocalPolicy.stricter(before?.web ?? "ask", after?.web) : undefined
  return {
    ...after,
    enabled: before?.enabled === true || after?.enabled === true,
    ...(web ? { web } : {}),
    endpoints: (after?.endpoints ?? []).filter((item) => endpoints.has(LocalPolicy.origin(item) ?? item)),
    allow: (after?.allow ?? []).filter((item) => allows.has(allowedKey(item))),
    web_domains: {
      allow: (after?.web_domains?.allow ?? []).filter((pattern) => sites.has(pattern)),
      deny: [...new Set([...(before?.web_domains?.deny ?? []), ...(after?.web_domains?.deny ?? [])])],
    },
  } satisfies ConfigLocalV1.Info
}

function allowedKey(item: LocalMode.Allowed) {
  return JSON.stringify([item.source, [...(item.hosts ?? [])].sort()])
}

function readLocalSources() {
  const managed = ConfigManaged.read()
  const files = localFiles()
  const managedBlocks = [
    ...managed.files.map(localFile),
    ...managed.policies.map((policy) => localBlock(policy.text, policy.source)),
  ].filter((item) => item !== undefined)
  const userBlocks = files.user.map(localFile).filter((item) => item !== undefined)
  const overrides = [
    Flag.VECTOR_CONFIG_CONTENT ? localBlock(Flag.VECTOR_CONFIG_CONTENT, "VECTOR_CONFIG_CONTENT") : undefined,
    ...files.overrides.map(localFile),
  ].filter((item) => item !== undefined)
  const undecodable = (blocks: readonly LocalBlock[]) => blocks.some((item) => item.unreadable === "block")
  const unreadFile = (blocks: readonly LocalBlock[]) => blocks.filter((item) => item.unreadable === "file")
  // Company policy Vector cannot read, or cannot check who may change, might say anything, as one it cannot decode
  // might: either keeps Vector Local on with Web access None, for every user, until it is fixed.
  const managedUnread = [
    ...managed.ignored.filter((item) => item.kind === "unreadable").map((item) => item.source),
    ...unreadFile(managedBlocks).map((item) => item.source),
  ]
  return {
    managed:
      undecodable(managedBlocks) || managedUnread.length > 0 ? LOCAL_FAIL_CLOSED : mergeLocalBlocks(managedBlocks),
    user: undecodable(userBlocks) ? LOCAL_FAIL_CLOSED : mergeLocalBlocks(userBlocks),
    failed: undecodable(userBlocks),
    // While a user file cannot be read, the block in effect stays the one to compare with.
    readable: !userBlocks.some((item) => item.unreadable),
    unread: unreadFile([...userBlocks, ...overrides]).map((item) => item.source),
    overrides: overrides.filter((item) => item.unreadable !== "file"),
    warnings: [
      ...managed.ignored.map((item) =>
        item.kind === "untrusted" ? `${ConfigManaged.UNTRUSTED} ${item.reason}` : item.reason,
      ),
      ...files.ignored.map(
        (file) =>
          `Ignored ${file}: it is inside the repository Vector started in, and only your user config and your company's policy set Vector Local.`,
      ),
      ...[...managedBlocks, ...userBlocks]
        .filter((item) => item.unreadable === "block")
        .map(
          (item) =>
            `Vector could not read the local block in ${item.source}, so Vector Local stays on with Web access None until it is fixed.`,
        ),
      ...unreadFile([...managedBlocks, ...userBlocks, ...overrides]).map(
        (item) => `Vector could not read ${item.source}.`,
      ),
      ...(managedUnread.length > 0
        ? [
            `Vector Local stays on with Web access None until Vector can read ${managedUnread.join(", ")}, which may hold your company's policy.`,
          ]
        : []),
    ],
  }
}

/**
 * The config files Vector Local reads. `user`: the user's own, in the order the config loader merges them, which set
 * it. `overrides`: VECTOR_AGENT_CONFIG, and a VECTOR_AGENT_CONFIG_DIR that is not the desktop's own config folder
 * (the desktop names itself with VECTOR_CLIENT=desktop), which may only tighten it. `ignored`: either of those inside
 * the repository Vector started in, which the repository's .envrc can name, and which is not read at all.
 */
function localFiles() {
  const repository = startRepository()
  const inside = (file: string) => repository !== undefined && ConfigPaths.projectContains(file, repository)
  const agentConfig = localPath(Flag.VECTOR_AGENT_CONFIG)
  const agentDirectory = localPath(Flag.VECTOR_AGENT_CONFIG_DIR)
  const directoryFiles = agentDirectory ? LOCAL_DIRECTORY_FILES.map((file) => path.join(agentDirectory, file)) : []
  const desktop =
    agentDirectory && Flag.VECTOR_CLIENT === "desktop" && !inside(agentDirectory) ? agentDirectory : undefined
  return {
    desktop,
    user: [
      ...LOCAL_GLOBAL_FILES.map((file) => path.join(Global.Path.config, file)),
      ...(desktop ? directoryFiles : []),
    ],
    overrides: [
      ...(agentConfig && !inside(agentConfig) ? [agentConfig] : []),
      ...(agentDirectory && !desktop && !inside(agentDirectory) ? directoryFiles : []),
    ],
    ignored: [agentConfig, agentDirectory].filter((item): item is string => item !== undefined && inside(item)),
  }
}

// The folder Vector started in and the git worktree above it, leaving out a folder that holds the user's home: the
// desktop starts in the filesystem root, and a home folder is not a repository.
function startRepository() {
  const directory = process.cwd()
  if (FSUtil.contains(directory, Global.Path.home)) return undefined
  const worktree = gitRoot(directory)
  return { directory, worktree: worktree && !FSUtil.contains(worktree, Global.Path.home) ? worktree : undefined }
}

function gitRoot(directory: string): string | undefined {
  if (existsSync(path.join(directory, ".git"))) return directory
  const parent = path.dirname(directory)
  if (parent === directory) return undefined
  return gitRoot(parent)
}

// A path an environment variable names, spelled as the config loader spells it (ConfigPaths.environmentPath).
function localPath(input: string | undefined) {
  if (!input) return undefined
  return path.resolve(FSUtil.windowsPath(input))
}

// A file's text, undefined when it does not exist, or null when the file system refuses to read it (no permission, a
// folder in its place).
function readLocalText(file: string) {
  if (!existsSync(file)) return undefined
  try {
    return readFileSync(file, "utf8")
  } catch {
    return null
  }
}

function localFile(file: string): LocalBlock | undefined {
  const text = readLocalText(file)
  if (text === null) return { source: file, unreadable: "file" }
  return localBlock(text, file)
}

// The local block of one config text, without {env:} or {file:} substitution. A legacy TOML config predates it.
function localBlock(text: string | undefined, source: string): LocalBlock | undefined {
  if (!text || !/^\s*[{/]/.test(text)) return undefined
  const value: unknown = parse(text, [], { allowTrailingComma: true })
  if (!isRecord(value) || value.local === undefined) return undefined
  return Option.match(Schema.decodeUnknownOption(ConfigLocalV1.Info)(value.local), {
    onNone: () => ({ source, unreadable: "block" as const }),
    onSome: (block) => ({ source, block }),
  })
}

function mergeLocalBlocks(blocks: readonly LocalBlock[]) {
  return blocks.reduce<ConfigLocalV1.Info | undefined>(
    (merged, item) => (item.block ? (mergeDeep(merged ?? {}, item.block) as ConfigLocalV1.Info) : merged),
    undefined,
  )
}

function resolveLocal(sources: ReturnType<typeof readLocalSources>, inputs: LocalInputs) {
  const resolved = inputs.overrides.reduce(
    tightenLocal,
    LocalPolicy.resolve({ managed: sources.managed, global: inputs.user, env: process.env }),
  )
  // Only the desktop sets VECTOR_LOCAL_POLICY, for an engine it starts in WSL, and the desktop never runs under the
  // agent marker. Under it anything could have set it, so it may still turn Local on and tighten Web access but adds
  // no model server.
  const forged = agentMarked() ? resolved.endpoints.filter((item) => item.from === "environment") : []
  return {
    ...resolved,
    endpoints: resolved.endpoints.filter((item) => !forged.includes(item)),
    warnings: [
      ...new Set([
        ...sources.warnings,
        ...resolved.warnings,
        ...(forged.length > 0
          ? [
              "Ignored the model servers in VECTOR_LOCAL_POLICY: an agent or Vector's own terminal started this Vector, so it cannot add one.",
            ]
          : []),
      ]),
    ],
  }
}

// VECTOR_CONFIG_CONTENT and the config-path overrides may turn Vector Local on, pick a stricter Web access and add
// sites to deny. Everything else they say about it would loosen it, so it is left out with a warning.
function tightenLocal(policy: LocalMode.Policy, override: LocalBlock): LocalMode.Policy {
  if (!override.block)
    return {
      ...policy,
      enabled: true,
      web: "none",
      warnings: [
        ...policy.warnings,
        `Vector could not read the local block in ${override.source}, so Vector Local stays on with Web access None.`,
      ],
    }
  const block = override.block
  const web = LocalPolicy.stricter(policy.web, block.web)
  const ignored = [
    block.enabled === false && policy.enabled ? "enabled" : undefined,
    block.web !== undefined && web !== block.web ? "web" : undefined,
    block.endpoints?.length ? "endpoints" : undefined,
    block.allow?.length ? "allow" : undefined,
    block.web_domains?.allow?.length ? "web_domains.allow" : undefined,
    ...LocalPolicy.MANAGED_ONLY.filter((key) => block[key] !== undefined),
  ].filter((key) => key !== undefined)
  return {
    ...policy,
    enabled: policy.enabled || block.enabled === true,
    web,
    web_domains: {
      allow: policy.web_domains.allow,
      deny: [...policy.web_domains.deny, ...(block.web_domains?.deny ?? [])],
    },
    warnings: [
      ...policy.warnings,
      ...(ignored.length > 0
        ? [
            `Ignored ${ignored.join(", ")} in the local block of ${override.source}: it can only make Vector Local stricter.`,
          ]
        : []),
    ],
  }
}

/**
 * What `after` would loosen compared with `before`, in words for the owner: turning Vector Local off, a looser Web
 * access, a new model server, a newly allowed service or site, or a site no longer denied. Empty when it only tightens.
 */
export function loosening(before: LocalMode.Policy, after: LocalMode.Policy) {
  if (!before.enabled) return []
  if (!after.enabled) return [LOCAL_OFF]
  const endpoint = (item: LocalMode.Endpoint) => `${item.from} ${LocalPolicy.origin(item.origin) ?? item.origin}`
  const endpoints = new Set(before.endpoints.map(endpoint))
  const allows = new Set(before.allow.map(allowedKey))
  return [
    ...(LocalPolicy.stricter(after.web, before.web) !== after.web
      ? [`sets Web access to ${LOCAL_WEB_LABELS[after.web]}`]
      : []),
    ...after.endpoints
      .filter((item) => !endpoints.has(endpoint(item)))
      .map((item) => `adds the model server ${item.origin}`),
    ...after.allow.filter((item) => !allows.has(allowedKey(item))).map((item) => `allows ${item.source}`),
    ...after.web_domains.allow
      .filter((pattern) => !before.web_domains.allow.includes(pattern))
      .map((pattern) => `lets web pages reach ${pattern}`),
    ...before.web_domains.deny
      .filter((pattern) => !after.web_domains.deny.includes(pattern))
      .map((pattern) => `stops blocking ${pattern}`),
  ]
}

function saveLocalConfirmed(block: ConfigLocalV1.Info | undefined) {
  const text = JSON.stringify(block ?? null)
  // A process under the agent marker never writes the copy a later start trusts: it never read it, and the user's
  // config it read may be the agent's.
  if (agentMarked() || text === localState.saved) return
  const file = localConfirmedFile()
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  // Best effort: a copy that cannot be written only means the next start compares with an older block, or with none.
  try {
    writeFileSync(temporary, JSON.stringify({ local: block ?? null }, null, 2), { mode: 0o600 })
    renameSync(temporary, file)
    localState.saved = text
  } catch {
    return
  }
}

function startLocalWatchers() {
  const timer: { current?: ReturnType<typeof setTimeout> } = {}
  const schedule = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(refreshLocal, 50)
    timer.current.unref?.()
  }
  const user = localFiles().user
  const targets = [...new Set([...user.map((file) => path.dirname(file)), ...ConfigManaged.directories()])]
  const names = new Set([...user.map((file) => path.basename(file)), "vector.json", "vector.jsonc"])
  const watchers = targets.flatMap((directory) => {
    if (!existsSync(directory)) return []
    // A folder that cannot be watched (removed, or out of watches) still applies at the next start.
    try {
      const watcher = watch(directory, { persistent: false }, (_event, name) => {
        if (!name || names.has(name)) schedule()
      })
      watcher.on("error", () => watcher.close())
      return [watcher]
    } catch {
      return []
    }
  })
  return () => {
    clearTimeout(timer.current)
    watchers.forEach((watcher) => watcher.close())
  }
}

refreshLocal()

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const authSvc = yield* Auth.Service
    const teams = yield* Teams.Service
    const env = yield* Env.Service
    const dependencies = yield* ConfigDependencies.Service
    const http = yield* HttpClient.HttpClient
    const flock = yield* EffectFlock.Service
    // Edits to the files Vector Local reads apply, or are held, while this layer is up.
    yield* Effect.acquireRelease(Effect.sync(watchLocal), (stop) => Effect.sync(stop))

    // `root` is where the import may write: the folder itself for the user's own, the workspace for a project's.
    const importSettings = (directory: string, local = false, root = directory) =>
      ConfigImport.run(directory, local, root).pipe(
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(EffectFlock.Service, flock),
        Effect.orDie,
      )

    const readConfigFile = (filepath: string) => fs.readFileStringSafe(filepath).pipe(Effect.orDie)

    const fetchRemoteJson = Effect.fnUntraced(function* <S extends Schema.Top>(
      url: string,
      headers: Record<string, string> | undefined,
      schema: S,
      loginOrigin: string,
    ) {
      const response = yield* withTransientReadRetry(http)
        .execute(
          HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.setHeaders(headers ?? {})),
        )
        .pipe(
          Effect.catch((error) => Effect.die(new Error(`failed to fetch remote config from ${url}: ${String(error)}`))),
        )
      if (response.status === 404 && url.endsWith("/.well-known/vector")) {
        yield* Effect.logWarning(
          `Organization config at ${url} is not available for Vector (HTTP 404). Ask your administrator to serve /.well-known/vector, or run vector providers logout ${loginOrigin}. Skipping this organization config.`,
        )
        return
      }
      if (response.status < 200 || response.status >= 300)
        return yield* Effect.die(new Error(`Remote config at ${url} returned HTTP ${response.status}`))
      const body = yield* response.text.pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to read remote config from ${url}: ${String(error)}`))),
      )
      // An auth proxy can answer with an HTML login page at HTTP 200 (passes filterStatusOk); treat it as a re-auth error, not a decode failure.
      const contentType = (response.headers["content-type"] ?? "").toLowerCase()
      if (contentType.includes("html") || /^\s*<!doctype|^\s*<html/i.test(body)) {
        return yield* Effect.die(new RemoteAuthError({ url: loginOrigin, remote: url }))
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to decode remote config from ${url}: ${String(error)}`))),
      )
    })

    const loadConfig = Effect.fnUntraced(function* (
      text: string,
      options: { path: string } | { dir: string; source: string },
      env?: Record<string, string>,
      preserveSource = false,
      opaqueCredentials = false,
    ) {
      const source = "path" in options ? options.path : options.source
      const parseSource =
        "path" in options ? ({ type: "path", path: options.path } as const) : ({ type: "virtual", ...options } as const)
      // An untrusted project's {env:...} and {file:...} stay as written: reading them is the project's choice, not the
      // user's, and a device or FIFO path could hang the load.
      const parsed = opaqueCredentials
        ? ConfigParse.jsonc(text, source)
        : ConfigParse.jsonc(
            yield* Effect.promise(() => ConfigVariable.substitute({ ...parseSource, text, env })),
            source,
          )
      const data = ConfigParse.schema(ConfigV1.Info, normalizeLoadedConfig(parsed), source)
      if (!("path" in options)) return data

      yield* Effect.promise(() => resolveLoadedPlugins(data, options.path))
      const updated = ConfigSchema.rewrite(text)
      // Only the user's own files are rewritten here, and never through a link: a linked settings file belongs to
      // whatever it points at.
      if (updated !== text && !preserveSource && FSUtil.writableInside(path.dirname(options.path), options.path)) {
        data.$schema = "https://vectordev.ai/config.json"
        yield* fs.writeFileString(options.path, updated).pipe(Effect.catch(() => Effect.void))
      }
      return data
    })

    const loadFile = Effect.fnUntraced(function* (
      filepath: string,
      env?: Record<string, string>,
      preserveSource = false,
      opaqueCredentials = false,
    ) {
      yield* Effect.logInfo("loading", { path: filepath })
      const text = yield* readConfigFile(filepath)
      if (!text) return {} as Info
      const normalized = /^\s*[{/]/.test(text) ? text : JSON.stringify(ConfigMigration.parseConfig(text, filepath))
      return yield* loadConfig(normalized, { path: filepath }, env, preserveSource, opaqueCredentials)
    })

    const loadGlobal = Effect.fnUntraced(function* (env?: Record<string, string>) {
      yield* importSettings(Global.Path.config)
      let result: Info = {}
      // Seed the default global config with the schema for editor completion, but avoid writing when the user
      // explicitly routes config through env-provided paths or content.
      if (!Flag.VECTOR_AGENT_CONFIG && !Flag.VECTOR_AGENT_CONFIG_DIR && !Flag.VECTOR_CONFIG_CONTENT) {
        const file = globalConfigFile()
        if (!existsSync(file) && FSUtil.writableInside(Global.Path.config, file)) {
          yield* fs
            .writeWithDirs(file, JSON.stringify({ $schema: "https://vectordev.ai/config.json" }, null, 2))
            .pipe(Effect.catch(() => Effect.void))
        }
      }

      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "config.json"), env, true))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "vector.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "vector.jsonc"), env))

      // Config.local() is the only reader of Vector Local's settings.
      return omit(result, ["local"])
    })

    const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
      loadGlobal().pipe(
        Effect.tapError((error) =>
          Effect.logError("failed to load global config, using defaults", { error: String(error) }),
        ),
        Effect.orElseSucceed((): Info => ({})),
      ),
      Duration.infinity,
    )

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      // Mask cache publication too: protecting only the loader lets its pending interruption become the cached exit.
      return yield* Effect.uninterruptible(cachedGlobal)
    })

    // A repository's budget.run stopped applying when spend limits became one overall set. Say so once per repository
    // file, so a cap someone relied on does not disappear silently, without repeating it on every load. Parallel agents
    // and copies of a repository load it from new folders, so a file is remembered by the repository it belongs to
    // (its remote or first commit, which worktrees and copies share) and its path inside it rather than by where it
    // sits on disk. A folder without Git has no such identity; its copies share the file's content instead. Only the
    // most recent files are remembered, so the list cannot grow without bound.
    const noticeIgnoredRunBudgets = Effect.fn("Config.noticeIgnoredRunBudgets")(function* (
      workspace: string,
      repository: string,
      sources: string[],
    ) {
      yield* Effect.logWarning("ignoring budget.run in repository config; spend limits cover every repository", {
        sources,
      })
      const file = path.join(Global.Path.state, "ignored-repository-budgets.json")
      const noticed = yield* fs.readJson(file).pipe(
        Effect.map((value) =>
          Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [],
        ),
        Effect.orElseSucceed((): string[] => []),
      )
      const entries = yield* Effect.forEach(sources, (source) =>
        Effect.gen(function* () {
          const relative = path.relative(workspace, source) || source
          if (repository !== "global") return { relative, key: `${repository}:${relative}` }
          const content = (yield* fs.readFileStringSafe(source).pipe(Effect.orElseSucceed(() => undefined))) ?? ""
          return {
            relative,
            key: `content:${createHash("sha256").update(`${relative}\n${content}`).digest("hex").slice(0, 32)}`,
          }
        }),
      )
      const fresh = entries.filter((entry) => !noticed.includes(entry.key))
      if (!fresh.length) return
      const keys = fresh.map((entry) => entry.key)
      yield* fs
        .writeWithDirs(
          file,
          JSON.stringify([...noticed.filter((key) => !keys.includes(key)), ...keys].slice(-IGNORED_BUDGETS_KEPT)),
        )
        .pipe(Effect.ignore)
      const files = fresh.map((entry) => entry.relative).join(" and ")
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: TuiEvent.ToastShow.type,
          properties: {
            title: "Repository spend cap ignored",
            message: `This repository's ${files} ${fresh.length === 1 ? "sets" : "set"} budget.run, which no longer applies: spend limits now cover all your repositories together. ${
              Flag.VECTOR_CLIENT === "desktop"
                ? "Set your limits in Settings, under Spend limits."
                : `Set budget.run in ${path.join(Global.Path.config, "vector.json")} instead, or pass --max-cost to vector run.`
            }`,
            variant: "warning",
            duration: 15_000,
          },
        },
      })
    })

    const ensureGitignore = Effect.fn("Config.ensureGitignore")(function* (dir: string, root: string) {
      const gitignore = path.join(dir, ".gitignore")
      const hasIgnore = yield* fs.existsSafe(gitignore)
      // A dangling link reads as missing, and writing it would create the file it points at.
      if (!hasIgnore && FSUtil.writableInside(root, gitignore)) {
        yield* fs
          .writeFileString(
            gitignore,
            ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore", ...LOCAL_CONFIG_FILES].join(
              "\n",
            ),
          )
          .pipe(
            Effect.catchIf(
              (e) => e.reason._tag === "PermissionDenied",
              () => Effect.void,
            ),
          )
      }
    })

    const loadInstanceState = Effect.fn("Config.loadInstanceState")(
      function* (ctx: InstanceContext) {
        const auth = yield* authSvc.all().pipe(Effect.orDie)
        const managed = ConfigManaged.read()
        const projectFiles = Flag.VECTOR_DISABLE_PROJECT_CONFIG
          ? []
          : yield* ConfigPaths.files("vector", ctx.directory, ctx.worktree).pipe(Effect.orDie)
        const projectTuiFiles = Flag.VECTOR_DISABLE_PROJECT_CONFIG
          ? []
          : yield* ConfigPaths.files("tui", ctx.directory, ctx.worktree).pipe(Effect.orDie)
        // A file or directory an env var names is project config when it is inside the project under any spelling.
        const agentConfig = yield* ConfigPaths.environmentPath(Flag.VECTOR_AGENT_CONFIG, ctx)
        const agentConfigDir = yield* ConfigPaths.environmentPath(Flag.VECTOR_AGENT_CONFIG_DIR, ctx)
        // Not loaded here, but captured as the TUI captures it, so both reach the same trust decision.
        const tuiConfig = yield* ConfigPaths.environmentPath(Flag.VECTOR_TUI_CONFIG, ctx)
        const allDirectories = Array.from(
          new Set(
            (yield* ConfigPaths.directories(ctx.directory, ctx.worktree)).map(
              (directory) => ConfigPaths.projectPath(directory, ctx) ?? directory,
            ),
          ),
        )
        // Above a non-git workspace the upward walk also finds .vector folders in its parents, such as the top of an
        // extracted archive or a shared /tmp. The vector.json files beside them already load as the project's, and so
        // do these: their settings stay narrowed and their plugins, commands and agents wait for trust, as the TUI and
        // core already treat them. The user's own folders are never among them.
        const parentDirectories =
          ctx.worktree === "/"
            ? allDirectories.filter(
                (directory) =>
                  path.basename(directory) === ".vector" &&
                  !ConfigPaths.userOwned(directory) &&
                  FSUtil.contains(path.dirname(directory), ctx.directory) &&
                  !FSUtil.contains(ctx.directory, directory),
              )
            : []
        const projectContains = (file: string) =>
          ConfigPaths.projectContains(file, ctx) ||
          parentDirectories.some((directory) => FSUtil.contains(directory, file))
        const projectDirectories = allDirectories.filter(projectContains)
        const localAgentConfig = agentConfig?.project ? [agentConfig.path] : []
        const trustWorkspace = ctx.worktree === "/" ? ctx.directory : ctx.worktree
        // Where a config folder may be written, never through a link: a project folder only where it really is inside
        // the workspace, a folder above a non-git workspace only inside the folder that holds it, and the user's own
        // folder only inside itself.
        const writeRoot = (dir: string) =>
          parentDirectories.includes(dir) ? path.dirname(dir) : projectContains(dir) ? trustWorkspace : dir
        const prepareProjectFile = Effect.fnUntraced(function* (filepath: string) {
          // This runs before any trust decision, and writing follows links: a project's vector.json linked, or
          // hard-linked, to ../../.codex/config.toml would turn that file into JSON. Only a plain file really inside
          // the workspace is rewritten.
          if (!FSUtil.writableInside(trustWorkspace, filepath)) return
          const text = yield* readConfigFile(filepath)
          if (!text) return
          const normalized = /^\s*[{/]/.test(text) ? text : JSON.stringify(ConfigMigration.parseConfig(text, filepath))
          const updated = ConfigSchema.rewrite(normalized)
          if (updated === normalized) return
          yield* fs.writeFileString(filepath, updated).pipe(Effect.catch(() => Effect.void))
        })
        const captureTrustSnapshot = () =>
          WorkspaceTrust.snapshot(trustWorkspace, [
            ...projectFiles,
            ...projectTuiFiles,
            ...projectDirectories,
            ...localAgentConfig,
            ...(tuiConfig?.project ? [tuiConfig.path] : []),
          ]).catch((cause) => WorkspaceTrust.unavailableSnapshot(trustWorkspace, cause))
        const existingTrustSnapshot = yield* Effect.promise(captureTrustSnapshot)
        const snapshotFailure = WorkspaceTrust.unavailableReason(existingTrustSnapshot)
        if (snapshotFailure) {
          yield* Effect.logWarning("disabling project config because workspace trust capture failed", {
            workspace: trustWorkspace,
            reason: snapshotFailure,
          })
        }
        const existingStoredTrust = yield* Effect.promise(() =>
          WorkspaceTrust.status(Global.Path.state, existingTrustSnapshot),
        )
        if (!snapshotFailure && !existingStoredTrust.trusted) {
          yield* Effect.forEach(
            new Set([
              ...projectFiles,
              ...localAgentConfig,
              ...projectDirectories.flatMap((directory) =>
                ["vector.json", "vector.jsonc", ...LOCAL_CONFIG_FILES].map((file) => path.join(directory, file)),
              ),
            ]),
            prepareProjectFile,
            { discard: true },
          )
        }
        const trustSnapshot =
          existingStoredTrust.trusted || snapshotFailure
            ? existingTrustSnapshot
            : yield* Effect.promise(captureTrustSnapshot)
        const storedTrust = yield* Effect.promise(() => WorkspaceTrust.status(Global.Path.state, trustSnapshot))
        const trusted = !Flag.VECTOR_PURE && storedTrust.trusted
        if (!trusted && !Flag.VECTOR_PURE && WorkspaceTrust.hasInputs(trustSnapshot)) {
          yield* Effect.logWarning("ignoring project config until the workspace is trusted", {
            workspace: trustWorkspace,
          })
        }
        const trustedSnapshot = trusted
          ? yield* Effect.promise(() => WorkspaceTrust.materialize(Global.Path.state, trustSnapshot))
          : undefined
        const workspace = ctx.worktree === "/" ? ctx.directory : ctx.worktree

        const loadProjectFile = Effect.fnUntraced(function* (
          filepath: string,
          env?: Record<string, string>,
          opaqueCredentials = false,
        ) {
          yield* Effect.logInfo("loading captured project config", { path: filepath })
          const text = WorkspaceTrust.readFileString(trustSnapshot, filepath)
          if (!text) return {} as Info
          const source = trustedSnapshot ? WorkspaceTrust.materializedPath(trustedSnapshot, filepath) : filepath
          const normalized = /^\s*[{/]/.test(text) ? text : JSON.stringify(ConfigMigration.parseConfig(text, filepath))
          const loaded = yield* loadConfig(normalized, { path: source }, env, true, opaqueCredentials)
          if (!trustedSnapshot) return loaded
          const bound = bindTrustedProjectExecutables(loaded, trustedSnapshot, workspace, filepath)
          // Trust drops what it cannot bind to approved bytes; say which, so a missing integration is explicable.
          const dropped = (["formatter", "lsp", "mcp"] as const).flatMap((key) => {
            const before = loaded[key]
            const after = bound[key]
            if (!isRecord(before) || !isRecord(after)) return []
            return Object.keys(before)
              .filter((name) => !(name in after))
              .map((name) => `${key}.${name}`)
          })
          if (dropped.length)
            yield* Effect.logWarning("trust left out project commands it cannot bind to approved bytes", {
              path: filepath,
              dropped,
            })
          return bound
        })

        let result: Info = {}
        const authEnv: Record<string, string> = {}

        const pluginScopeForSource = Effect.fnUntraced(function* (source: string) {
          if (source.startsWith("http://") || source.startsWith("https://")) return "global"
          if (source === "VECTOR_CONFIG_CONTENT") return "local"
          if (projectContains(source)) return "local"
          return "global"
        })

        const mergePluginOrigins = Effect.fnUntraced(function* (
          source: string,
          // mergePluginOrigins receives raw Specs from one config source, before provenance for this merge step
          // is attached.
          list: ConfigPluginV1.Spec[] | undefined,
          // Scope can be inferred from the source path, but some callers already know whether the config should
          // behave as global or local and can pass that explicitly.
          kind?: ConfigPlugin.Scope,
        ) {
          if (!list?.length) return
          const hit = kind ?? (yield* pluginScopeForSource(source))
          // Merge newly seen plugin origins with previously collected ones, then dedupe by plugin identity while
          // keeping the winning source/scope metadata for downstream installs, writes, and diagnostics.
          const plugins = ConfigPlugin.deduplicatePluginOrigins([
            ...(result.plugin_origins ?? []),
            ...list.map((spec) => ({ spec, source, scope: hit })),
          ])
          result.plugin = plugins.map((item) => item.spec)
          result.plugin_origins = plugins
        })

        // The user's own sources merged alone, and whether a trusted project granted any permission over them.
        let userPermissions: Pick<Info, "permission" | "tools" | "agent"> = {}
        let projectGrants = false
        // Repository files whose budget.run was dropped, for the notice once loading ends.
        const ignoredRunBudgets: string[] = []

        // Only Config.local() says what Vector Local is: it was resolved at start from the user's own config files and
        // the company's policy (refreshLocal), so no source's local block reaches the merged config. A repository's is
        // never read, and the policy this instance reports says so; VECTOR_CONFIG_CONTENT's and the config-path
        // overrides' only tightened it.
        const localConfig = localFiles()
        const localSources = new Set([Global.Path.config, ...managed.files, ...localConfig.user])
        const startOverrides = new Set(["VECTOR_CONFIG_CONTENT", ...localConfig.overrides])
        const localDirectory = localConfig.desktop ?? Global.Path.config
        let repositoryLocal = false

        const merge = (source: string, input: Info, kind?: ConfigPlugin.Scope) => {
          const scope = kind ?? (projectContains(source) ? "local" : "global")
          const projectSource = scope === "local" && source !== "VECTOR_CONFIG_CONTENT"
          const next = input.local === undefined ? input : omit(input, ["local"])
          if (projectSource && next.budget?.run) ignoredRunBudgets.push(source)
          const safe = projectSource ? projectExecutableConfig(next, trusted, result) : next
          if (projectSource) projectGrants ||= grantsPermission(safe)
          // Only the keys a source sets: merging an undefined key would erase what an earlier user source declared,
          // as an empty integration store loaded after the project would.
          else
            userPermissions = mergeConfigConcatArrays(userPermissions, {
              ...(safe.permission && { permission: safe.permission }),
              ...(safe.tools && { tools: safe.tools }),
              ...(safe.agent && { agent: safe.agent }),
            })
          result = mergeConfigConcatArrays(result, safe)
          if (projectSource && input.local !== undefined) repositoryLocal = true
          const ignored =
            input.local === undefined || localSources.has(source)
              ? Effect.void
              : projectSource
                ? Effect.logWarning(LocalPolicy.REPOSITORY_IGNORED, { source })
                : startOverrides.has(source)
                  ? Effect.logDebug("this config's local block only tightened Vector Local at start", { source })
                  : Effect.logWarning(
                      `Ignored the local block in ${source}: Vector Local is read only from your user config in ${localDirectory} and from your company's policy.`,
                    )
          return ignored.pipe(Effect.andThen(mergePluginOrigins(source, safe.plugin, scope)))
        }

        for (const [key, value] of Object.entries(auth)) {
          if (value.type === "wellknown") {
            const url = key.replace(/\/+$/, "")
            authEnv[value.key] = value.token
            const wellknownURL = `${url}/.well-known/vector`
            yield* Effect.logDebug("fetching remote config", { url: wellknownURL })
            const wellknown = yield* fetchRemoteJson(wellknownURL, undefined, ConfigV1.WellKnown, url)
            if (!wellknown) continue
            const remote = yield* Effect.promise(() =>
              substituteWellKnownRemoteConfig({
                value: wellknown.remote_config,
                dir: url,
                source: wellknownURL,
                env: authEnv,
              }),
            )
            const fetchedConfig = remote
              ? yield* Effect.gen(function* () {
                  yield* Effect.logDebug("fetching remote config", { url: remote.url })
                  const data = yield* fetchRemoteJson(remote.url, remote.headers, Schema.Json, url)
                  if (isRecord(data) && isRecord(data.config)) return data.config
                  if (isRecord(data)) return data
                  return yield* Effect.die(
                    new Error(`failed to decode remote config from ${remote.url}: expected object`),
                  )
                })
              : {}
            const remoteConfig = mergeConfig(isRecord(wellknown.config) ? wellknown.config : {}, fetchedConfig)
            if (!remoteConfig.$schema) remoteConfig.$schema = "https://vectordev.ai/config.json"
            const source = wellknownURL
            const next = yield* loadConfig(
              JSON.stringify(remoteConfig),
              {
                dir: path.dirname(source),
                source,
              },
              authEnv,
            )
            yield* merge(source, next, "global")
            yield* Effect.logDebug("loaded remote config from well-known", { url })
          }
        }

        const team = yield* teams.current().pipe(Effect.orDie)
        if (team.active) {
          const source = `https://vectordev.ai/api/org/config?org=${team.active.id}`
          const next = yield* loadConfig(
            JSON.stringify(team.active.config),
            { dir: "https://vectordev.ai", source },
            authEnv,
          )
          yield* merge(source, next, "global")
        }

        const global = Object.keys(authEnv).length ? yield* loadGlobal(authEnv) : yield* getGlobal()
        yield* merge(Global.Path.config, global, "global")

        if (agentConfig) {
          const next = agentConfig.project
            ? yield* loadProjectFile(agentConfig.path, authEnv, !trusted)
            : yield* loadFile(agentConfig.path, authEnv, true)
          yield* merge(agentConfig.path, next, agentConfig.project ? "local" : "global")
          yield* Effect.logDebug("loaded custom config", { path: agentConfig.path })
        }

        if (!Flag.VECTOR_DISABLE_PROJECT_CONFIG) {
          for (const file of projectFiles) {
            yield* merge(file, yield* loadProjectFile(file, authEnv, !trusted), "local")
          }
        }

        result.agent = result.agent || {}
        result.mode = result.mode || {}
        result.plugin = result.plugin || []

        const directories = allDirectories
          .filter((directory) => !projectContains(directory) || trusted)
          .map((directory) =>
            projectContains(directory) && trustedSnapshot
              ? WorkspaceTrust.materializedPath(trustedSnapshot, directory)
              : directory,
          )

        if (agentConfigDir) {
          yield* Effect.logDebug("loading config from VECTOR_AGENT_CONFIG_DIR", { path: agentConfigDir.path })
        }

        const deps: Fiber.Fiber<void>[] = []

        for (const dir of allDirectories) {
          const local = projectContains(dir)
          const runtimeDir = local && trustedSnapshot ? WorkspaceTrust.materializedPath(trustedSnapshot, dir) : dir
          if (dir.endsWith(".vector") || dir === agentConfigDir?.path) {
            if (dir === agentConfigDir?.path) yield* importSettings(dir, false, writeRoot(dir))
            if (!local || trusted) yield* importSettings(dir, true, writeRoot(dir))
            // Local files merge after the shared ones so machine-local settings win.
            for (const file of ["vector.json", "vector.jsonc", ...LOCAL_CONFIG_FILES]) {
              const source = path.join(dir, file)
              yield* Effect.logDebug(`loading config from ${source}`)
              const next = local ? yield* loadProjectFile(source, authEnv, !trusted) : yield* loadFile(source, authEnv)
              yield* merge(source, next)
              result.agent ??= {}
              result.mode ??= {}
              result.plugin ??= []
            }
          }

          if (local && !trusted) continue

          // The desktop also owns .vector directories containing repository state and rules.
          const runtimeFiles =
            dir === Global.Path.config ||
            dir === agentConfigDir?.path ||
            (yield* fs.isFile(path.join(runtimeDir, "package.json"))) ||
            (yield* Effect.forEach(["plugin", "plugins", "tool", "tools"], (name) =>
              fs.isDir(path.join(runtimeDir, name)),
            )).some(Boolean)
          if (runtimeFiles) yield* ensureGitignore(dir, writeRoot(dir)).pipe(Effect.orDie)

          result.command = mergeDeep(result.command ?? {}, yield* Effect.promise(() => ConfigCommand.load(runtimeDir)))
          const agents = mergeDeep(
            yield* Effect.promise(() => ConfigAgent.load(runtimeDir)),
            yield* Effect.promise(() => ConfigAgent.loadMode(runtimeDir)),
          )
          if (local) projectGrants ||= grantsPermission({ agent: agents })
          else userPermissions = mergeConfigConcatArrays(userPermissions, { agent: agents })
          result.agent = mergeDeep(result.agent ?? {}, agents)
          // Auto-discovered plugins under `.vector/plugin(s)` are already local files, so ConfigPlugin.load
          // returns normalized Specs and we only need to attach origin metadata here.
          const list = yield* Effect.promise(() => ConfigPlugin.load(runtimeDir))
          yield* mergePluginOrigins(dir, list)
        }

        if (!Flag.VECTOR_DISABLE_PROJECT_CONFIG) {
          const store = integrationStore(workspace)
          yield* merge(store, yield* loadFile(store, authEnv), "global")
        }

        if (Flag.VECTOR_CONFIG_CONTENT) {
          const source = "VECTOR_CONFIG_CONTENT"
          const next = yield* loadConfig(
            Flag.VECTOR_CONFIG_CONTENT,
            {
              dir: ctx.directory,
              source,
            },
            undefined,
            false,
            false,
          )
          yield* merge(source, next, "local")
          yield* Effect.logDebug("loaded custom config from VECTOR_CONFIG_CONTENT")
        }

        // Company policy counts only where a standard user could not have written it (ConfigManaged.read).
        if (managed.ignored.length > 0)
          yield* Effect.logWarning(
            "left out company policy that a standard user could change or Vector could not read",
            {
              ignored: managed.ignored,
            },
          )
        for (const source of managed.files) {
          yield* merge(source, yield* loadFile(source), "global")
        }

        // The macOS MDM profile and the Windows policy key override everything
        for (const policy of managed.policies) {
          const next = yield* loadConfig(policy.text, {
            dir: path.dirname(policy.source),
            source: policy.source,
          })
          userPermissions = mergeConfigConcatArrays(userPermissions, {
            ...(next.permission && { permission: next.permission }),
            ...(next.tools && { tools: next.tools }),
            ...(next.agent && { agent: next.agent }),
          })
          result = mergeConfigConcatArrays(result, omit(next, ["local"]))
        }

        for (const [name, mode] of Object.entries(result.mode ?? {})) {
          result.agent = mergeDeep(result.agent ?? {}, {
            [name]: {
              ...mode,
              mode: "primary" as const,
            },
          })
        }

        if (Flag.VECTOR_PERMISSION) {
          try {
            const permission = JSON.parse(Flag.VECTOR_PERMISSION)
            result.permission = mergeDeep(result.permission ?? {}, permission)
            userPermissions.permission = mergeDeep(userPermissions.permission ?? {}, permission)
          } catch (err) {
            yield* Effect.logWarning("VECTOR_PERMISSION contains invalid JSON, skipping", { err })
          }
        }

        if (result.tools) result.permission = mergeDeep(toolPermissions(result.tools), result.permission ?? {})

        if (!result.username) {
          try {
            result.username = os.userInfo().username || "user"
          } catch (err) {
            yield* Effect.logWarning("failed to read system username, using fallback", { err })
            result.username = "user"
          }
        }

        // Preferences do not grant publication consent. The sharing service only
        // auto-publishes after explicit, account-bound consent in the trusted store.
        result.share ??= result.autoshare ? "auto" : "manual"

        if (Flag.VECTOR_DISABLE_AUTOCOMPACT) {
          result.compaction = { ...result.compaction, auto: false }
        }
        if (Flag.VECTOR_DISABLE_PRUNE) {
          result.compaction = { ...result.compaction, prune: false }
        }

        if (!InstallationLocal && result.plugin?.length) {
          deps.push(yield* dependencies.prepare().pipe(Effect.forkDetach))
        }

        if (ignoredRunBudgets.length) yield* noticeIgnoredRunBudgets(workspace, ctx.project.id, ignoredRunBudgets)
        announceHeldLocal()

        const settings = WorkspaceTrust.hasInputs(trustSnapshot)
        const desktop = Flag.VECTOR_CLIENT === "desktop"
        // Without this the repository's agents, commands and default model, or the user's language servers,
        // formatters and MCP servers, would vanish or change with no explanation. The desktop app asks once about a
        // repository's own settings and remembers "Not now", so repeating it on every load would undo that answer;
        // it never asks about a repository without settings, where only the user's tools are held back.
        if (!trusted && !Flag.VECTOR_PURE && (settings ? !desktop : startsInWorkspace(result))) {
          const held = settings
            ? "Vector is not loading this repository's vector.json or .vector settings until you trust it, and keeps your language servers, formatters and MCP servers out of it."
            : "Vector keeps your language servers, formatters and MCP servers out of this repository until you trust it."
          GlobalBus.emit("event", {
            directory: "global",
            payload: {
              type: TuiEvent.ToastShow.type,
              properties: {
                title: settings ? "Repository settings ignored" : "Repository not trusted",
                // The desktop ships no vector command, and the published CLI predates /trust and `vector trust`.
                message: `${held} ${
                  desktop
                    ? "Trust it in Settings, under Repository trust."
                    : "Use /trust in the TUI, Repository trust in the app's Settings, or run `vector trust approve` in the repository."
                }`,
                variant: "warning",
                duration: 15_000,
              },
            },
          })
        }

        return {
          config: result,
          repositoryLocal,
          directories,
          configDirectory:
            agentConfigDir?.project && trustedSnapshot
              ? WorkspaceTrust.materializedPath(trustedSnapshot, agentConfigDir.path)
              : agentConfigDir?.path,
          deps,
          trust: trustSnapshot,
          trusted,
          trustedSnapshot,
          ceiling:
            trusted && projectGrants
              ? {
                  permission: mergeDeep(toolPermissions(userPermissions.tools ?? {}), userPermissions.permission ?? {}),
                  agent: Object.fromEntries(
                    Object.entries(userPermissions.agent ?? {}).flatMap(([name, agent]) =>
                      agent?.permission ? [[name, agent.permission]] : [],
                    ),
                  ),
                }
              : undefined,
        }
      },
      Effect.provideService(FSUtil.Service, fs),
      Effect.provideService(EffectFlock.Service, flock),
    )

    const state = yield* InstanceState.make<State>(
      Effect.fn("Config.state")(function* (ctx) {
        return yield* loadInstanceState(ctx).pipe(Effect.orDie)
      }),
    )

    const get = Effect.fn("Config.get")(function* () {
      return yield* InstanceState.use(state, (s) => s.config)
    })

    const directories = Effect.fn("Config.directories")(function* () {
      return yield* InstanceState.use(state, (s) => s.directories)
    })

    const waitForDependencies = Effect.fn("Config.waitForDependencies")(function* () {
      yield* InstanceState.useEffect(state, (s) =>
        Effect.forEach(s.deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.asVoid),
      )
    })

    const permissionCeiling = Effect.fn("Config.permissionCeiling")(function* () {
      return yield* InstanceState.use(state, (s) => s.ceiling)
    })

    const localPolicy = Effect.fn("Config.localPolicy")(function* () {
      const repository = yield* InstanceState.use(state, (s) => s.repositoryLocal)
      const policy = local()
      if (!repository) return policy
      return { ...policy, warnings: [LocalPolicy.REPOSITORY_IGNORED, ...policy.warnings] }
    })

    const trustedPath = Effect.fn("Config.trustedPath")(function* (path: string) {
      return yield* InstanceState.use(state, (s) =>
        s.trustedSnapshot ? WorkspaceTrust.materializedPathOption(s.trustedSnapshot, path) : undefined,
      )
    })

    const trust = Effect.fn("Config.trust")(function* () {
      return yield* InstanceState.useEffect(state, (s) =>
        Effect.promise(async () => {
          const status = await WorkspaceTrust.status(Global.Path.state, s.trust)
          return {
            ...status,
            ignored:
              !status.trusted &&
              !Flag.VECTOR_PURE &&
              (WorkspaceTrust.hasInputs(s.trust) || startsInWorkspace(s.config)),
            settings: WorkspaceTrust.hasInputs(s.trust),
          }
        }),
      )
    })

    const approve = Effect.fn("Config.approve")(function* () {
      yield* InstanceState.useEffect(state, (s) =>
        Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, s.trust)),
      )
    })

    // The config a file holds as written: {env:...} and {file:...} references stay
    // unresolved, so a secret restored from it goes back as its reference. Plugin
    // specs resolve as they do on load, so each plugin tuple a client sends back
    // pairs with the stored one.
    const storedFile = Effect.fnUntraced(function* (file: string) {
      const text = yield* readConfigFile(file)
      if (!text || !/^\s*[{/]/.test(text)) return {}
      const stored = ConfigParse.schema(ConfigV1.Info, normalizeLoadedConfig(ConfigParse.jsonc(text, file)), file)
      return yield* Effect.promise(() => resolveLoadedPlugins(stored, file))
    })

    const update = Effect.fn("Config.update")(function* (config: Info) {
      const ctx = yield* InstanceState.context
      const file = path.join(ctx.directory, "vector.json")
      // The project's vector.json can be a link to any file of the user's, which a write would replace.
      const workspace = ctx.worktree === "/" ? ctx.directory : ctx.worktree
      if (!FSUtil.writableInside(workspace, file))
        return yield* Effect.die(
          new Error(`Cannot save settings to ${file}: it is a link, not a plain file, or outside ${workspace}.`),
        )
      // As written: {env:...} and {file:...} resolved here would be saved into the project file in place of their
      // references, and an untrusted project's {file:...} could name any file of the user's.
      const existing = yield* loadFile(file, undefined, false, true)
      // A client sends secrets back as Redaction.MARKER. Restoring them before the
      // merge keeps the ones inside arrays, such as plugin options, which a deep
      // merge replaces wholesale.
      const patch = Redaction.restore(writable(config), yield* storedFile(file))
      yield* fs.writeFileString(file, JSON.stringify(mergeDeep(writable(existing), patch), null, 2)).pipe(Effect.orDie)
    })

    const invalidate = Effect.fn("Config.invalidate")(function* () {
      yield* invalidateGlobal
    })

    // Persists a runtime MCP mutation into the project's integration store so it
    // survives a backend restart. A full entry replaces the server's config wholesale (a
    // deep patch could leave e.g. a stale `command` behind a type switch to "remote");
    // an { enabled } entry only flips the flag, layering over configs defined elsewhere.
    const updateMcpLocal = Effect.fn("Config.updateMcpLocal")(function* (
      name: string,
      entry: ConfigMCPV1.Info | { enabled: boolean },
    ) {
      const ctx = yield* InstanceState.context
      // Non-git projects have worktree "/", which is not a usable project root.
      const file = integrationStore(ctx.worktree === "/" ? ctx.directory : ctx.worktree)
      const before =
        (yield* readConfigFile(file)) ?? JSON.stringify({ $schema: "https://vectordev.ai/config.json" }, null, 2)
      const edits = modify(
        before,
        "type" in entry ? ["mcp", name] : ["mcp", name, "enabled"],
        "type" in entry ? entry : entry.enabled,
        { formattingOptions: { insertSpaces: true, tabSize: 2 } },
      )
      if (!FSUtil.writableInside(path.dirname(file), file))
        return yield* Effect.die(new Error(`Cannot save the integration to ${file}: it is a link or not a plain file.`))
      yield* fs.writeWithDirs(file, applyEdits(before, edits)).pipe(Effect.orDie)
    })

    // The MCP entry as the config files hold it, merged in load order. get() has
    // {env:...} and {file:...} references resolved; writing that back would put the
    // resolved secret into a file in place of its reference.
    const storedMcp = Effect.fn("Config.storedMcp")(function* (name: string) {
      const ctx = yield* InstanceState.context
      const settings = yield* InstanceState.use(state, (s) => s)
      const agentConfig = yield* ConfigPaths.environmentPath(Flag.VECTOR_AGENT_CONFIG, ctx)
      const project = Flag.VECTOR_DISABLE_PROJECT_CONFIG
        ? []
        : yield* ConfigPaths.files("vector", ctx.directory, ctx.worktree).pipe(
            Effect.provideService(FSUtil.Service, fs),
            Effect.provideService(EffectFlock.Service, flock),
            Effect.orDie,
          )
      const files = [
        ...["config.json", "vector.json", "vector.jsonc"].map((file) => path.join(Global.Path.config, file)),
        ...(agentConfig ? [agentConfig.path] : []),
        ...project,
        ...settings.directories
          .filter((dir) => dir.endsWith(".vector") || dir === settings.configDirectory)
          .flatMap((dir) => ["vector.json", "vector.jsonc", ...LOCAL_CONFIG_FILES].map((file) => path.join(dir, file))),
        ...(Flag.VECTOR_DISABLE_PROJECT_CONFIG
          ? []
          : [integrationStore(ctx.worktree === "/" ? ctx.directory : ctx.worktree)]),
        ...ConfigManaged.read().files,
      ]
      const entries = yield* Effect.forEach(files, (file) =>
        readConfigFile(file).pipe(
          Effect.map((text) => {
            const parsed: unknown = text ? parse(text, [], { allowTrailingComma: true }) : undefined
            return isRecord(parsed) && isRecord(parsed.mcp) ? parsed.mcp[name] : undefined
          }),
        ),
      )
      return entries.filter(isRecord).reduce<Record<string, unknown>>((merged, entry) => mergeDeep(merged, entry), {})
    })

    const removeMcpLocal = Effect.fn("Config.removeMcpLocal")(function* (name: string) {
      const ctx = yield* InstanceState.context
      const root = ctx.worktree === "/" ? ctx.directory : ctx.worktree
      // Integrations added before the store existed were written into the project's .vector directory. Each file is
      // written only inside where it belongs, never through a link.
      for (const [file, owner] of [
        [integrationStore(root), path.dirname(integrationStore(root))],
        ...LOCAL_CONFIG_FILES.map((item) => [path.join(root, ".vector", item), root]),
      ]) {
        if (!FSUtil.writableInside(owner, file)) {
          yield* Effect.logWarning("left an integration in a file that is a link or outside the project", { file })
          continue
        }
        const before = yield* readConfigFile(file)
        if (!before) continue
        const edits = modify(before, ["mcp", name], undefined, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        })
        if (!edits.length) continue
        yield* fs.writeFileString(file, applyEdits(before, edits)).pipe(Effect.orDie)
      }
    })

    const updateGlobal = Effect.fn("Config.updateGlobal")(function* (config: Info) {
      yield* importSettings(Global.Path.config)
      const file = globalConfigFile()
      const original = (yield* readConfigFile(file)) ?? "{}"
      const before = ConfigSchema.rewrite(original)
      const patch = Redaction.restore(writableGlobal(config), yield* storedFile(file))

      let next: Info
      let changed: boolean
      if (!file.endsWith(".jsonc")) {
        const existing = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(before, file), file)
        const merged = mergeDeep(writable(existing), patch)
        const serialized = JSON.stringify(merged, null, 2)
        changed = serialized !== original
        if (changed) yield* fs.writeFileString(file, serialized).pipe(Effect.orDie)
        next = merged
      } else {
        const updated = patchJsonc(before, patch)
        next = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(updated, file), file)
        changed = updated !== original
        if (changed) yield* fs.writeFileString(file, updated).pipe(Effect.orDie)
      }

      if (changed) yield* invalidate()
      // A tightening of Vector Local applies now; a loosening one is held for the owner, as an edit by hand would be.
      if (changed) refreshLocal()
      return { info: next, changed }
    })

    return Service.of({
      get,
      getGlobal,
      update,
      updateGlobal,
      updateMcpLocal,
      removeMcpLocal,
      storedMcp,
      invalidate,
      directories,
      waitForDependencies,
      trust,
      trustedPath,
      approve,
      permissionCeiling,
      localPolicy,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Auth.node, Teams.node, Env.node, ConfigDependencies.node, httpClient, EffectFlock.node],
})

export * as Config from "./config"
