import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { FreeModels } from "@vectordevai/core/free-models"
import { VectorAccount } from "@vectordevai/core/vector-account"
import { WebSearchTool } from "@vectordevai/core/tool/websearch"
import { Effect, Layer } from "effect"
import { Auth } from "@/auth"
import { Teams } from "@vectordevai/core/teams"
import { VectorTeams } from "@/teams"
import { makeGlobalNode, makeLocationNode } from "@vectordevai/core/effect/app-node"

const bootstrapReplacement = [InstanceStore.bootstrapNode, InstanceBootstrap.node] as const
const searchCredentials = makeLocationNode({
  service: WebSearchTool.CredentialsService,
  layer: Layer.effect(
    WebSearchTool.CredentialsService,
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      return WebSearchTool.CredentialsService.of({
        get: (provider) =>
          auth.get(provider).pipe(
            Effect.map((value) => (value?.type === "api" ? value.key : undefined)),
            Effect.orDie,
          ),
      })
    }),
  ),
  deps: [Auth.node],
})

const freeModelCredentials = makeGlobalNode({
  service: FreeModels.CredentialsService,
  layer: Layer.effect(
    FreeModels.CredentialsService,
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      return FreeModels.CredentialsService.of({
        get: Effect.fn("FreeModels.legacyCredential")(function* (provider) {
          const environment = process.env[provider === "vector" ? "VECTOR_CLI_TOKEN" : "OPENROUTER_API_KEY"]
          if (environment) return environment
          const stored = yield* auth.get(provider).pipe(Effect.orDie)
          if (stored?.type === "api") return stored.key
          if (provider === "vector") return yield* Effect.promise(() => VectorAccount.readVectorToken())
          return undefined
        }),
      })
    }),
  ),
  deps: [Auth.node],
})

export function build<A, E>(root: LayerNode.Node<A, E, any>, replacements: LayerNode.Replacements = []) {
  return AppNodeBuilder.build(
    root,
    replacements.concat([
      bootstrapReplacement,
      [WebSearchTool.credentialsNode, searchCredentials],
      [FreeModels.credentialsNode, freeModelCredentials],
      [Teams.node, VectorTeams.node],
    ]),
  )
}

export * as AppNodeBuilderV1 from "./app-node-builder-v1"
