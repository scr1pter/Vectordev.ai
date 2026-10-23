// The body of the brain worker smoke (scripts/verify-brain-worker.ts) inside Electron's utility process, which is
// plain Node as the desktop engine runs in it: the brain's background reader started the way the engine starts it, an
// eval worker from the bundled source, reading the PDF the smoke wrote and then running the search model on ONNX
// Runtime's wasm (the fixture model, and the pinned arctic-embed-xs files when the smoke has them), each load checked
// against its canary vectors. It prints one line of JSON for the smoke.

import { readFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { BrainWorker } from "@vectordevai/core/brain/worker/host"

/** A model as the smoke describes it: where its files are, its canaries, and texts to embed with what they must give. */
type Spec = {
  readonly name: string
  readonly key: string
  readonly dir: string
  readonly graph: string
  readonly wasm: string
  readonly settings: BrainWorker.EmbedModel["settings"]
  readonly canaries: BrainWorker.EmbedModel["canaries"]
  readonly threshold: number
  readonly texts: readonly string[]
}

const source = await import(
  // @ts-expect-error - provided when the smoke bundles this file
  "brain-worker.gen.ts"
).then((module: { default: string }) => module.default)
const bytes = new Uint8Array(await readFile(process.argv[2]!))
const specs: readonly Spec[] = process.argv[3] ? JSON.parse(await readFile(process.argv[3], "utf8")) : []
const model = (spec: Spec): BrainWorker.EmbedModel => ({
  key: spec.key,
  settings: spec.settings,
  canaries: spec.canaries,
  threshold: spec.threshold,
  files: async () => ({
    wasm: new Uint8Array(await readFile(spec.wasm)),
    model: new Uint8Array(await readFile(path.join(spec.dir, spec.graph))),
    tokenizer: await readFile(path.join(spec.dir, "tokenizer.json"), "utf8"),
    config: await readFile(path.join(spec.dir, "tokenizer_config.json"), "utf8"),
  }),
})
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
    const status = yield* worker.status()
    // One model after the other, in the same worker thread the PDF was read in.
    const embedded = yield* Effect.forEach(specs, (spec) =>
      Effect.gen(function* () {
        const started = performance.now()
        const vectors = yield* worker.embed({
          model: model(spec),
          texts: spec.texts,
          role: "passage",
          priority: "background",
        })
        const check = (yield* worker.status()).check
        return {
          name: spec.name,
          vectors: vectors.map((vector) => Array.from(vector)),
          check,
          ms: performance.now() - started,
        }
      }).pipe(Effect.catch((error) => Effect.succeed({ name: spec.name, error: error.message }))),
    )
    return { result, status, embedded, after: yield* worker.status() }
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
      embedded: outcome.embedded,
      after: outcome.after,
    }
  : outcome
const message = `brain-worker-smoke ${JSON.stringify({ ...summary, versions: process.versions })}\n`
// Electron can end the utility's stdout before its final chunk reaches the parent. Wait for an explicit flush ack.
if (process.parentPort) {
  process.parentPort.on("message", (event) => {
    if (event.data === "brain-worker-smoke-ack") process.exit(0)
  })
  process.parentPort.postMessage(message)
}
if (!process.parentPort) process.stdout.write(message, () => process.exit(0))
