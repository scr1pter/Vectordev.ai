import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { BrainWorker } from "@vectordevai/core/brain/worker/host"
import { bundle } from "./fixture/bundle"
import { lines, pdf } from "./fixture/pdf"

// The background reader, through the same eval start the engine's builds use: the worker body is bundled to one string
// here, as the engine's build does, and handed to the host as its source.

const ENTRY = path.join(import.meta.dir, "../../src/brain/worker/entry.ts")

const run = <A, E>(
  source: string | undefined,
  options: BrainWorker.Options,
  body: (worker: BrainWorker.Interface) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* body(yield* BrainWorker.Service)
    }).pipe(
      Effect.provide(
        BrainWorker.layerWith(options).pipe(
          Layer.provide(Layer.succeed(BrainWorker.Source, BrainWorker.Source.of({ load: Effect.succeed(source) }))),
        ),
      ),
    ),
  )

const SPEC = pdf({
  pages: [
    {
      runs: [
        { text: "Auth spec", x: 72, y: 740, size: 20, font: "bold" },
        ...lines(["Clients MUST retry at most 3 times after a 429 response.", "Refresh tokens expire after 14 days."], {
          top: 700,
        }),
      ],
    },
  ],
})

const input = { name: "auth.pdf", bytes: SPEC, repository: "repo", lineage: "auth.pdf", document: "d1" }

// Workers that misbehave on purpose, written as the worker body would be.
const HANG = `import { parentPort } from "node:worker_threads"
parentPort.on("message", () => { for (;;) {} })
parentPort.postMessage({ type: "ready" })`
const EXIT = `import { parentPort } from "node:worker_threads"
parentPort.on("message", () => process.exit(3))
parentPort.postMessage({ type: "ready" })`
// Answers, then dies with nothing left to read: the reader itself does not hold up here.
const IDLE_EXIT = `import { parentPort } from "node:worker_threads"
parentPort.on("message", (request) => {
  parentPort.postMessage({ id: request.id, type: "failed", message: "nothing read" })
  setTimeout(() => process.exit(3), 20)
})
parentPort.postMessage({ type: "ready" })`
const SILENT = `import { parentPort } from "node:worker_threads"
parentPort.on("message", () => {})`
const BROKEN = `throw new Error("threads are not allowed here")`
const GARBAGE = `import { parentPort } from "node:worker_threads"
parentPort.on("message", (message) => parentPort.postMessage({ id: message.id, type: "extracted", result: { title: 7 } }))
parentPort.postMessage({ type: "ready" })`

const settle = (worker: BrainWorker.Interface) =>
  Effect.gen(function* () {
    for (const _ of Array.from({ length: 50 })) {
      if ((yield* worker.status()).threads === 0) return 0
      yield* Effect.sleep("20 millis")
    }
    return (yield* worker.status()).threads
  })

describe("BrainWorker", () => {
  test("reads a PDF in an eval worker started from the bundled source", async () => {
    const source = await bundle(ENTRY, { minify: true })
    const result = await run(source, {}, (worker) =>
      Effect.gen(function* () {
        const read = yield* worker.extract(input)
        return { read, status: yield* worker.status() }
      }),
    )
    expect(result.status).toEqual({ mode: "worker", threads: 1 })
    expect(result.read.type).toBe("extracted")
    if (result.read.type !== "extracted") return
    expect(result.read.structured.title).toBe("Auth spec")
    expect(result.read.structured.pages).toBe(1)
    expect(result.read.structured.records.map((record) => record.kind)).toContain("requirement")
    expect(result.read.structured.passages[0]?.body).toContain("Refresh tokens expire after 14 days.")
  }, 60_000)

  // Decoded streams live outside the heap, where the worker's resource limits never reach (and Bun has none), so the
  // bundled reader has to stop such a file itself.
  test("a small PDF that inflates to 600 MB is refused inside the eval worker", async () => {
    const source = await bundle(ENTRY, { minify: true })
    const bomb = pdf({
      pages: [
        {
          runs: lines(["Clients MUST retry at most 3 times after a 429 response."]),
          padding: 600e6,
          filter: "/Filter /Fl",
        },
      ],
    })
    expect(bomb.length).toBeLessThan(1024 * 1024)
    const started = performance.now()
    const result = await run(source, {}, (worker) =>
      Effect.gen(function* () {
        const read = yield* worker.extract({ ...input, name: "bomb.pdf", bytes: bomb })
        return { read, status: yield* worker.status() }
      }),
    )
    expect(result.status).toEqual({ mode: "worker", threads: 1 })
    expect(result.read).toMatchObject({ type: "refused", reason: "too-large" })
    expect(performance.now() - started).toBeLessThan(15_000)
  }, 60_000)

  test("from source under Bun the worker starts from its own file", async () => {
    const result = await run(undefined, {}, (worker) =>
      Effect.gen(function* () {
        const probe = yield* worker.probe({ name: "auth.pdf", bytes: SPEC })
        return { probe, status: yield* worker.status() }
      }),
    )
    expect(result.status.mode).toBe("worker")
    expect(result.probe).toEqual({ type: "probed", probe: { format: "pdf", pages: 1, tokens: expect.any(Number) } })
  }, 60_000)

  test("a refused file is an answer, not an error", async () => {
    const result = await run(undefined, {}, (worker) =>
      worker.extract({ ...input, name: "notes.bin", bytes: new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]) }),
    )
    expect(result).toEqual({ type: "refused", reason: "unsupported", message: expect.stringContaining("Programs") })
  }, 60_000)

  test("a document that takes too long stops its worker, and the next one gets a new worker", async () => {
    const result = await run(HANG, { timeout: { pdf: 300, other: 300 } }, (worker) =>
      Effect.gen(function* () {
        const started = Date.now()
        const first = yield* Effect.exit(worker.extract(input))
        const elapsed = Date.now() - started
        const threads = yield* settle(worker)
        const second = yield* Effect.exit(worker.extract(input))
        return { first, elapsed, threads, second, status: yield* worker.status() }
      }),
    )
    expect(Exit.isFailure(result.first)).toBe(true)
    expect(JSON.stringify(result.first)).toContain('"reason":"timeout"')
    expect(result.elapsed).toBeLessThan(5_000)
    // The hung thread is gone, not left spinning.
    expect(result.threads).toBe(0)
    expect(JSON.stringify(result.second)).toContain('"reason":"timeout"')
    // A slow document is the document's fault: the reader stays in its worker.
    expect(result.status.mode).toBe("worker")
  }, 60_000)

  test("a worker that cannot start leaves reading on the main thread, and says why", async () => {
    const result = await run(BROKEN, {}, (worker) =>
      Effect.gen(function* () {
        const read = yield* worker.extract(input)
        return { read, status: yield* worker.status() }
      }),
    )
    expect(result.status.mode).toBe("in-process")
    expect(result.status.reason).toContain("could not start here")
    expect(result.status.reason).toContain("threads are not allowed here")
    expect(result.read.type).toBe("extracted")
  }, 60_000)

  test("a worker that never says it is ready counts as one that cannot start", async () => {
    const result = await run(SILENT, { ready: 200 }, (worker) =>
      Effect.gen(function* () {
        const read = yield* worker.extract(input)
        return { read, status: yield* worker.status(), threads: yield* settle(worker) }
      }),
    )
    expect(result.status.mode).toBe("in-process")
    expect(result.status.reason).toContain("did not start within")
    expect(result.read.type).toBe("extracted")
    expect(result.threads).toBe(0)
  }, 60_000)

  test("a file that stops the reader never moves reading to the main thread, however often it is read", async () => {
    const result = await run(EXIT, {}, (worker) =>
      Effect.gen(function* () {
        const first = yield* Effect.exit(worker.extract(input))
        const second = yield* Effect.exit(worker.extract(input))
        const third = yield* Effect.exit(worker.extract(input))
        return { first, second, third, status: yield* worker.status() }
      }),
    )
    for (const attempt of [result.first, result.second, result.third])
      expect(JSON.stringify(attempt)).toContain('"reason":"crashed"')
    expect(result.status.mode).toBe("worker")
  }, 60_000)

  test("two crashes in ten minutes that no one file explains move reading to the main thread", async () => {
    const idle = await run(IDLE_EXIT, {}, (worker) =>
      Effect.gen(function* () {
        const first = yield* Effect.exit(worker.extract(input))
        yield* Effect.sleep("300 millis")
        const between = yield* worker.status()
        yield* Effect.exit(worker.extract(input))
        yield* Effect.sleep("300 millis")
        const third = yield* worker.extract(input)
        return { first, between, third, status: yield* worker.status() }
      }),
    )
    expect(JSON.stringify(idle.first)).toContain('"reason":"failed"')
    expect(idle.between.mode).toBe("worker")
    expect(idle.status.mode).toBe("in-process")
    expect(idle.status.reason).toContain("stopped twice in 10 minutes")
    expect(idle.third.type).toBe("extracted")
    const other = {
      ...input,
      name: "other.pdf",
      bytes: pdf({ pages: [{ runs: lines(["Tokens expire after 30 days."]) }] }),
    }
    const two = await run(EXIT, {}, (worker) =>
      Effect.gen(function* () {
        yield* Effect.exit(worker.extract(input))
        yield* Effect.exit(worker.extract(other))
        return yield* worker.status()
      }),
    )
    expect(two.mode).toBe("in-process")
  }, 60_000)

  test("a read on the main thread stops at its time limit too", async () => {
    const long = pdf({
      pages: Array.from({ length: 40 }, (_, page) => ({
        runs: lines(
          Array.from({ length: 30 }, (_, line) => `Page ${page} line ${line}: clients MUST retry at most 3 times.`),
        ),
      })),
    })
    const started = performance.now()
    const result = await run(undefined, { inline: true, timeout: { pdf: 20, other: 20 } }, (worker) =>
      Effect.exit(worker.extract({ ...input, name: "long.pdf", bytes: long })),
    )
    expect(JSON.stringify(result)).toContain('"reason":"timeout"')
    expect(performance.now() - started).toBeLessThan(5_000)
  }, 60_000)

  test("an answer that does not decode is not used", async () => {
    const result = await run(GARBAGE, {}, (worker) => Effect.exit(worker.extract(input)))
    expect(JSON.stringify(result)).toContain('"reason":"invalid"')
  }, 60_000)
})
