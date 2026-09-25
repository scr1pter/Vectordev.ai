import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { WebSearchTool } from "@vectordevai/core/tool/websearch"
import { Effect, Layer } from "effect"
import { Auth } from "@/auth"
import { makeLocationNode } from "@vectordevai/core/effect/app-node"

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

export function build<A, E>(root: LayerNode.Node<A, E, any>, replacements: LayerNode.Replacements = []) {
  return AppNodeBuilder.build(
    root,
    replacements.concat([bootstrapReplacement, [WebSearchTool.credentialsNode, searchCredentials]]),
  )
}

export * as AppNodeBuilderV1 from "./app-node-builder-v1"
