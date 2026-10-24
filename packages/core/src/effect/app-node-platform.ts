import { NodeFileSystem, NodePath } from "./platform-node"
import { LLMClient, RequestExecutor } from "@vectordevai/llm/route"
import { Effect, FileSystem, Layer, Path } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { HttpClient } from "effect/unstable/http"
import { EgressHttpClient } from "../local-mode/http-client"
import { LocalProbe } from "../local-mode/probe"
import { makeGlobalNode } from "./app-node"

export const filesystem = makeGlobalNode({ service: FileSystem.FileSystem, layer: NodeFileSystem.layer, deps: [] })
export const path = makeGlobalNode({ service: Path.Path, layer: NodePath.layer, deps: [] })
export const httpClient = makeGlobalNode({ service: HttpClient.HttpClient, layer: FetchHttpClient.layer, deps: [] })
// Every request the executor sends is a model call (the V2 runner's, and the native runtime's), so Vector Local decides
// each one as a model call, with the process's identity holds, before it is sent.
export const requestExecutor = makeGlobalNode({
  service: RequestExecutor.Service,
  layer: RequestExecutor.layer.pipe(
    Layer.provide(
      Layer.effect(
        HttpClient.HttpClient,
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient
          const holds = yield* LocalProbe.HoldsService
          return EgressHttpClient.models(client, holds)
        }),
      ),
    ),
  ),
  deps: [httpClient, LocalProbe.holdsNode],
})
export const llmClient = makeGlobalNode({ service: LLMClient.Service, layer: LLMClient.layer, deps: [requestExecutor] })

export * as LayerNodePlatform from "./app-node-platform"
