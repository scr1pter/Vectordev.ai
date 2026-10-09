import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
const positiveInteger = (name: string) =>
  Config.number(name).pipe(
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = bool("VECTOR_EXPERIMENTAL")
const enabledByExperimental = (name: string) =>
  Config.all({ experimental, enabled: Config.boolean(name).pipe(Config.option) }).pipe(
    Config.map((flags) => Option.getOrElse(flags.enabled, () => flags.experimental)),
  )

export class Service extends ConfigService.Service<Service>()("@vector/RuntimeFlags", {
  pure: bool("VECTOR_PURE"),
  disableDefaultPlugins: bool("VECTOR_DISABLE_DEFAULT_PLUGINS"),
  disableEmbeddedWebUi: bool("VECTOR_DISABLE_EMBEDDED_WEB_UI"),
  disableExternalSkills: bool("VECTOR_DISABLE_EXTERNAL_SKILLS"),
  disableLspDownload: bool("VECTOR_DISABLE_LSP_DOWNLOAD"),
  disableClaudeCodePrompt: Config.all({
    broad: bool("VECTOR_DISABLE_CLAUDE_CODE"),
    direct: bool("VECTOR_DISABLE_CLAUDE_CODE_PROMPT"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  disableClaudeCodeSkills: Config.all({
    broad: bool("VECTOR_DISABLE_CLAUDE_CODE"),
    direct: bool("VECTOR_DISABLE_CLAUDE_CODE_SKILLS"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  enableExa: Config.all({
    experimental,
    enabled: bool("VECTOR_ENABLE_EXA"),
    legacy: bool("VECTOR_EXPERIMENTAL_EXA"),
  }).pipe(Config.map((flags) => flags.experimental || flags.enabled || flags.legacy)),
  enableParallel: Config.all({
    enabled: bool("VECTOR_ENABLE_PARALLEL"),
    legacy: bool("VECTOR_EXPERIMENTAL_PARALLEL"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableExperimentalModels: bool("VECTOR_ENABLE_EXPERIMENTAL_MODELS"),
  enableQuestionTool: bool("VECTOR_ENABLE_QUESTION_TOOL"),
  experimentalReferences: enabledByExperimental("VECTOR_EXPERIMENTAL_REFERENCES"),
  experimentalBackgroundSubagents: enabledByExperimental("VECTOR_EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  experimentalLspTy: bool("VECTOR_EXPERIMENTAL_LSP_TY"),
  experimentalLspTool: enabledByExperimental("VECTOR_EXPERIMENTAL_LSP_TOOL"),
  experimentalOxfmt: enabledByExperimental("VECTOR_EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("VECTOR_EXPERIMENTAL_PLAN_MODE"),
  experimentalEventSystem: enabledByExperimental("VECTOR_EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalWorkspaces: enabledByExperimental("VECTOR_EXPERIMENTAL_WORKSPACES"),
  experimentalIconDiscovery: enabledByExperimental("VECTOR_EXPERIMENTAL_ICON_DISCOVERY"),
  outputTokenMax: positiveInteger("VECTOR_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("VECTOR_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  runBackgroundWaitMs: positiveInteger("VECTOR_RUN_BACKGROUND_WAIT_MS"),
  experimentalNativeLlm: bool("VECTOR_EXPERIMENTAL_NATIVE_LLM"),
  experimentalWebSockets: bool("VECTOR_EXPERIMENTAL_WEBSOCKETS"),
  client: Config.string("VECTOR_CLIENT").pipe(Config.withDefault("cli")),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.layer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const node = LayerNode.make({ service: Service, layer: Service.layer.pipe(Layer.orDie), deps: [] })

export * as RuntimeFlags from "./runtime-flags"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
