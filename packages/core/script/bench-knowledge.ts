#!/usr/bin/env bun
// The acceptance bench for reading a large document into the brain, by keywords only (no model): a generated 300-page
// text PDF, about 150,000 tokens, read in the background reader, structured, stored with its keyword index, and then
// searched. Each stage has the limit the design accepts on an Apple M-class machine; the run fails when one is missed.
//   bun packages/core/script/bench-knowledge.ts [--pages 300]
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Brain } from "../src/brain/brain"
import { BrainDatabase } from "../src/brain/database"
import { BrainLimits } from "../src/brain/document/limits"
import { BrainDocument } from "../src/brain/document/read"
import { BrainExtract } from "../src/brain/extract"
import { BrainKnowledge } from "../src/brain/knowledge"
import { BrainStructure } from "../src/brain/structure"
import { BrainWorkerEntry } from "../src/brain/worker/entry"
import { BrainWorker } from "../src/brain/worker/host"
import { Global } from "../src/global"
import { Token } from "../src/util/token"
import { pdf } from "../test/brain/fixture/pdf"

const pages = Number(process.argv[process.argv.indexOf("--pages") + 1]) || 300

// Seconds each stage may take, and megabytes brain.db may grow by.
const LIMITS = { extract: 30, structure: 5, store: 4, searchable: 30, growth: 8, recall: 0.025 }

const TOPICS = ["sessions", "uploads", "billing", "exports", "webhooks", "queues", "search", "reports", "imports", "audit"]

// A page of spec: a numbered heading every fifth page, then body text with requirements, limits and an endpoint.
const page = (index: number) => {
  const topic = TOPICS[index % TOPICS.length]!
  const lines = [
    ...(index % 5 === 0
      ? [{ text: `${Math.floor(index / 5) + 1} ${topic[0]!.toUpperCase()}${topic.slice(1)} rules`, size: 16, font: "bold" as const }]
      : []),
    // 22 lines of about 95 characters: about 520 tokens a page, 150,000 for 300 pages.
    ...Array.from({ length: 22 }, (_, line) => {
      const n = index * 22 + line
      const text =
        line % 11 === 0
          ? `The ${topic} service MUST finish request ${n} within ${(n % 90) + 10} seconds or report a timeout.`
          : line % 11 === 5
            ? `Clients call GET /v1/${topic}/${n} with a bearer token and retry at most ${(n % 4) + 2} times after a 429.`
            : `The ${topic} module keeps record ${n} in the ${topic}_state table and replays it in order after a restart.`
      return { text, size: 10, font: "regular" as const }
    }),
  ]
  return {
    runs: lines.map((line, at) => ({ text: line.text, x: 54, y: 760 - at * 30, size: line.size, font: line.font })),
  }
}

const seconds = (since: number) => (performance.now() - since) / 1000
const results: { stage: string; value: number; limit: number; unit: string }[] = []
const report = (stage: string, value: number, limit: number, unit = "s") => {
  results.push({ stage, value, limit, unit })
  console.log(`${stage.padEnd(34)} ${value.toFixed(unit === "s" ? 2 : 1).padStart(8)} ${unit}  (limit ${limit} ${unit})`)
}

const started = performance.now()
const bytes = pdf({ title: "Bench spec", pages: Array.from({ length: pages }, (_, index) => page(index)) })
console.log(`Generated a ${pages}-page PDF of ${(bytes.length / 1024 / 1024).toFixed(1)} MB in ${seconds(started).toFixed(1)} s`)

// The readers alone, then structure and records, on this thread, for the breakdown.
const reading = performance.now()
const extracted = await BrainDocument.read({ name: "bench.pdf", bytes }, BrainLimits.LIMITS.worker)
if (extracted.type === "refused") throw new Error(extracted.message)
report("pdf.js text extraction", seconds(reading), LIMITS.extract)
const structuring = performance.now()
const place = { repository: "bench", lineage: "bench.pdf", document: "dbench", limits: BrainLimits.LIMITS.worker }
const structured = BrainStructure.structure(extracted, place)
const extraction = BrainExtract.extract(extracted, structured, place)
report("structure, records and scans", seconds(structuring), LIMITS.structure)
console.log(
  `  ${Token.estimate(extracted.text)} tokens, ${structured.sections.length} sections, ${structured.passages.length} passages, ${extraction.records.length} records`,
)

// The whole keyword stage through the store: the background reader, then rows and postings, until searchable.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vector-bench-knowledge-"))
const file = path.join(dir, "brain.db")
const layer = BrainKnowledge.layer.pipe(
  Layer.provideMerge(Brain.layer),
  Layer.provideMerge(
    BrainWorker.layer.pipe(
      Layer.provide(Layer.succeed(BrainWorker.Source, BrainWorker.Source.of({ load: Effect.succeed(undefined) }))),
    ),
  ),
  Layer.provideMerge(BrainDatabase.layerFor(file)),
  Layer.provide(Layer.succeed(Global.Service, Global.make({ config: path.join(dir, "config"), data: path.join(dir, "data") }))),
)
const brainPlace: Brain.Place = { repository: "bench", root: dir, sources: [], held: false }
await Effect.runPromise(
  Effect.gen(function* () {
    const knowledge = yield* BrainKnowledge.Service
    const empty = (yield* Effect.promise(() => fs.stat(file))).size
    const adding = performance.now()
    const added = yield* knowledge.add(brainPlace, { type: "bytes", name: "bench.pdf", bytes, origin: "cli" })
    if (added.type === "refused") throw new Error(added.message)
    const document = yield* knowledge.wait(brainPlace, added.document.id, "searchable", 120_000)
    const total = seconds(adding)
    if (!document || (document.status !== "searchable" && document.status !== "partial"))
      throw new Error(`The document did not become searchable: ${document?.status} ${document?.error ?? ""}`)
    report("searchable by keywords", total, LIMITS.searchable)
    console.log(`  read in the ${(yield* knowledge.worker()).mode === "worker" ? "background worker" : "main thread"}`)
    yield* Effect.promise(() => Bun.sleep(100))
    const grown = (yield* Effect.promise(() => fs.stat(file))).size - empty
    const wal = (yield* Effect.promise(() => fs.stat(`${file}-wal`).catch(() => ({ size: 0 })))).size
    report("brain.db growth", (grown + wal) / 1024 / 1024, LIMITS.growth, "MB")
    const queries = TOPICS.flatMap((topic) => [
      `how long may the ${topic} service take to finish a request?`,
      `how many times do clients retry the ${topic} endpoint after a 429?`,
    ])
    // The first search in a process prepares its statements; requests after it are what the p95 is about.
    const cold = performance.now()
    yield* knowledge.recall(brainPlace, {
      query: "how long may the audit service take?",
      files: [],
      tier: "standard",
      tight: false,
      personal: true,
      exclude: new Set(),
    })
    console.log(`  first recall in the process: ${(seconds(cold) * 1000).toFixed(1)} ms`)
    const times = yield* Effect.forEach(queries, (query) =>
      Effect.gen(function* () {
        const at = performance.now()
        const recalled = yield* knowledge.recall(brainPlace, {
          query,
          files: [],
          tier: "standard",
          tight: false,
          personal: true,
          exclude: new Set(),
        })
        return { seconds: seconds(at), cards: recalled.cards.length, tokens: recalled.tokens }
      }),
    )
    const sorted = times.map((item) => item.seconds).toSorted((a, b) => a - b)
    report("recall p95, keywords", (sorted[Math.floor(sorted.length * 0.95)] ?? 0) * 1000, LIMITS.recall * 1000, "ms")
    console.log(
      `  ${times.filter((item) => item.cards > 0).length}/${times.length} queries recalled cards, at most ${Math.max(...times.map((item) => item.tokens))} tokens`,
    )
  }).pipe(Effect.provide(layer)),
)

// Storing alone: rows, postings and frequencies for an already-read document, through a reader that answers at once.
const answer = await BrainWorkerEntry.handle({
  id: 1,
  type: "extract",
  name: "bench.pdf",
  bytes,
  repository: "bench-store",
  lineage: "bench.pdf",
  document: "dstore",
  limits: "worker",
})
if (answer.type !== "extracted") throw new Error(`The bench document was not read: ${answer.type}`)
const instant = Layer.succeed(
  BrainWorker.Service,
  BrainWorker.Service.of({
    extract: () => Effect.succeed({ type: "extracted" as const, structured: answer.result }),
    probe: () => Effect.die("not used"),
    status: () => Effect.succeed({ mode: "worker" as const, threads: 0 }),
  }),
)
const storeFile = path.join(dir, "store.db")
await Effect.runPromise(
  Effect.gen(function* () {
    const knowledge = yield* BrainKnowledge.Service
    const storePlace: Brain.Place = { repository: "bench-store", root: dir, sources: [], held: false }
    const storing = performance.now()
    const added = yield* knowledge.add(storePlace, { type: "bytes", name: "bench.pdf", bytes, origin: "cli" })
    if (added.type === "refused") throw new Error(added.message)
    yield* knowledge.wait(storePlace, added.document.id, "searchable", 120_000)
    report("store, keyword index and counts", seconds(storing), LIMITS.store)
  }).pipe(
    Effect.provide(
      BrainKnowledge.layer.pipe(
        Layer.provideMerge(Brain.layer),
        Layer.provideMerge(instant),
        Layer.provideMerge(BrainDatabase.layerFor(storeFile)),
        Layer.provide(
          Layer.succeed(Global.Service, Global.make({ config: path.join(dir, "config"), data: path.join(dir, "data") })),
        ),
      ),
    ),
  ),
)
await fs.rm(dir, { recursive: true, force: true })

const missed = results.filter((item) => item.value > item.limit)
if (missed.length > 0) {
  console.error(`Missed: ${missed.map((item) => item.stage).join(", ")}`)
  process.exit(1)
}
console.log("Every keyword-stage limit met.")
