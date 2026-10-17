export * as Config from "./config"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { fileURLToPath } from "node:url"
import { type ParseError, parse } from "jsonc-parser"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Permission } from "@vectordevai/schema/permission"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Location } from "./location"
import { Policy } from "./policy"
import { AbsolutePath } from "./schema"
import { ConfigAgent } from "./config/agent"
import { ConfigAttachments } from "./config/attachments"
import { ConfigCompaction } from "./config/compaction"
import { ConfigCommand } from "./config/command"
import { ConfigExperimental } from "./config/experimental"
import { ConfigFormatter } from "./config/formatter"
import { ConfigLSP } from "./config/lsp"
import { ConfigMCP } from "./config/mcp"
import { ConfigPlugin } from "./config/plugin"
import { ConfigProvider } from "./config/provider"
import { ConfigReference } from "./config/reference"
import { ConfigToolOutput } from "./config/tool-output"
import { ConfigWatcher } from "./config/watcher"
import { ConfigV1 } from "./v1/config/config"
import { ConfigMigrateV1 } from "./v1/config/migrate"
import { ConfigMigration } from "./config/migration"
import { Flag } from "./flag/flag"
import { EffectFlock } from "./util/effect-flock"
import { Teams } from "./teams"
import { WorkspaceTrust } from "./workspace-trust/workspace-trust"

export class Info extends Schema.Class<Info>("Config.Info")({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  shell: Schema.String.pipe(Schema.optional).annotate({
    description: "Default shell to use for terminal and shell tool execution",
  }),
  model: Schema.String.pipe(Schema.optional).annotate({
    description: "Default model to use when no session or agent model is selected",
  }),
  default_agent: Schema.String.pipe(Schema.optional).annotate({
    description: "Default primary agent to use when no session agent is selected",
  }),
  autoupdate: Schema.Union([Schema.Boolean, Schema.Literal("notify")])
    .pipe(Schema.optional)
    .annotate({
      description: "Automatically update or notify when a new version is available",
    }),
  share: Schema.Literals(["manual", "auto", "disabled"]).pipe(Schema.optional).annotate({
    description: "Control whether sessions may be shared manually, automatically, or not at all",
  }),
  enterprise: Schema.Struct({
    url: Schema.String.pipe(Schema.optional),
  })
    .pipe(Schema.optional)
    .annotate({
      description: "Enterprise sharing service configuration",
    }),
  username: Schema.String.pipe(Schema.optional).annotate({
    description: "Username displayed in conversations and used for telemetry identity",
  }),
  permissions: Permission.Ruleset.pipe(Schema.optional).annotate({
    description: "Ordered tool permission rules applied to agent tool use",
  }),
  agents: Schema.Record(Schema.String, ConfigAgent.Info).pipe(Schema.optional).annotate({
    description: "Named built-in agent overrides and custom agent definitions",
  }),
  snapshots: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Enable snapshots used for undo and revert behavior",
  }),
  watcher: ConfigWatcher.Info.pipe(Schema.optional).annotate({
    description: "Filesystem watcher configuration",
  }),
  formatter: ConfigFormatter.Info.pipe(Schema.optional).annotate({
    description: "Enable built-in formatters or configure formatter overrides",
  }),
  lsp: ConfigLSP.Info.pipe(Schema.optional).annotate({
    description: "Enable built-in language servers or configure server overrides",
  }),
  attachments: ConfigAttachments.Info.pipe(Schema.optional).annotate({
    description: "Attachment processing configuration",
  }),
  tool_output: ConfigToolOutput.Info.pipe(Schema.optional).annotate({
    description: "Tool output truncation thresholds",
  }),
  mcp: ConfigMCP.Info.pipe(Schema.optional).annotate({
    description: "MCP server configuration",
  }),
  compaction: ConfigCompaction.Info.pipe(Schema.optional).annotate({
    description: "Conversation compaction behavior",
  }),
  skills: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional paths or URLs to discover skills from",
  }),
  commands: Schema.Record(Schema.String, ConfigCommand.Info).pipe(Schema.optional).annotate({
    description: "Named slash command definitions",
  }),
  instructions: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional paths or URLs supplying ambient instructions",
  }),
  references: ConfigReference.Info.pipe(Schema.optional).annotate({
    description: "Named local directories or Git repositories available as external context",
  }),
  plugins: ConfigPlugin.Plugins.pipe(Schema.optional).annotate({
    description: "Ordered external plugin packages to load",
  }),
  experimental: ConfigExperimental.Experimental.pipe(Schema.optional),
  providers: Schema.Record(Schema.String, ConfigProvider.Info).pipe(Schema.optional),
}) {}

export class Document extends Schema.Class<Document>("Config.Document")({
  type: Schema.Literal("document"),
  path: Schema.String.pipe(Schema.optional),
  info: Info,
}) {}

export class Directory extends Schema.Class<Directory>("Config.Directory")({
  type: Schema.Literal("directory"),
  path: AbsolutePath,
}) {}

export type Entry = Document | Directory
export type Scope = "global" | "project"

export function latest<K extends keyof Info>(entries: readonly Entry[], key: K): Info[K] | undefined {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .findLast((entry) => entry.info[key] !== undefined)?.info[key]
}

export interface Interface {
  /** Returns location config documents and supplemental directories from lowest to highest priority. */
  readonly entries: () => Effect.Effect<Entry[]>
  /** Returns where a loaded entry came from. Unknown injected entries are treated as global. */
  readonly scope?: (entry: Entry) => Scope
  /** Project executable entries require an unchanged explicit workspace approval. */
  readonly executable?: (entry: Entry) => boolean
  /** Resolves approved project executable content to its private captured copy. */
  readonly executablePath?: (entry: Entry, input: string) => string
  readonly trust?: () => Effect.Effect<WorkspaceTrust.Status>
  readonly approve?: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@vector/v2/Config") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const policy = yield* Policy.Service
    const teams = yield* Teams.Service
    const scopes = new WeakMap<Entry, Scope>()
    yield* ConfigMigration.discover({
      directory: location.directory,
      worktree: location.project.directory,
      global: global.config,
      home: global.home,
      disableProject: Flag.VECTOR_DISABLE_PROJECT_CONFIG,
    }).pipe(Effect.orDie)
    const names = ["vector.json", "vector.jsonc"]
    const decodeOptions = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
    const decodeInfo = Schema.decodeUnknownOption(Info, decodeOptions)
    const decodeV1Info = Schema.decodeUnknownOption(ConfigV1.Info, decodeOptions)

    const loadFile = Effect.fnUntraced(function* (
      filepath: string,
      snapshot?: WorkspaceTrust.Snapshot,
      trusted?: WorkspaceTrust.TrustedSnapshot,
      workspace?: string,
    ) {
      const text = snapshot ? WorkspaceTrust.readFileString(snapshot, filepath) : yield* fs.readFileStringSafe(filepath)
      if (!text) return

      const errors: ParseError[] = []
      const input: unknown = parse(text, errors, { allowTrailingComma: true })
      if (errors.length) return

      const info = Option.getOrUndefined(
        ConfigMigrateV1.isV1(input)
          ? decodeV1Info(input).pipe(Option.map(ConfigMigrateV1.migrate), Option.flatMap(decodeInfo))
          : decodeInfo(input),
      )
      if (!info) return
      return new Document({
        type: "document",
        path: filepath,
        info: trusted && workspace ? bindTrustedProjectExecutables(info, trusted, filepath, workspace) : info,
      })
    })

    const loadDirectory = Effect.fnUntraced(function* (
      directory: AbsolutePath,
      snapshot?: WorkspaceTrust.Snapshot,
      trusted?: WorkspaceTrust.TrustedSnapshot,
      workspace?: string,
      runtimeDirectory = directory,
    ) {
      return [
        ...(yield* Effect.forEach(names, (file) =>
          loadFile(path.join(directory, file), snapshot, trusted, workspace),
        ).pipe(Effect.map((configs) => configs.filter((config): config is Document => config !== undefined)))),
        new Directory({ type: "directory", path: runtimeDirectory }),
      ]
    })

    const globalDirectory = AbsolutePath.make(global.config)
    const locationIsGlobal = path.resolve(location.directory) === path.resolve(global.config)
    // Read configuration once when this location opens. Later calls reuse these
    // values until the location is reopened.
    const discovered =
      locationIsGlobal || Flag.VECTOR_DISABLE_PROJECT_CONFIG
        ? []
        : yield* fs
            .up({
              targets: [".vector", ...names.toReversed()],
              start: location.directory,
              stop: location.project.directory,
            })
            .pipe(Effect.orDie)
    // VECTOR_AGENT_CONFIG_DIR replaces the global folder, and it can name a folder of the project's under any spelling
    // (as written, through an alias of the workspace, or through a workspace link that points out). Such a folder is
    // the project's: it loads under project trust after the project's own .vector folders, and nothing loads as global
    // in its place. The user's own config folders stay global, as does the folder a location opened on itself.
    const fromEnvironment =
      Flag.VECTOR_AGENT_CONFIG_DIR !== undefined &&
      path.resolve(Flag.VECTOR_AGENT_CONFIG_DIR) === path.resolve(global.config)
    const projectGlobal =
      !fromEnvironment ||
      locationIsGlobal ||
      [Global.Path.config, path.join(global.home, ".vector")].some((root) => FSUtil.contains(root, global.config))
        ? undefined
        : projectSpelling(
            location.project.directory === path.parse(location.project.directory).root
              ? [location.directory]
              : [location.directory, location.project.directory],
            global.config,
          )
    const projectDirectories = Array.from(
      new Set([
        ...discovered.filter((item) => path.basename(item) === ".vector").toReversed(),
        // A folder that does not exist holds nothing, and has nothing for trust to capture.
        ...(projectGlobal && (yield* fs.isDir(projectGlobal)) ? [projectGlobal] : []),
      ]),
    ).map((directory) => AbsolutePath.make(directory))
    // A config closer to the opened directory should win over one higher up.
    // Search starts nearby, so reverse the results before applying them.
    const directPaths = discovered.filter((item) => path.basename(item) !== ".vector").toReversed()
    const tuiPaths =
      locationIsGlobal || Flag.VECTOR_DISABLE_PROJECT_CONFIG
        ? []
        : yield* fs
            .up({
              targets: ["tui.jsonc", "tui.json"],
              start: location.directory,
              stop: location.project.directory,
            })
            .pipe(Effect.orDie)
    const workspace =
      location.project.directory === path.parse(location.project.directory).root
        ? location.directory
        : location.project.directory
    const trustSnapshot = yield* Effect.promise(() =>
      WorkspaceTrust.snapshot(workspace, [...directPaths, ...tuiPaths, ...projectDirectories]).catch((cause) =>
        WorkspaceTrust.unavailableSnapshot(workspace, cause),
      ),
    )
    const snapshotFailure = WorkspaceTrust.unavailableReason(trustSnapshot)
    if (snapshotFailure) {
      yield* Effect.logWarning("disabling project config because workspace trust capture failed", {
        workspace,
        reason: snapshotFailure,
      })
    }
    const trustStatus = yield* Effect.promise(() => WorkspaceTrust.status(global.state, trustSnapshot))
    const trustedSnapshot =
      !snapshotFailure && !Flag.VECTOR_PURE && trustStatus.trusted
        ? yield* Effect.promise(() => WorkspaceTrust.materialize(global.state, trustSnapshot))
        : undefined
    const direct = yield* Effect.forEach(directPaths, (file) =>
      loadFile(file, trustSnapshot, trustedSnapshot, workspace),
    ).pipe(
      Effect.orDie,
      Effect.map((configs) => configs.filter((config): config is Document => config !== undefined)),
    )
    const supplementary = [
      projectGlobal ? [] : yield* loadDirectory(globalDirectory).pipe(Effect.orDie),
      ...(yield* Effect.forEach(projectDirectories, (directory) =>
        loadDirectory(
          directory,
          trustSnapshot,
          trustedSnapshot,
          workspace,
          trustedSnapshot ? AbsolutePath.make(WorkspaceTrust.materializedPath(trustedSnapshot, directory)) : directory,
        ),
      ).pipe(Effect.orDie)),
    ]
    for (const entry of supplementary[0] ?? []) scopes.set(entry, "global")
    for (const entry of direct) scopes.set(entry, "project")
    for (const group of supplementary.slice(1)) for (const entry of group) scopes.set(entry, "project")

    const executable = (entry: Entry) => scopes.get(entry) !== "project" || trustedSnapshot !== undefined
    const executablePath = (entry: Entry, input: string) =>
      scopes.get(entry) === "project" && trustedSnapshot
        ? WorkspaceTrust.materializedPath(trustedSnapshot, input)
        : input
    // Apply general settings first and more specific settings last:
    // global config, project files, then `.vector` files.
    const team = yield* teams.current().pipe(Effect.orDie)
    const teamInfo = team.active
      ? Option.getOrUndefined(
          ConfigMigrateV1.isV1(team.active.config)
            ? decodeV1Info(team.active.config).pipe(Option.map(ConfigMigrateV1.migrate), Option.flatMap(decodeInfo))
            : decodeInfo(team.active.config),
        )
      : undefined
    if (team.active && !teamInfo)
      return yield* Effect.die(
        new Error(
          "The selected team's configuration is invalid. Ask its administrator to update it before continuing.",
        ),
      )
    // Team defaults have the same precedence as customer-hosted configuration:
    // personal and project settings remain authoritative on this machine.
    const localConfigs = [...(supplementary[0] ?? []), ...direct, ...supplementary.slice(1).flat()]
    const teamConfig = teamInfo ? new Document({ type: "document", info: teamInfo }) : undefined
    if (teamConfig) scopes.set(teamConfig, "global")
    const configs = [...(teamConfig ? [teamConfig] : []), ...localConfigs]
    // Rules use the opposite order so a user-global rule can override a
    // repository rule. Statement order inside each file stays unchanged.
    yield* policy.load([
      ...(teamInfo?.experimental?.policies ?? []),
      ...localConfigs
        .filter((config): config is Document => config.type === "document")
        .toReversed()
        .flatMap((config) => {
          const statements = config.info.experimental?.policies ?? []
          if (scopes.get(config) !== "project" || trustStatus.trusted) return statements
          return statements.filter((statement) => statement.effect === "deny")
        }),
    ])

    return Service.of({
      entries: Effect.fn("Config.entries")(function* () {
        return configs
      }),
      scope: (entry) => scopes.get(entry) ?? "global",
      executable,
      executablePath,
      trust: Effect.fn("Config.trust")(function* () {
        return yield* Effect.promise(() => WorkspaceTrust.status(global.state, trustSnapshot))
      }),
      approve: Effect.fn("Config.approve")(function* () {
        yield* Effect.promise(() => WorkspaceTrust.approve(global.state, trustSnapshot))
      }),
    })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(Policy.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, Location.node, Policy.node, EffectFlock.node, Teams.node],
})

// The project's spelling of a folder that passes through it, or undefined. One that cannot be resolved is held back
// as the project's.
function projectSpelling(roots: string[], directory: string) {
  try {
    return FSUtil.within(roots, directory)
  } catch {
    return directory
  }
}

function bindTrustedProjectExecutables(
  info: Info,
  trusted: WorkspaceTrust.TrustedSnapshot,
  source: string,
  workspace: string,
) {
  const shell = info.shell ? trustedExecutableValue(info.shell, path.dirname(source), trusted) : undefined
  const formatter =
    info.formatter && typeof info.formatter === "object"
      ? rewriteCommandEntries(
          info.formatter,
          workspace,
          trusted,
          (entry, command) =>
            new ConfigFormatter.Entry({
              ...entry,
              ...(command ? { command: command.command, cwd: command.cwd } : {}),
            }),
        )
      : info.formatter
  const lsp =
    info.lsp && typeof info.lsp === "object"
      ? rewriteCommandEntries(
          info.lsp,
          workspace,
          trusted,
          (entry, command) =>
            command ? new ConfigLSP.Server({ ...entry, command: command.command, cwd: command.cwd }) : entry,
        )
      : info.lsp
  const mcp = info.mcp
    ? new ConfigMCP.Info({
        ...info.mcp,
        servers: info.mcp.servers
          ? Object.fromEntries(
              Object.entries(info.mcp.servers)
                .map(([name, server]): [string, ConfigMCP.Local | ConfigMCP.Remote | undefined] => {
                  if (server.type !== "local") return [name, server]
                  const cwd = server.cwd ? path.resolve(workspace, server.cwd) : workspace
                  const command = WorkspaceTrust.materializedCommand(trusted, server.command, cwd, server.environment)
                  if (!command) return [name, undefined]
                  return [
                    name,
                    new ConfigMCP.Local({
                      ...server,
                      command: command.command,
                      cwd: command.cwd,
                    }),
                  ]
                })
                .filter((entry): entry is [string, ConfigMCP.Local | ConfigMCP.Remote] => entry[1] !== undefined),
            )
          : undefined,
      })
    : undefined
  return new Info({ ...info, shell, formatter, lsp, mcp })
}

function rewriteCommandEntries<T extends Record<string, object>>(
  value: T,
  base: string,
  trusted: WorkspaceTrust.TrustedSnapshot,
  bind: (entry: Record<string, unknown>, command?: { command: string[]; cwd: string }) => object,
): T {
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, entry]) => {
      if (!entry || typeof entry !== "object") return [[name, entry]]
      // An entry without a command overrides a built-in formatter, which still launches with this environment, so a
      // PATH or preload variable would run live, unapproved programs just as a project command would.
      const environment = "environment" in entry ? entry.environment : "env" in entry ? entry.env : undefined
      const projectEnvironment = stringEnvironment(environment)
      if (
        environment !== undefined &&
        (!projectEnvironment || WorkspaceTrust.unsafeProjectEnvironment(projectEnvironment))
      )
        return []
      if (!("command" in entry) || !Array.isArray(entry.command)) {
        if (!("cwd" in entry) || typeof entry.cwd !== "string") return [[name, entry]]
        const cwd = WorkspaceTrust.materializedPathOption(trusted, path.resolve(base, entry.cwd))
        if (!cwd) return []
        return [[name, bind({ ...entry, cwd })]]
      }
      if (!entry.command.every((item): item is string => typeof item === "string")) return []
      const cwd = "cwd" in entry && typeof entry.cwd === "string" ? path.resolve(base, entry.cwd) : base
      const command = WorkspaceTrust.materializedCommand(trusted, entry.command, cwd, projectEnvironment)
      if (!command) return []
      return [[name, bind(entry as Record<string, unknown>, command)]]
    }),
  ) as T
}

function stringEnvironment(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const entries = Object.entries(value)
  if (entries.some(([, item]) => typeof item !== "string")) return
  return Object.fromEntries(entries) as Record<string, string>
}

function trustedExecutableValue(value: unknown, base: string, trusted: WorkspaceTrust.TrustedSnapshot) {
  if (typeof value !== "string") return
  if (value.startsWith("file:")) return WorkspaceTrust.materializedPathOption(trusted, fileURLToPath(value))
  if (/^[A-Za-z]:/.test(value) || value.startsWith("\\\\")) {
    return WorkspaceTrust.materializedPathOption(trusted, value)
  }
  if (URL.canParse(value)) return value
  if (!path.isAbsolute(value) && !value.includes("/") && !value.includes("\\"))
    return WorkspaceTrust.hostExecutable(trusted, value)
  return WorkspaceTrust.materializedPathOption(trusted, path.resolve(base, value))
}
