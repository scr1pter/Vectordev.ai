export * as PluginInternal from "./internal"

import { makeLocationNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import type { PluginContext } from "@vectordevai/plugin/v2/effect"
import { Effect, Layer, Scope } from "effect"
import { AgentV2 } from "../agent"
import { Catalog } from "../catalog"
import { CommandV2 } from "../command"
import { Config } from "../config"
import { ConfigAgentPlugin } from "../config/plugin/agent"
import { ConfigCommandPlugin } from "../config/plugin/command"
import { ConfigExternalPlugin } from "../config/plugin/external"
import { ConfigProviderPlugin } from "../config/plugin/provider"
import { ConfigReferencePlugin } from "../config/plugin/reference"
import { ConfigSkillPlugin } from "../config/plugin/skill"
import { EventV2 } from "../event"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { FreeModels } from "../free-models"
import { Global } from "../global"
import { Integration } from "../integration"
import { Location } from "../location"
import { ModelCatalog } from "../model-catalog"
import { Npm } from "../npm"
import { PluginV2 } from "../plugin"
import { Reference } from "../reference"
import { SkillV2 } from "../skill"
import { State } from "../state"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { AgentPlugin } from "./agent"
import { CommandPlugin } from "./command"
import { ModelCatalogPlugin } from "./model-catalog"
import { ProviderPlugins } from "./provider"
import { SkillPlugin } from "./skill"
import { VariantPlugin } from "./variant"

export type Requirements =
  | AgentV2.Service
  | Catalog.Service
  | CommandV2.Service
  | Config.Service
  | EventV2.Service
  | FileSystem.Service
  | FSUtil.Service
  | FreeModels.Service
  | FreeModels.CredentialsService
  | Global.Service
  | HttpClient.HttpClient
  | Integration.Service
  | Location.Service
  | ModelCatalog.Service
  | Npm.Service
  | Reference.Service
  | SkillV2.Service

export interface Plugin<R = never> {
  readonly id: string
  readonly effect: (context: PluginContext) => Effect.Effect<void, never, R | Scope.Scope>
}

export function define<R>(plugin: Plugin<R>) {
  return plugin
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const commands = yield* CommandV2.Service
    const plugin = yield* PluginV2.Service
    const integration = yield* Integration.Service
    const agents = yield* AgentV2.Service
    const config = yield* Config.Service
    const location = yield* Location.Service
    const modelCatalog = yield* ModelCatalog.Service
    const npm = yield* Npm.Service
    const events = yield* EventV2.Service
    const fs = yield* FSUtil.Service
    const filesystem = yield* FileSystem.Service
    const freeModels = yield* FreeModels.Service
    const freeCredentials = yield* FreeModels.CredentialsService
    const global = yield* Global.Service
    const http = yield* HttpClient.HttpClient
    const skill = yield* SkillV2.Service
    const reference = yield* Reference.Service
    const add = <R>(input: Plugin<R>) => {
      const loaded = {
        id: input.id,
        effect: (context: PluginContext) =>
          input
            .effect(context)
            .pipe(
              Effect.provideService(Catalog.Service, catalog),
              Effect.provideService(CommandV2.Service, commands),
              Effect.provideService(Integration.Service, integration),
              Effect.provideService(AgentV2.Service, agents),
              Effect.provideService(Config.Service, config),
              Effect.provideService(Location.Service, location),
              Effect.provideService(ModelCatalog.Service, modelCatalog),
              Effect.provideService(Npm.Service, npm),
              Effect.provideService(EventV2.Service, events),
              Effect.provideService(FSUtil.Service, fs),
              Effect.provideService(FileSystem.Service, filesystem),
              Effect.provideService(Global.Service, global),
              Effect.provideService(FreeModels.Service, freeModels),
              Effect.provideService(FreeModels.CredentialsService, freeCredentials),
              Effect.provideService(HttpClient.HttpClient, http),
              Effect.provideService(SkillV2.Service, skill),
              Effect.provideService(Reference.Service, reference),
            ),
      }
      return plugin.add(PluginV2.ID.make(loaded.id), loaded.effect)
    }

    yield* State.batch(
      Effect.gen(function* () {
        yield* add(ConfigReferencePlugin.Plugin)
        yield* add(AgentPlugin.Plugin)
        yield* add(CommandPlugin.Plugin)
        yield* add(SkillPlugin.Plugin)
        yield* add(ModelCatalogPlugin)
        yield* add(ConfigAgentPlugin.Plugin)
        yield* add(ConfigCommandPlugin.Plugin)
        yield* add(ConfigSkillPlugin.Plugin)
        for (const item of ProviderPlugins) yield* add(item)
        yield* add(ConfigExternalPlugin.Plugin)
        yield* add(ConfigProviderPlugin.Plugin)
        yield* add(VariantPlugin.Plugin)
      }),
    ).pipe(Effect.withSpan("PluginInternal.boot"), Effect.forkScoped({ startImmediately: true }))
  }),
)

export const locationLayer = layer.pipe(
  Layer.provideMerge(Config.locationLayer),
  Layer.provideMerge(FetchHttpClient.layer),
)

export const node = makeLocationNode({
  name: "plugin-internal",
  layer,
  deps: [
    Catalog.node,
    CommandV2.node,
    PluginV2.node,
    Integration.node,
    AgentV2.node,
    Config.node,
    Location.node,
    ModelCatalog.node,
    Npm.node,
    EventV2.node,
    FSUtil.node,
    FileSystem.node,
    Global.node,
    FreeModels.node,
    FreeModels.credentialsNode,
    httpClient,
    SkillV2.node,
    Reference.node,
  ],
})
