import { ConfigMigration } from "@vectordevai/core/config/migration"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { serviceUse } from "@vectordevai/core/effect/service-use"
import path from "path"
import { createHash } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "url"
import os from "os"
import { mergeDeep } from "remeda"
import { Global } from "@vectordevai/core/global"
import fsNode from "fs/promises"
import { Flag } from "@vectordevai/core/flag/flag"
import { Auth } from "../auth"
import { Teams } from "@vectordevai/core/teams"
import { Env } from "../env"
import { applyEdits, modify, parse } from "jsonc-parser"
import { InstallationLocal } from "@vectordevai/core/installation/version"
import { existsSync } from "fs"
import { isRecord } from "@/util/record"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Redaction } from "@vectordevai/core/redaction"
import { InstanceState } from "@/effect/instance-state"
import { Context, Duration, Effect, Fiber, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { EffectFlock } from "@vectordevai/core/util/effect-flock"
import { containsPath, type InstanceContext } from "../project/instance-context"
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
  if (!path.isAbsolute(value) && !value.includes("/") && !value.includes("\\")) return value
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
  directories: string[]
  deps: Fiber.Fiber<void>[]
  trust: WorkspaceTrust.Snapshot
  trusted: boolean
  ceiling: PermissionCeiling | undefined
}

export type TrustStatus = WorkspaceTrust.Status & {
  /** The project has config or .vector content that is being ignored because it is not trusted. */
  ignored: boolean
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
  readonly waitForDependencies: () => Effect.Effect<void>
  readonly trust: () => Effect.Effect<TrustStatus>
  readonly approve: () => Effect.Effect<void>
  readonly permissionCeiling: () => Effect.Effect<PermissionCeiling | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@vector/Config") {}

export const use = serviceUse(Service)

// Machine-local config layer inside .vector directories. Runtime MCP installs (and their
// tokens/headers) are written here instead of the committable vector.json, so the files
// must stay gitignored.
const LOCAL_CONFIG_FILES = ["vector.local.json", "vector.local.jsonc"]

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

    const importSettings = (directory: string, local = false) =>
      ConfigImport.run(directory, local).pipe(
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
      const parsed = opaqueCredentials
        ? yield* Effect.promise(() =>
            ConfigVariable.substituteUnknown({
              ...parseSource,
              value: ConfigParse.jsonc(text, source),
              env,
              preserve: (keys) =>
                keys[0] === "mcp" ||
                keys[0] === "provider" ||
                keys[0] === "skills" ||
                keys.some((key) => ["headers", "environment", "options", "body"].includes(key)),
            }),
          )
        : ConfigParse.jsonc(
            yield* Effect.promise(() => ConfigVariable.substitute({ ...parseSource, text, env })),
            source,
          )
      const data = ConfigParse.schema(ConfigV1.Info, normalizeLoadedConfig(parsed), source)
      if (!("path" in options)) return data

      yield* Effect.promise(() => resolveLoadedPlugins(data, options.path))
      const updated = ConfigSchema.rewrite(text)
      if (updated !== text && !preserveSource) {
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
        if (!existsSync(file)) {
          yield* fs
            .writeWithDirs(file, JSON.stringify({ $schema: "https://vectordev.ai/config.json" }, null, 2))
            .pipe(Effect.catch(() => Effect.void))
        }
      }

      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "config.json"), env, true))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "vector.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "vector.jsonc"), env))

      return result
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

    const ensureGitignore = Effect.fn("Config.ensureGitignore")(function* (dir: string) {
      const gitignore = path.join(dir, ".gitignore")
      const hasIgnore = yield* fs.existsSafe(gitignore)
      if (!hasIgnore) {
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
        const projectFiles = Flag.VECTOR_DISABLE_PROJECT_CONFIG
          ? []
          : yield* ConfigPaths.files("vector", ctx.directory, ctx.worktree).pipe(Effect.orDie)
        const projectTuiFiles = Flag.VECTOR_DISABLE_PROJECT_CONFIG
          ? []
          : yield* ConfigPaths.files("tui", ctx.directory, ctx.worktree).pipe(Effect.orDie)
        const allDirectories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree)
        const projectDirectories = allDirectories.filter((directory) => containsPath(directory, ctx))
        const localAgentConfig =
          Flag.VECTOR_AGENT_CONFIG && containsPath(Flag.VECTOR_AGENT_CONFIG, ctx) ? [Flag.VECTOR_AGENT_CONFIG] : []
        const prepareProjectFile = Effect.fnUntraced(function* (filepath: string) {
          const text = yield* readConfigFile(filepath)
          if (!text) return
          const normalized = /^\s*[{/]/.test(text) ? text : JSON.stringify(ConfigMigration.parseConfig(text, filepath))
          const updated = ConfigSchema.rewrite(normalized)
          if (updated === normalized) return
          yield* fs.writeFileString(filepath, updated).pipe(Effect.catch(() => Effect.void))
        })
        const trustWorkspace = ctx.worktree === "/" ? ctx.directory : ctx.worktree
        const captureTrustSnapshot = () =>
          WorkspaceTrust.snapshot(trustWorkspace, [
            ...projectFiles,
            ...projectTuiFiles,
            ...projectDirectories,
            ...localAgentConfig,
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
          // Without this the project's agents, commands and default model would vanish with no explanation.
          GlobalBus.emit("event", {
            directory: "global",
            payload: {
              type: TuiEvent.ToastShow.type,
              properties: {
                title: "Project settings ignored",
                message:
                  "Vector is not loading this project's vector.json or .vector settings until you trust it. Trust it from the app, or run `vector trust approve` in the project.",
                variant: "warning",
                duration: 15_000,
              },
            },
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
          return trustedSnapshot ? bindTrustedProjectExecutables(loaded, trustedSnapshot, workspace, filepath) : loaded
        })

        let result: Info = {}
        const authEnv: Record<string, string> = {}

        const pluginScopeForSource = Effect.fnUntraced(function* (source: string) {
          if (source.startsWith("http://") || source.startsWith("https://")) return "global"
          if (source === "VECTOR_CONFIG_CONTENT") return "local"
          if (containsPath(source, ctx)) return "local"
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

        const merge = (source: string, next: Info, kind?: ConfigPlugin.Scope) => {
          const scope = kind ?? (containsPath(source, ctx) ? "local" : "global")
          const projectSource = scope === "local" && source !== "VECTOR_CONFIG_CONTENT"
          const safe = projectSource ? projectExecutableConfig(next, trusted, result) : next
          if (projectSource) projectGrants ||= grantsPermission(safe)
          else
            userPermissions = mergeConfigConcatArrays(userPermissions, {
              permission: safe.permission,
              tools: safe.tools,
              agent: safe.agent,
            })
          result = mergeConfigConcatArrays(result, safe)
          return mergePluginOrigins(source, safe.plugin, scope)
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

        if (Flag.VECTOR_AGENT_CONFIG) {
          const next = containsPath(Flag.VECTOR_AGENT_CONFIG, ctx)
            ? yield* loadProjectFile(Flag.VECTOR_AGENT_CONFIG, authEnv, !trusted)
            : yield* loadFile(Flag.VECTOR_AGENT_CONFIG, authEnv, true)
          yield* merge(Flag.VECTOR_AGENT_CONFIG, next)
          yield* Effect.logDebug("loaded custom config", { path: Flag.VECTOR_AGENT_CONFIG })
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
          .filter((directory) => !containsPath(directory, ctx) || trusted)
          .map((directory) =>
            containsPath(directory, ctx) && trustedSnapshot
              ? WorkspaceTrust.materializedPath(trustedSnapshot, directory)
              : directory,
          )

        if (Flag.VECTOR_AGENT_CONFIG_DIR) {
          yield* Effect.logDebug("loading config from VECTOR_AGENT_CONFIG_DIR", { path: Flag.VECTOR_AGENT_CONFIG_DIR })
        }

        const deps: Fiber.Fiber<void>[] = []

        for (const dir of allDirectories) {
          const local = containsPath(dir, ctx)
          const runtimeDir = local && trustedSnapshot ? WorkspaceTrust.materializedPath(trustedSnapshot, dir) : dir
          if (dir.endsWith(".vector") || dir === Flag.VECTOR_AGENT_CONFIG_DIR) {
            if (dir === Flag.VECTOR_AGENT_CONFIG_DIR) yield* importSettings(dir)
            if (!local || trusted) yield* importSettings(dir, true)
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
            dir === Flag.VECTOR_AGENT_CONFIG_DIR ||
            (yield* fs.isFile(path.join(runtimeDir, "package.json"))) ||
            (yield* Effect.forEach(["plugin", "plugins", "tool", "tools"], (name) =>
              fs.isDir(path.join(runtimeDir, name)),
            )).some(Boolean)
          if (runtimeFiles) yield* ensureGitignore(dir).pipe(Effect.orDie)

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

        const managedDir = ConfigManaged.managedConfigDir()
        if (existsSync(managedDir)) {
          for (const file of ["vector.json", "vector.jsonc"]) {
            const source = path.join(managedDir, file)
            yield* merge(source, yield* loadFile(source), "global")
          }
        }

        // macOS managed preferences (.mobileconfig deployed via MDM) override everything
        const managed = yield* Effect.promise(() => ConfigManaged.readManagedPreferences())
        if (managed) {
          const next = yield* loadConfig(managed.text, {
            dir: path.dirname(managed.source),
            source: managed.source,
          })
          userPermissions = mergeConfigConcatArrays(userPermissions, {
            permission: next.permission,
            tools: next.tools,
            agent: next.agent,
          })
          result = mergeConfigConcatArrays(result, next)
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

        return {
          config: result,
          directories,
          deps,
          trust: trustSnapshot,
          trusted,
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

    const trust = Effect.fn("Config.trust")(function* () {
      return yield* InstanceState.useEffect(state, (s) =>
        Effect.promise(async () => {
          const status = await WorkspaceTrust.status(Global.Path.state, s.trust)
          return {
            ...status,
            ignored: !status.trusted && !Flag.VECTOR_PURE && WorkspaceTrust.hasInputs(s.trust),
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
      const dir = yield* InstanceState.directory
      const file = path.join(dir, "vector.json")
      const existing = yield* loadFile(file)
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
      yield* fs.writeWithDirs(file, applyEdits(before, edits)).pipe(Effect.orDie)
    })

    // The MCP entry as the config files hold it, merged in load order. get() has
    // {env:...} and {file:...} references resolved; writing that back would put the
    // resolved secret into a file in place of its reference.
    const storedMcp = Effect.fn("Config.storedMcp")(function* (name: string) {
      const ctx = yield* InstanceState.context
      const dirs = yield* directories()
      const project = Flag.VECTOR_DISABLE_PROJECT_CONFIG
        ? []
        : yield* ConfigPaths.files("vector", ctx.directory, ctx.worktree).pipe(
            Effect.provideService(FSUtil.Service, fs),
            Effect.provideService(EffectFlock.Service, flock),
            Effect.orDie,
          )
      const files = [
        ...["config.json", "vector.json", "vector.jsonc"].map((file) => path.join(Global.Path.config, file)),
        ...(Flag.VECTOR_AGENT_CONFIG ? [Flag.VECTOR_AGENT_CONFIG] : []),
        ...project,
        ...dirs
          .filter((dir) => dir.endsWith(".vector") || dir === Flag.VECTOR_AGENT_CONFIG_DIR)
          .flatMap((dir) => ["vector.json", "vector.jsonc", ...LOCAL_CONFIG_FILES].map((file) => path.join(dir, file))),
        ...(Flag.VECTOR_DISABLE_PROJECT_CONFIG
          ? []
          : [integrationStore(ctx.worktree === "/" ? ctx.directory : ctx.worktree)]),
        ...["vector.json", "vector.jsonc"].map((file) => path.join(ConfigManaged.managedConfigDir(), file)),
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
      // Integrations added before the store existed were written into the project's .vector directory.
      for (const file of [
        integrationStore(root),
        ...LOCAL_CONFIG_FILES.map((item) => path.join(root, ".vector", item)),
      ]) {
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
      approve,
      permissionCeiling,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Auth.node, Teams.node, Env.node, ConfigDependencies.node, httpClient, EffectFlock.node],
})

export * as Config from "./config"
