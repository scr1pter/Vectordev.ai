export * as TuiConfig from "./tui"

import path from "path"
import { mergeDeep, unique } from "remeda"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Cause, Context, Effect, Fiber, Layer } from "effect"
import { ConfigParse } from "@/config/parse"
import { ConfigPaths } from "@/config/paths"
import { migrateTuiConfig } from "./tui-migrate"
import { resolveHostAttentionSoundPaths } from "./tui-host-attention"
import { Flag } from "@vectordevai/core/flag/flag"
import { isRecord } from "@vectordevai/tui/util/record"
import { Global } from "@vectordevai/core/global"
import { FSUtil } from "@vectordevai/core/fs-util"
import { EffectFlock } from "@vectordevai/core/util/effect-flock"
import { CurrentWorkingDirectory } from "./tui-cwd"
import { ConfigPlugin } from "@/config/plugin"
import { TuiKeybind } from "@vectordevai/tui/config/keybind"
import { InstallationLocal } from "@vectordevai/core/installation/version"
import { makeRuntime } from "@vectordevai/core/effect/runtime"
import { Filesystem } from "@/util/filesystem"
import { ConfigVariable } from "@/config/variable"
import { ConfigDependencies } from "./dependencies"
import { FormatError, FormatUnknownError } from "@/cli/error"
import { TuiConfig } from "@vectordevai/tui/config"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { fileURLToPath, pathToFileURL } from "url"
import os from "os"

export const Info = TuiConfig.Info
export type Info = TuiConfig.Info

type Acc = {
  result: Info
  plugin_origins: ConfigPlugin.Origin[]
}

export type Resolved = TuiConfig.Resolved

export type HostMetadata = {
  plugin_origins?: ConfigPlugin.Origin[]
}

export interface Interface {
  readonly get: () => Effect.Effect<Resolved>
  readonly pluginOrigins: () => Effect.Effect<ConfigPlugin.Origin[]>
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@vector/TuiConfig") {}

function normalize(raw: Record<string, unknown>) {
  const data = { ...raw }
  if (!("tui" in data)) return data
  if (!isRecord(data.tui)) {
    delete data.tui
    return data
  }

  const tui = data.tui
  delete data.tui
  return {
    ...tui,
    ...data,
  }
}

function dropUnknownKeybinds(input: Record<string, unknown>) {
  if (!isRecord(input.keybinds)) return input

  const invalid = TuiKeybind.unknownKeys(input.keybinds)
  if (!invalid.length) return input

  return {
    ...input,
    keybinds: Object.fromEntries(Object.entries(input.keybinds).filter(([key]) => !invalid.includes(key))),
  }
}

function bindTrustedProjectPlugins(config: Info, trusted: WorkspaceTrust.TrustedSnapshot, source: string): Info {
  if (!config.plugin) return config
  return {
    ...config,
    plugin: config.plugin.flatMap((plugin) => {
      const spec = ConfigPlugin.pluginSpecifier(plugin)
      const local =
        spec.startsWith("file://") || spec.startsWith(".") || path.isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)
      if (!local) return [plugin]
      const input = (() => {
        if (!spec.startsWith("file://")) return path.isAbsolute(spec) ? spec : path.resolve(path.dirname(source), spec)
        try {
          return fileURLToPath(spec)
        } catch {
          return undefined
        }
      })()
      if (!input) return []
      const target = WorkspaceTrust.materializedPathOption(trusted, input)
      if (!target) return []
      const mapped = pathToFileURL(target).href
      return [Array.isArray(plugin) ? [mapped, plugin[1]] : mapped]
    }),
  }
}

function bindTrustedFileReferences(text: string, trusted: WorkspaceTrust.TrustedSnapshot, source: string) {
  return text.replace(/\{file:([^}]+)\}/g, (_token, value: string) => {
    const input = value.startsWith("~/")
      ? path.join(os.homedir(), value.slice(2))
      : path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)
        ? value
        : path.resolve(path.dirname(source), value)
    const target = WorkspaceTrust.materializedPathOption(trusted, input)
    return `{file:${target ?? path.join(trusted.directory, ".uncaptured-input")}}`
  })
}

const loadState = Effect.fn("TuiConfig.loadState")(function* (ctx: { directory: string }) {
  const afs = yield* FSUtil.Service
  let appliedOrder = 0

  const git = yield* afs.up({ targets: [".git"], start: ctx.directory })
  const workspace = git[0] ? path.dirname(git[0]) : ctx.directory
  const worktree = git[0] ? workspace : undefined
  const sourceContext = { directory: ctx.directory, worktree: workspace }
  // The same rule as the server: a file or directory an env var names is the user's own only outside the project.
  // Inside it, trust applies, and both capture it so they reach the same trust decision.
  const agentConfig = yield* ConfigPaths.environmentPath(Flag.VECTOR_AGENT_CONFIG, sourceContext)
  const agentDirectory = yield* ConfigPaths.environmentPath(Flag.VECTOR_AGENT_CONFIG_DIR, sourceContext)
  const tuiConfig = yield* ConfigPaths.environmentPath(Flag.VECTOR_TUI_CONFIG, sourceContext)
  // Anything that is not the user's own is the project's, including folders above a non-git workspace.
  const pluginScope = (file: string): ConfigPlugin.Scope => {
    if (ConfigPaths.userOwned(file)) return "global"
    if (ConfigPaths.projectContains(file, sourceContext)) return "local"
    if (agentDirectory && !agentDirectory.project && Filesystem.contains(agentDirectory.path, file)) return "global"
    if (tuiConfig && !tuiConfig.project && tuiConfig.path === file) return "global"
    return "local"
  }
  const allDirectories = (yield* ConfigPaths.directories(ctx.directory, worktree)).map(
    (directory) => ConfigPaths.projectPath(directory, sourceContext) ?? directory,
  )
  yield* Effect.promise(() =>
    migrateTuiConfig({
      directories: allDirectories,
      cwd: ctx.directory,
      workspace,
      worktree,
      agentConfig,
      agentDirectory,
    }),
  )
  const projectFiles = Flag.VECTOR_DISABLE_PROJECT_CONFIG
    ? []
    : yield* ConfigPaths.files("tui", ctx.directory, worktree)
  const projectVectorFiles = Flag.VECTOR_DISABLE_PROJECT_CONFIG
    ? []
    : yield* ConfigPaths.files("vector", ctx.directory, worktree)
  const projectDirectories = allDirectories.filter((directory) => pluginScope(directory) === "local")
  const explicitProjectFiles = [agentConfig, tuiConfig].flatMap((entry) => (entry?.project ? [entry.path] : []))
  const trustSnapshot = yield* Effect.promise(() =>
    WorkspaceTrust.snapshot(workspace, [
      ...projectFiles,
      ...projectVectorFiles,
      ...projectDirectories,
      ...explicitProjectFiles,
    ]).catch((cause) => WorkspaceTrust.unavailableSnapshot(workspace, cause)),
  )
  const snapshotFailure = WorkspaceTrust.unavailableReason(trustSnapshot)
  if (snapshotFailure) {
    yield* Effect.logWarning("disabling project TUI config because workspace trust capture failed", {
      workspace,
      reason: snapshotFailure,
    })
  }
  const trusted =
    !snapshotFailure &&
    !Flag.VECTOR_PURE &&
    (yield* Effect.promise(() => WorkspaceTrust.status(Global.Path.state, trustSnapshot))).trusted
  const trustedSnapshot = trusted
    ? yield* Effect.promise(() => WorkspaceTrust.materialize(Global.Path.state, trustSnapshot))
    : undefined

  const resolvePlugins = (config: Info, configFilepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      const plugins = config.plugin
      if (!plugins) return config
      return {
        ...config,
        plugin: yield* Effect.forEach(plugins, (plugin) =>
          Effect.promise(() => ConfigPlugin.resolvePluginSpec(plugin as ConfigPlugin.Origin["spec"], configFilepath)),
        ),
      }
    })

  const load = (
    text: string,
    configFilepath: string,
    project?: { source: string; trusted?: WorkspaceTrust.TrustedSnapshot },
  ): Effect.Effect<Info> =>
    Effect.gen(function* () {
      // An untrusted project's {env:...} and {file:...} stay as written: reading them is the project's choice, not the
      // user's, and a device or FIFO path could hang the load.
      const expanded =
        project && !project.trusted
          ? text
          : yield* Effect.promise(() =>
              ConfigVariable.substitute({
                text: project?.trusted ? bindTrustedFileReferences(text, project.trusted, project.source) : text,
                type: "path",
                path: configFilepath,
                missing: "empty",
              }),
            )
      const data = ConfigParse.jsonc(expanded, configFilepath)
      if (!isRecord(data)) return {} as Info
      // Flatten a nested "tui" key so users who wrote `{ "tui": { ... } }` inside tui.json
      // (mirroring the old vector.json shape) still get their settings applied.
      const normalized = dropUnknownKeybinds(normalize(data))
      const parsed = ConfigParse.schema(Info, normalized, configFilepath)
      const validated = parsed.attention?.sounds
        ? {
            ...parsed,
            attention: {
              ...parsed.attention,
              sounds: resolveHostAttentionSoundPaths(path.dirname(configFilepath), parsed.attention.sounds),
            },
          }
        : parsed
      const safe = !project
        ? validated
        : project.trusted
          ? bindTrustedProjectPlugins(validated, project.trusted, project.source)
          : { ...validated, plugin: undefined }
      return yield* resolvePlugins(safe, configFilepath)
    }).pipe(
      // catchCause (not tapErrorCause + orElseSucceed) because JSONC parsing and validation
      // can sync-throw — those become defects, which orElseSucceed wouldn't catch.
      Effect.catchCause((cause) =>
        Effect.logWarning("skipping invalid tui config", {
          path: configFilepath,
          reason: FormatError(Cause.squash(cause)) ?? FormatUnknownError(Cause.squash(cause)),
        }).pipe(Effect.as({} as Info)),
      ),
    )

  const loadFile = (filepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      // Silent-swallow non-NotFound read errors (perms, EISDIR, IO) → log + skip.
      // Matches how parse/schema/plugin failures in load() are handled — every
      // broken-config path degrades gracefully rather than crashing TUI startup.
      const text = yield* afs.readFileStringSafe(filepath).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to read tui config", {
            path: filepath,
            reason: FormatError(Cause.squash(cause)) ?? FormatUnknownError(Cause.squash(cause)),
          }).pipe(Effect.as(undefined)),
        ),
      )
      if (!text) return {} as Info
      yield* Effect.logInfo("loading tui config", { path: filepath })
      return yield* load(text, filepath)
    })

  const loadProjectFile = (filepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      const text = WorkspaceTrust.readFileString(trustSnapshot, filepath)
      if (!text) return {} as Info
      yield* Effect.logInfo("loading captured tui config", { path: filepath })
      return yield* load(text, filepath, { source: filepath, trusted: trustedSnapshot })
    })

  const mergeFile = (acc: Acc, file: string) =>
    Effect.gen(function* () {
      const scope = pluginScope(file)
      const loaded = yield* scope === "local" ? loadProjectFile(file) : loadFile(file)
      const data = { ...loaded }
      if (Object.keys(data).length) {
        appliedOrder += 1
        yield* Effect.logInfo("applying tui config", { path: file, order: appliedOrder })
      }
      acc.result = mergeDeep(acc.result, data)
      if (!data.plugin?.length) return

      const plugins = ConfigPlugin.deduplicatePluginOrigins([
        ...acc.plugin_origins,
        ...data.plugin.map((spec) => ({ spec: spec as ConfigPlugin.Origin["spec"], scope, source: file })),
      ])
      acc.result = {
        ...acc.result,
        plugin: plugins.map((item) => item.spec),
      }
      acc.plugin_origins = plugins
    })

  // Every config dir we may read from: global config dir, any `.vector`
  // folders between cwd and home, and VECTOR_AGENT_CONFIG_DIR.
  const directories = allDirectories

  const acc: Acc = {
    result: {},
    plugin_origins: [],
  }

  // 1. Global tui config (lowest precedence).
  for (const file of ConfigPaths.fileInDirectory(Global.Path.config, "tui")) {
    yield* mergeFile(acc, file)
  }

  // 2. Explicit VECTOR_TUI_CONFIG override, if set.
  if (tuiConfig) {
    yield* mergeFile(acc, tuiConfig.path)
    yield* Effect.logDebug("loaded custom tui config", { path: tuiConfig.path })
  }

  // 3. Project tui files, applied root-first so the closest file wins.
  for (const file of projectFiles) {
    yield* mergeFile(acc, file)
  }

  // 4. `.vector` directories (and VECTOR_AGENT_CONFIG_DIR) discovered while
  // walking up the tree.
  const dirs = unique(directories).filter((dir) => dir.endsWith(".vector") || dir === agentDirectory?.path)

  for (const dir of dirs) {
    if (!dir.endsWith(".vector") && dir !== agentDirectory?.path) continue
    for (const file of ConfigPaths.fileInDirectory(dir, "tui")) {
      yield* mergeFile(acc, file)
    }
  }

  const result = TuiConfig.resolve(
    {
      ...acc.result,
    },
    {
      terminalSuspend: process.platform !== "win32",
    },
  )

  return {
    config: result,
    pluginOrigins: acc.plugin_origins,
  }
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const directory = yield* CurrentWorkingDirectory
    const dependencies = yield* ConfigDependencies.Service
    const data = yield* loadState({ directory })
    const deps =
      InstallationLocal || !data.pluginOrigins.length ? [] : [yield* dependencies.prepare().pipe(Effect.forkDetach)]

    const get = Effect.fn("TuiConfig.get")(() => Effect.succeed(data.config))
    const pluginOrigins = Effect.fn("TuiConfig.pluginOrigins")(() => Effect.succeed(data.pluginOrigins))

    const waitForDependencies = Effect.fn("TuiConfig.waitForDependencies")(() =>
      Effect.forEach(deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.ignore(), Effect.asVoid),
    )
    return Service.of({ get, pluginOrigins, waitForDependencies })
  }).pipe(Effect.withSpan("TuiConfig.layer")),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [ConfigDependencies.node, FSUtil.node, EffectFlock.node],
})

const { runPromise } = makeRuntime(Service, AppNodeBuilder.build(node))

export async function waitForDependencies() {
  await runPromise((svc) => svc.waitForDependencies())
}

export async function get() {
  return runPromise((svc) => svc.get())
}

export async function pluginOrigins() {
  return runPromise((svc) => svc.pluginOrigins())
}
