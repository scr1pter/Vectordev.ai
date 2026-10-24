import { expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { BrainWorker } from "@vectordevai/core/brain/worker/host"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Effect } from "effect"
import { BrainWorkerSource } from "../../src/brain/worker-source"

// From source there is no bundled reader, and under bun test every import of a module that is not there leaves a
// directory open. The suite builds this layer for each instance, so one import each ran it out of file descriptors.
test.skipIf(process.platform === "win32")(
  "looks for the bundled reader once however often the layer is built",
  async () => {
    const open = () => readdirSync("/dev/fd").length
    const load = Effect.gen(function* () {
      const source = yield* BrainWorker.Source
      return yield* source.load
    })
    const before = open()
    const loaded = await Promise.all(
      Array.from({ length: 200 }, () =>
        Effect.runPromise(load.pipe(Effect.provide(LayerNode.compile(BrainWorkerSource.node)))),
      ),
    )
    expect(loaded.every((source) => source === undefined)).toBe(true)
    expect(open() - before).toBeLessThan(50)
  },
)
