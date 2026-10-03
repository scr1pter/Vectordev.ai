import { Effect } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { RipgrepBinary } from "@vectordevai/core/ripgrep/binary"

// First use can download and extract the real binary; search assertions retain their own short deadlines.
export function prepareRipgrep() {
  return Effect.gen(function* () {
    const binary = yield* RipgrepBinary.Service
    return yield* binary.filepath
  }).pipe(Effect.provide(LayerNode.compile(RipgrepBinary.node)), Effect.timeout("60 seconds"), Effect.runPromise)
}
