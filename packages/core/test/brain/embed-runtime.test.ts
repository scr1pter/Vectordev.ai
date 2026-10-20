import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { BrainEmbed } from "@vectordevai/core/brain/embed"
import { BrainEmbedManifest } from "@vectordevai/core/brain/embed-manifest"
import { BrainVector } from "@vectordevai/core/brain/vector"
import { BrainWorker } from "@vectordevai/core/brain/worker/host"
import { Global } from "@vectordevai/core/global"
import { tmpdir } from "../fixture/tmpdir"
import * as Fixture from "./fixture/onnx"

// The local search model on ONNX Runtime's real WASM build, run here with a tiny model written byte by byte (a table
// of word vectors averaged over a text), so the vectors it must give are known without ONNX Runtime. The model is
// installed from a folder as `vector memory model install --from` does it, and checked on every load against pinned
// canary vectors. The real model runs too when VECTOR_TEST_EMBED_DIR names a folder of its pinned files.

const ENTRY = path.join(import.meta.dir, "../../src/brain/worker/entry.ts")
const built: { source?: Promise<string> } = {}
const bundle = () =>
  (built.source ??= Bun.build({ entrypoints: [ENTRY], target: "node", format: "esm", minify: true }).then((result) => {
    if (!result.success) throw new Error(result.logs.join("\n"))
    return result.outputs[0]!.text()
  }))

/** The fixture's canary vectors, as the pinned model would give them. */
function pinned(values = Fixture.table()): BrainEmbed.Golden {
  return {
    "arctic-embed-xs-q8": {
      revision: Fixture.manifest().revision,
      int8: BrainEmbedManifest.CANARIES.map((canary) => ({
        text: canary.text,
        role: canary.role,
        vector: Array.from(Fixture.expected(canary.text, values)),
      })),
    },
  }
}

async function run<A>(
  body: (embed: BrainEmbed.Interface, setup: { readonly source: string; readonly dir: string }) => Effect.Effect<A, unknown>,
  options: {
    readonly golden?: BrainEmbed.Golden
    readonly worker?: Layer.Layer<BrainWorker.Service>
    readonly dir?: string
    readonly model?: BrainEmbedManifest.Model
  } = {},
) {
  await using tmp = await tmpdir()
  const dir = options.dir ?? tmp.path
  const source = await Fixture.write(path.join(tmp.path, "source"))
  const layer = BrainEmbed.layerWith({
    dir: path.join(dir, "models"),
    models: { "arctic-embed-xs-q8": options.model ?? Fixture.manifest() },
    golden: options.golden ?? pinned(),
    downloads: false,
  }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(options.worker ?? BrainWorker.layerInline),
    Layer.provide(
      Layer.succeed(Global.Service, Global.make({ data: path.join(dir, "data"), config: path.join(dir, "config") })),
    ),
  )
  return await Effect.runPromise(
    Effect.gen(function* () {
      return yield* body(yield* BrainEmbed.Service, { source, dir })
    }).pipe(Effect.provide(layer)),
  )
}

const inWorker = async () =>
  BrainWorker.layerWith({}).pipe(
    Layer.provide(Layer.succeed(BrainWorker.Source, BrainWorker.Source.of({ load: Effect.succeed(await bundle()) }))),
  )

describe("the local search model", () => {
  test("ONNX Runtime's WASM build gives the fixture model's vectors, the same every time, checked against its canaries", async () => {
    const result = await run((embed, setup) =>
      Effect.gen(function* () {
        const installed = yield* embed.install(setup.source)
        const first = yield* embed.embed(["Refresh tokens expire after days", "Clients must retry at most times"])
        const again = yield* embed.embed(["Refresh tokens expire after days", "Clients must retry at most times"])
        const query = yield* embed.query("how long do sessions last")
        return { installed, first, again, query, current: yield* embed.current(), status: yield* embed.status() }
      }),
    )
    expect(result.installed).toMatchObject({
      state: "ready",
      model: "arctic-embed-xs-q8",
      variant: "int8",
      source: "folder",
    })
    expect(result.status.check).toMatchObject({ by: "vectors", needed: BrainEmbedManifest.CHECK })
    expect(result.status.check!.lowest).toBeGreaterThan(0.9999)
    expect(result.current).toMatchObject({ dims: Fixture.DIMS, paused: false })
    expect(result.current!.key).toBe(BrainEmbedManifest.key(Fixture.manifest(), "int8"))
    expect(result.first).toHaveLength(2)
    expect(BrainVector.cosine(result.first![0]!, Fixture.expected("Refresh tokens expire after days"))).toBeGreaterThan(
      0.9999,
    )
    expect(BrainVector.cosine(result.first![1]!, Fixture.expected("Clients must retry at most times"))).toBeGreaterThan(
      0.9999,
    )
    expect(Array.from(result.again![0]!)).toEqual(Array.from(result.first![0]!))
    expect(BrainVector.cosine(result.query!, Fixture.expected("how long do sessions last"))).toBeGreaterThan(0.9999)
    // Stored as int8 with one scale, a vector keeps its direction.
    const quantized = BrainVector.quantize(result.first![0]!)
    expect(
      BrainVector.cosine(result.first![0]!, BrainVector.dequantize(quantized.q8, quantized.scale)),
    ).toBeGreaterThanOrEqual(0.99)
  }, 60_000)

  test("in the background reader's worker thread, from its bundled source, as the CLI and the desktop run it", async () => {
    const worker = await inWorker()
    const result = await run(
      (embed, setup) =>
        Effect.gen(function* () {
          yield* embed.install(setup.source)
          const vectors = yield* embed.embed(["the audit log keeps logs for years"])
          return { vectors, status: yield* embed.status() }
        }),
      { worker },
    )
    expect(result.status).toMatchObject({ state: "ready", worker: { mode: "worker" } })
    expect(
      BrainVector.cosine(result.vectors![0]!, Fixture.expected("the audit log keeps logs for years")),
    ).toBeGreaterThan(0.9999)
  }, 60_000)

  test("an int8 graph that gives other vectors here than its pinned ones is not used, and the full-precision one is", async () => {
    // What a runtime that computes the int8 graph wrongly gives: other numbers from the same files.
    const wrong = Fixture.table().map((value, at) => (at % 3 === 0 ? value : -value))
    const graph = (values: Float32Array) => ({
      bytes: Fixture.model(values).byteLength,
      sha256: new Bun.CryptoHasher("sha256").update(Fixture.model(values)).digest("hex"),
    })
    const model = Fixture.manifest(Fixture.table(), {
      files: {
        ...Fixture.manifest().files,
        model: { name: "onnx/model_quantized.onnx", ...graph(wrong) },
      },
      fallback: { name: "onnx/model.onnx", ...graph(Fixture.table()) },
    })
    const result = await run(
      (embed, setup) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.writeFile(path.join(setup.source, "onnx", "model_quantized.onnx"), Fixture.model(wrong))
            await fs.writeFile(path.join(setup.source, "onnx", "model.onnx"), Fixture.model())
          })
          const installed = yield* embed.install(setup.source)
          const unused = {
            current: yield* embed.current(),
            query: yield* embed.query("how long do sessions last"),
            vectors: yield* embed.embed(["refresh tokens expire"]),
          }
          const fallback = yield* embed.install(setup.source, { variant: "fp32" })
          return {
            installed,
            unused,
            fallback,
            vectors: yield* embed.embed(["refresh tokens expire"]),
            current: yield* embed.current(),
          }
        }),
      { model },
    )
    expect(result.installed).toMatchObject({ state: "failed", variant: "int8", fallback: true })
    expect(result.installed.error).toContain("different vectors")
    expect(result.unused).toEqual({ current: undefined, query: undefined, vectors: undefined })
    // Checked against the int8 graph's pinned vectors, a little more loosely, until its own are pinned.
    expect(result.fallback).toMatchObject({
      state: "ready",
      variant: "fp32",
      check: { by: "vectors", needed: BrainEmbedManifest.CHECK_FALLBACK },
    })
    expect(result.current!.key).toBe(BrainEmbedManifest.key(model, "fp32"))
    expect(BrainVector.cosine(result.vectors![0]!, Fixture.expected("refresh tokens expire"))).toBeGreaterThan(0.9999)
  }, 60_000)

  test("a request's query over 300 ms is dropped, so the request goes on with keywords and code links", async () => {
    const slow = Layer.effect(
      BrainWorker.Service,
      Effect.gen(function* () {
        const real = yield* BrainWorker.Service
        return BrainWorker.Service.of({
          ...real,
          embed: (input) =>
            input.priority === "query"
              ? Effect.sleep("1 second").pipe(Effect.andThen(real.embed(input)))
              : real.embed(input),
        })
      }),
    ).pipe(Layer.provide(BrainWorker.layerInline))
    const result = await run(
      (embed, setup) =>
        Effect.gen(function* () {
          yield* embed.install(setup.source)
          const at = performance.now()
          const query = yield* embed.query("how long do sessions last")
          return { query, ms: performance.now() - at }
        }),
      { worker: slow },
    )
    expect(result.query).toBeUndefined()
    expect(result.ms).toBeGreaterThanOrEqual(BrainEmbed.TIMEOUT - 20)
    expect(result.ms).toBeLessThan(900)
  }, 60_000)

  test("a cold model never holds up a request: the first query loads it in the background, the next one uses it", async () => {
    await using tmp = await tmpdir()
    await run((embed, setup) => embed.install(setup.source), { dir: tmp.path })
    // A new process, with the model on disk and nothing loaded.
    const result = await run(
      (embed) =>
        Effect.gen(function* () {
          const at = performance.now()
          const cold = yield* embed.query("how long do sessions last")
          const ms = performance.now() - at
          for (const _ of Array.from({ length: 100 })) {
            if ((yield* embed.status()).check) break
            yield* Effect.sleep("20 millis")
          }
          return { cold, ms, warm: yield* embed.query("how long do sessions last") }
        }),
      { dir: tmp.path },
    )
    expect(result.cold).toBeUndefined()
    expect(result.ms).toBeLessThan(100)
    expect(BrainVector.cosine(result.warm!, Fixture.expected("how long do sessions last"))).toBeGreaterThan(0.9999)
  }, 60_000)

  test("a file changed after it was installed is caught the first time a process loads the model", async () => {
    await using tmp = await tmpdir()
    await run((embed, setup) => embed.install(setup.source), { dir: tmp.path })
    const graph = path.join(
      tmp.path,
      "models",
      `arctic-embed-xs-q8@${Fixture.manifest().revision}`,
      "onnx",
      "model_quantized.onnx",
    )
    const bytes = await fs.readFile(graph)
    bytes[bytes.length - 1] ^= 0x01
    await fs.writeFile(graph, bytes)
    const result = await run(
      (embed) =>
        Effect.gen(function* () {
          const vectors = yield* embed.embed(["refresh tokens expire"])
          return { vectors, status: yield* embed.status() }
        }),
      { dir: tmp.path },
    )
    expect(result.vectors).toBeUndefined()
    expect(result.status.state).toBe("failed")
    expect(result.status.error).toContain("changed since it was installed")
  }, 60_000)

  test("installing from a folder refuses a file of the wrong size or hash, and keeps nothing of it", async () => {
    const result = await run((embed, setup) =>
      Effect.gen(function* () {
        const tokenizer = path.join(setup.source, "tokenizer.json")
        const text = yield* Effect.promise(() => fs.readFile(tokenizer, "utf8"))
        yield* Effect.promise(() => fs.writeFile(tokenizer, text.replace("refresh", "Refresh")))
        const refused = yield* embed.install(setup.source).pipe(Effect.flip)
        return {
          refused,
          status: yield* embed.status(),
          files: yield* Effect.promise(() => listed(path.join(setup.dir, "models"))),
        }
      }),
    )
    expect(result.refused.reason).toBe("verify")
    expect(result.refused.message).toContain("tokenizer.json")
    expect(result.status.state).toBe("absent")
    expect(
      result.files.filter(
        (file) => file.endsWith("tokenizer.json") || file.endsWith(".part") || file.endsWith("manifest.json"),
      ),
    ).toEqual([])
  }, 60_000)

  const real = process.env.VECTOR_TEST_EMBED_DIR
  test.skipIf(!real)(
    "the pinned arctic-embed-xs int8 model matches its pinned vectors and finds a paraphrase",
    async () => {
      await using tmp = await tmpdir()
      const layer = BrainEmbed.layerWith({ dir: path.join(tmp.path, "models"), downloads: false }).pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(await inWorker()),
        Layer.provide(Layer.succeed(Global.Service, Global.make({ data: path.join(tmp.path, "data") }))),
      )
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const embed = yield* BrainEmbed.Service
          const installed = yield* embed.install(real!)
          const passages = yield* embed.embed([
            "Auth spec: Refresh tokens expire after 14 days.",
            "Runbook: Upload at most 50 MB per file.",
          ])
          const at = performance.now()
          const query = yield* embed.query("how long do sessions last")
          return { installed, passages, query, ms: performance.now() - at }
        }).pipe(Effect.provide(layer)),
      )
      console.log(
        `real model: check ${result.installed.check?.lowest.toFixed(4)}, warm query ${result.ms.toFixed(0)} ms`,
      )
      expect(result.installed).toMatchObject({ state: "ready", check: { by: "vectors" } })
      expect(result.installed.check!.lowest).toBeGreaterThanOrEqual(BrainEmbedManifest.CHECK)
      const [tokens, upload] = result.passages!
      expect(BrainVector.cosine(result.query!, tokens!)).toBeGreaterThan(
        BrainVector.cosine(result.query!, upload!) + 0.05,
      )
      expect(BrainVector.cosine(result.query!, tokens!)).toBeGreaterThanOrEqual(
        BrainEmbedManifest.MODELS["arctic-embed-xs-q8"].floor,
      )
      expect(result.ms).toBeLessThan(BrainEmbed.TIMEOUT)
    },
    110_000,
  )

  test.skipIf(!real)(
    "a model with no pinned vectors is checked by how it ranks the canaries",
    async () => {
      await using tmp = await tmpdir()
      const layer = BrainEmbed.layerWith({ dir: path.join(tmp.path, "models"), downloads: false, golden: {} }).pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(BrainWorker.layerInline),
        Layer.provide(Layer.succeed(Global.Service, Global.make({ data: path.join(tmp.path, "data") }))),
      )
      const status = await Effect.runPromise(
        Effect.gen(function* () {
          const embed = yield* BrainEmbed.Service
          return yield* embed.install(real!)
        }).pipe(Effect.provide(layer)),
      )
      expect(status).toMatchObject({ state: "ready", check: { by: "ranking" } })
    },
    110_000,
  )
})

async function listed(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map((entry) => (entry.isDirectory() ? listed(path.join(dir, entry.name)) : [path.join(dir, entry.name)])),
  )
  return nested.flat()
}
