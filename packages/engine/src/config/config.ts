import { ConfigMigration } from "@vectordevai/core/config/migration"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { serviceUse } from "@vectordevai/core/effect/service-use"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import { mergeDeep } from "remeda"
import { Global } from "@vectordevai/core/global"
import fsNode from "fs/promises"
import { Flag } from "@vectordevai/core/flag/flag"
import { Auth } from "../auth"
import { Teams } from "@vectordevai/core/teams"
import { Env } from "../env"
import { applyEdits, modify } from "jsonc-parser"
import { InstallationLocal } from "@vectordevai/core/installation/version"
import { existsSync } from "fs"
import { isRecord } from "@/util/record"
import { FSUtil } from "@vectordevai/core/fs-util"
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
import { ConfigPlugin } from "./plugin"
import { ConfigDependencies } from "./dependencies"
import { ConfigVariable } from "./variable"
import { withTransientReadRetry } from "@/util/effect-http-client"

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
}

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly update: (config: Info) => Effect.Effect<void>
  readonly updateGlobal: (config: Info) => Effect.Effect<{ info: Info; changed: boolean }>
  readonly updateMcpLocal: (name: string, entry: ConfigMCPV1.Info | { enabled: boolean }) => Effect.Effect<void>
  readonly removeMcpLocal: (name: string) => Effect.Effect<void>
  readonly invalidate: () => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@vector/Config") {}

export const use = serviceUse(Service)

// Machine-local config layer inside .vector directories. Runtime MCP installs (and their
// tokens/headers) are written here instead of the committable vector.json, so the files
// must stay gitignored.
const LOCAL_CONFIG_FILES = ["vector.local.json", "vector.local.jsonc"]

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
    ) {
      const source = "path" in options ? options.path : options.source
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute(
          "path" in options
            ? { text, type: "path", path: options.path, env }
            : { text, type: "virtual", ...options, env },
        ),
      )
      const parsed = ConfigParse.jsonc(expanded, source)
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
    ) {
      yield* Effect.logInfo("loading", { path: filepath })
      const text = yield* readConfigFile(filepath)
      if (!text) return {} as Info
      const normalized = /^\s*[{/]/.test(text) ? text : JSON.stringify(ConfigMigration.parseConfig(text, filepath))
      return yield* loadConfig(normalized, { path: filepath }, env, preserveSource)
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
      return yield* cachedGlobal
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

        const merge = (source: string, next: Info, kind?: ConfigPlugin.Scope) => {
          result = mergeConfigConcatArrays(result, next)
          return mergePluginOrigins(source, next.plugin, kind)
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
          yield* merge(Flag.VECTOR_AGENT_CONFIG, yield* loadFile(Flag.VECTOR_AGENT_CONFIG, authEnv, true))
          yield* Effect.logDebug("loaded custom config", { path: Flag.VECTOR_AGENT_CONFIG })
        }

        if (!Flag.VECTOR_DISABLE_PROJECT_CONFIG) {
          for (const file of yield* ConfigPaths.files("vector", ctx.directory, ctx.worktree).pipe(Effect.orDie)) {
            yield* merge(file, yield* loadFile(file, authEnv), "local")
          }
        }

        result.agent = result.agent || {}
        result.mode = result.mode || {}
        result.plugin = result.plugin || []

        const directories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree)

        if (Flag.VECTOR_AGENT_CONFIG_DIR) {
          yield* Effect.logDebug("loading config from VECTOR_AGENT_CONFIG_DIR", { path: Flag.VECTOR_AGENT_CONFIG_DIR })
        }

        const deps: Fiber.Fiber<void>[] = []

        for (const dir of directories) {
          if (dir.endsWith(".vector") || dir === Flag.VECTOR_AGENT_CONFIG_DIR) {
            if (dir === Flag.VECTOR_AGENT_CONFIG_DIR) yield* importSettings(dir)
            yield* importSettings(dir, true)
            // Local files merge after the shared ones so machine-local settings win.
            for (const file of ["vector.json", "vector.jsonc", ...LOCAL_CONFIG_FILES]) {
              const source = path.join(dir, file)
              yield* Effect.logDebug(`loading config from ${source}`)
              yield* merge(source, yield* loadFile(source, authEnv))
              result.agent ??= {}
              result.mode ??= {}
              result.plugin ??= []
            }
          }

          // The desktop also owns .vector directories containing repository state and rules.
          const runtimeFiles =
            dir === Global.Path.config ||
            dir === Flag.VECTOR_AGENT_CONFIG_DIR ||
            (yield* fs.isFile(path.join(dir, "package.json"))) ||
            (yield* Effect.forEach(["plugin", "plugins", "tool", "tools"], (name) =>
              fs.isDir(path.join(dir, name)),
            )).some(Boolean)
          if (runtimeFiles) yield* ensureGitignore(dir).pipe(Effect.orDie)

          result.command = mergeDeep(result.command ?? {}, yield* Effect.promise(() => ConfigCommand.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.loadMode(dir)))
          // Auto-discovered plugins under `.vector/plugin(s)` are already local files, so ConfigPlugin.load
          // returns normalized Specs and we only need to attach origin metadata here.
          const list = yield* Effect.promise(() => ConfigPlugin.load(dir))
          yield* mergePluginOrigins(dir, list)
        }

        if (Flag.VECTOR_CONFIG_CONTENT) {
          const source = "VECTOR_CONFIG_CONTENT"
          const next = yield* loadConfig(Flag.VECTOR_CONFIG_CONTENT, {
            dir: ctx.directory,
            source,
          })
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
          result = mergeConfigConcatArrays(
            result,
            yield* loadConfig(managed.text, {
              dir: path.dirname(managed.source),
              source: managed.source,
            }),
          )
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
            result.permission = mergeDeep(result.permission ?? {}, JSON.parse(Flag.VECTOR_PERMISSION))
          } catch (err) {
            yield* Effect.logWarning("VECTOR_PERMISSION contains invalid JSON, skipping", { err })
          }
        }

        if (result.tools) {
          const perms: Record<string, ConfigPermissionV1.Action> = {}
          for (const [tool, enabled] of Object.entries(result.tools)) {
            const action: ConfigPermissionV1.Action = enabled ? "allow" : "deny"
            if (tool === "write" || tool === "edit" || tool === "patch") {
              perms.edit = action
              continue
            }
            perms[tool] = action
          }
          result.permission = mergeDeep(perms, result.permission ?? {})
        }

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

    const update = Effect.fn("Config.update")(function* (config: Info) {
      const dir = yield* InstanceState.directory
      const file = path.join(dir, "vector.json")
      const existing = yield* loadFile(file)
      yield* fs
        .writeFileString(file, JSON.stringify(mergeDeep(writable(existing), writable(config)), null, 2))
        .pipe(Effect.orDie)
    })

    const invalidate = Effect.fn("Config.invalidate")(function* () {
      yield* invalidateGlobal
    })

    // Persists a runtime MCP mutation into the project's machine-local config layer so it
    // survives a backend restart. A full entry replaces the server's config wholesale (a
    // deep patch could leave e.g. a stale `command` behind a type switch to "remote");
    // an { enabled } entry only flips the flag, layering over configs defined elsewhere.
    const updateMcpLocal = Effect.fn("Config.updateMcpLocal")(function* (
      name: string,
      entry: ConfigMCPV1.Info | { enabled: boolean },
    ) {
      const ctx = yield* InstanceState.context
      // Non-git projects have worktree "/", which is not a usable project root.
      const root = ctx.worktree === "/" ? ctx.directory : ctx.worktree
      const dir = path.join(root, ".vector")
      const jsonc = path.join(dir, "vector.local.jsonc")
      const file = (yield* fs.existsSafe(jsonc)) ? jsonc : path.join(dir, "vector.local.json")
      const before =
        (yield* readConfigFile(file)) ?? JSON.stringify({ $schema: "https://vectordev.ai/config.json" }, null, 2)
      const edits = modify(
        before,
        "type" in entry ? ["mcp", name] : ["mcp", name, "enabled"],
        "type" in entry ? entry : entry.enabled,
        { formattingOptions: { insertSpaces: true, tabSize: 2 } },
      )
      yield* fs.writeWithDirs(file, applyEdits(before, edits)).pipe(Effect.orDie)
      yield* ensureGitignore(dir).pipe(Effect.orDie)
      // The generated .gitignore covers the local files, but a .gitignore that predates
      // this layer may not; the file can hold tokens, so append the entries when missing.
      const gitignore = path.join(dir, ".gitignore")
      const existing = (yield* fs.readFileStringSafe(gitignore).pipe(Effect.orDie)) ?? ""
      const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()))
      const missing = LOCAL_CONFIG_FILES.filter((item) => !present.has(item))
      if (missing.length) {
        yield* fs
          .writeFileString(gitignore, [existing.replace(/\n$/, ""), ...missing].filter(Boolean).join("\n") + "\n")
          .pipe(Effect.orDie)
      }
    })

    const removeMcpLocal = Effect.fn("Config.removeMcpLocal")(function* (name: string) {
      const ctx = yield* InstanceState.context
      const root = ctx.worktree === "/" ? ctx.directory : ctx.worktree
      for (const dir of [path.join(root, ".vector")]) {
        for (const nameOfFile of LOCAL_CONFIG_FILES) {
          const file = path.join(dir, nameOfFile)
          const before = yield* readConfigFile(file)
          if (!before) continue
          const edits = modify(before, ["mcp", name], undefined, {
            formattingOptions: { insertSpaces: true, tabSize: 2 },
          })
          if (!edits.length) continue
          yield* fs.writeFileString(file, applyEdits(before, edits)).pipe(Effect.orDie)
        }
      }
    })

    const updateGlobal = Effect.fn("Config.updateGlobal")(function* (config: Info) {
      yield* importSettings(Global.Path.config)
      const file = globalConfigFile()
      const original = (yield* readConfigFile(file)) ?? "{}"
      const before = ConfigSchema.rewrite(original)
      const patch = writableGlobal(config)

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
      invalidate,
      directories,
      waitForDependencies,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Auth.node, Teams.node, Env.node, ConfigDependencies.node, httpClient, EffectFlock.node],
})

export * as Config from "./config"
