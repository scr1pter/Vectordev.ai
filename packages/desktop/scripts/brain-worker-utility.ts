// The body of the brain worker smoke (scripts/verify-brain-worker.ts) inside Electron's utility process, which is
// plain Node as the desktop engine runs in it: the brain's background reader started the way the engine starts it, an
// eval worker from the bundled source, reading the PDF the smoke wrote. It prints one line of JSON for the smoke.

import { readFile } from "node:fs/promises"
import { Effect, Layer } from "effect"
import { BrainWorker } from "@vectordevai/core/brain/worker/host"

const source = await import(
  // @ts-expect-error - provided when the smoke bundles this file
  "brain-worker.gen.ts"
).then((module: { default: string }) => module.default)
const bytes = new Uint8Array(await readFile(process.argv[2]!))
const outcome = await Effect.runPromise(
  Effect.gen(function* () {
    const worker = yield* BrainWorker.Service
    const result = yield* worker.extract({
      name: "spec.pdf",
      bytes,
      repository: "brain-worker-smoke",
      lineage: "spec.pdf",
      document: "dsmoke",
    })
    return { result, status: yield* worker.status() }
  }).pipe(
    Effect.provide(
      BrainWorker.layer.pipe(
        Layer.provide(Layer.succeed(BrainWorker.Source, BrainWorker.Source.of({ load: Effect.succeed(source) }))),
      ),
    ),
    Effect.map((value) => ({ ok: true as const, ...value })),
    Effect.catchCause((cause) => Effect.succeed({ ok: false as const, cause: String(cause) })),
  ),
)
const summary = outcome.ok
  ? {
      ok: true,
      type: outcome.result.type,
      ...(outcome.result.type === "extracted"
        ? {
            format: outcome.result.structured.format,
            pages: outcome.result.structured.pages,
            records: outcome.result.structured.records.map((record) => record.card),
          }
        : {}),
      status: outcome.status,
    }
  : outcome
process.stdout.write(`brain-worker-smoke ${JSON.stringify({ ...summary, versions: process.versions })}\n`)
