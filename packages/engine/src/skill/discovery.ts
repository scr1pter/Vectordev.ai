import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { SkillDiscovery } from "@vectordevai/core/skill/discovery"
import { Context, Effect, Layer } from "effect"

export interface Interface {
  readonly pull: (url: string) => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@vector/SkillDiscovery") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* SkillDiscovery.Service
    return Service.of({
      pull: (url) => discovery.pull(url).pipe(Effect.map((directories) => Array.from(directories))),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [SkillDiscovery.node] })

export * as Discovery from "./discovery"
