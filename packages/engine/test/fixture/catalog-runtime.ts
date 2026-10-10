import { Effect, Layer } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelCatalog } from "@vectordevai/core/model-catalog"

async function load() {
  return Effect.gen(function* () {
    const catalog = yield* ModelCatalog.Service
    const first = yield* catalog.get()
    return { first, cached: first === (yield* catalog.get()) }
  }).pipe(Effect.provide(Layer.fresh(LayerNode.compile(ModelCatalog.node))), Effect.scoped, Effect.runPromise)
}

const initial = await load()
const catalog = structuredClone(initial.first)
const model = Object.values(initial.first).flatMap((provider) => Object.values(provider.models))[0]
if (model) Object.assign(model, { name: "Changed by the first service" })
const fresh = await load()
console.log(JSON.stringify({ catalog, cached: initial.cached, fresh: fresh.first }))
