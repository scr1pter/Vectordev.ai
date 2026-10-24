export * as BrainWorkerSource from "./worker-source"

import { BrainWorker } from "@vectordevai/core/brain/worker/host"
import { makeGlobalNode } from "@vectordevai/core/effect/app-node"
import { Effect, Layer } from "effect"

// The brain's background reader, as the engine's builds carry it: script/build.ts and script/build-node.ts bundle
// core's worker/entry.ts first and hand the result to the main bundle as the virtual module brain-worker.gen.ts, one
// string. The host starts it as an eval worker, so the compiled CLI and the desktop's Node bundle ship no second file
// and Electron never loads a worker script out of the signed app. From source there is no such module, and the host
// starts the worker from entry.ts itself.
export const node = makeGlobalNode({
  service: BrainWorker.Source,
  layer: Layer.succeed(
    BrainWorker.Source,
    BrainWorker.Source.of({
      load: Effect.promise(() => (bundled.source ??= read())),
    }),
  ),
  deps: [],
})

// The module is in this build or it is not, so it is imported once per process. Under `bun test` every import of a
// module that is not there leaves a directory open, and the engine's suite builds this layer for each of its many
// instances: from source it ran the suite out of file descriptors (EMFILE) before it finished.
const bundled: { source?: Promise<string | undefined> } = {}

function read(): Promise<string | undefined> {
  // @ts-expect-error - generated at build time
  return import("brain-worker.gen.ts").then((module) => module.default as string).catch(() => undefined)
}
