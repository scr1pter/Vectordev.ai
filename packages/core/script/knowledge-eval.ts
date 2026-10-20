#!/usr/bin/env bun
// The knowledge eval, and the only source of the numbers Vector publishes about the brain. Nothing here calls a model.
//
// It adds the five specs of a small invented repository (test/fixtures/knowledge) and sends 58 requests through recall
// as Light requests: 40 tasks with the files they touch, mostly in words the governing requirement never uses; 8 that
// edit a file which only imports the governed one; 10 that ask about nothing the specs say. For each task it records
// whether the governing requirement came back by keywords alone, through code links by spreading activation, and
// through the code graph by personalized PageRank, with the cards and tokens sent. Then it measures the tokens each
// request size sends and how long the keyword stage takes: for the five specs, and for a generated 300-page PDF read
// in the background reader. Search by meaning (local embeddings) is not in this build, so it has no figure.
//
//   bun script/knowledge-eval.ts                print the report
//   bun script/knowledge-eval.ts --out <dir>    also write <dir>/report.json and <dir>/README.md
//   bun script/knowledge-eval.ts --pages 300    pages of the generated PDF (0 leaves that stage out)
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Brain } from "../src/brain/brain"
import { BrainDatabase } from "../src/brain/database"
import { BrainEmbed } from "../src/brain/embed"
import { BrainFuse } from "../src/brain/fuse"
import { BrainKnowledge } from "../src/brain/knowledge"
import { BrainWorker } from "../src/brain/worker/host"
import { LayerNode } from "../src/effect/layer-node"
import { Global } from "../src/global"
import { Ripgrep } from "../src/ripgrep"
import { added, text, withKnowledge } from "../test/brain/fixture/knowledge"
import { specPdf, specQueries } from "../test/brain/fixture/spec-pdf"
import { tmpdir } from "../test/fixture/tmpdir"

const FIXTURE = path.join(import.meta.dir, "..", "test", "fixtures", "knowledge")
const TIERS = ["chat", "light", "standard", "thorough"] as const

type Case = {
  readonly query: string
  readonly seeds: readonly { readonly path: string; readonly how: "edited" | "read" }[]
  readonly expect?: string
}

type Queries = {
  readonly working: readonly Case[]
  readonly hops: readonly Case[]
  readonly irrelevant: readonly Case[]
}

type Graph = "pagerank" | "activation"

/** Recall on the fixture with each way of reaching code-linked records, summed up the way the report quotes it. */
export async function evaluate() {
  const queries: Queries = await Bun.file(path.join(FIXTURE, "queries.json")).json()
  const documents = await files(path.join(FIXTURE, "documents"))
  const repo = await files(path.join(FIXTURE, "repo"))
  const pagerank = await run(queries, documents, repo, "pagerank")
  const activation = await run(queries, documents, repo, "activation")
  const count = (items: readonly { readonly found: boolean }[]) => items.filter((item) => item.found).length
  const keywords = (items: readonly { readonly keywords: boolean }[]) => items.filter((item) => item.keywords).length
  const found = (set: "working" | "hops") => ({
    tasks: pagerank[set].length,
    keywords: keywords(pagerank[set]),
    activation: count(activation[set]),
    pagerank: count(pagerank[set]),
  })
  const light = pagerank.working.map((item) => item.tokens.light)
  return {
    fixture: {
      documents: pagerank.documents.length,
      records: sum(pagerank.documents.map((document) => document.records)),
      characters: sum(Object.values(documents).map((body) => body.length)),
      tokens: sum(pagerank.documents.map((document) => document.tokens)),
      files: Object.keys(repo).length,
      working: queries.working.length,
      hops: queries.hops.length,
      irrelevant: queries.irrelevant.length,
    },
    found: { working: found("working"), hops: found("hops") },
    // Search by meaning is not in this build.
    dense: null,
    cards: mean(pagerank.working.map((item) => item.cards)),
    tokens: Object.fromEntries(
      TIERS.map((tier) => [
        tier,
        {
          mean: mean(pagerank.working.map((item) => item.tokens[tier])),
          max: Math.max(...pagerank.working.map((item) => item.tokens[tier])),
          budget: BrainKnowledge.budget(tier, { documents: true, tight: false }),
        },
      ]),
    ) as Record<(typeof TIERS)[number], { mean: number; max: number; budget: number }>,
    activationTokens: mean(activation.working.map((item) => item.tokens.light)),
    lightMedian: percentile(light, 0.5),
    irrelevant: {
      pagerank: pagerank.irrelevant.map((item) => item.tokens),
      activation: activation.irrelevant.map((item) => item.tokens),
    },
    keyword: {
      seconds: pagerank.seconds,
      recall: { p50: percentile(pagerank.times, 0.5), p95: percentile(pagerank.times, 0.95) },
    },
    missed: [...pagerank.working, ...pagerank.hops].filter((item) => !item.found).map((item) => item.query),
    cases: [...pagerank.working, ...pagerank.hops].map((item, index) => {
      const other = [...activation.working, ...activation.hops][index]!
      return {
        set: item.set,
        query: item.query,
        files: item.files,
        keywords: item.keywords,
        activation: other.found,
        pagerank: item.found,
        cards: item.cards,
        tokens: item.tokens.light,
      }
    }),
  }
}

export type Report = Awaited<ReturnType<typeof evaluate>>

/** The keyword stage for one long document: read in the background reader, stored, indexed, then searched. */
export async function keywordStage(pages: number) {
  const bytes = specPdf(pages)
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "brain.db")
  const place: Brain.Place = { repository: "eval-large", root: tmp.path, sources: [], held: false }
  const layer = BrainKnowledge.layer.pipe(
    Layer.provide(LayerNode.compile(Ripgrep.node)),
    Layer.provide(BrainEmbed.layerOff),
    Layer.provideMerge(Brain.layer),
    Layer.provideMerge(
      BrainWorker.layer.pipe(
        Layer.provide(Layer.succeed(BrainWorker.Source, BrainWorker.Source.of({ load: Effect.succeed(undefined) }))),
      ),
    ),
    Layer.provideMerge(BrainDatabase.layerFor(file)),
    Layer.provide(
      Layer.succeed(
        Global.Service,
        Global.make({ config: path.join(tmp.path, "config"), data: path.join(tmp.path, "data") }),
      ),
    ),
  )
  return await Effect.runPromise(
    Effect.gen(function* () {
      const knowledge = yield* BrainKnowledge.Service
      const started = performance.now()
      const result = yield* knowledge.add(place, { type: "bytes", name: "spec.pdf", bytes, origin: "cli" })
      if (result.type === "refused") return yield* Effect.die(new Error(result.message))
      const document = yield* knowledge.wait(place, result.document.id, "searchable", 120_000)
      const seconds = (performance.now() - started) / 1000
      if (!document || !BrainKnowledge.USABLE.includes(document.status))
        return yield* Effect.die(new Error(`The generated PDF did not become searchable: ${document?.status}`))
      const reader = (yield* knowledge.worker()).mode
      const recall = (query: string) =>
        knowledge.recall(place, {
          query,
          files: [],
          tier: "standard",
          tight: false,
          personal: true,
          exclude: new Set(),
        })
      // The first search in a process prepares its statements; the requests after it are what the p95 is about.
      yield* recall("how long may the audit service take?")
      const timed = yield* Effect.forEach(specQueries(), (query) =>
        Effect.gen(function* () {
          const at = performance.now()
          const recalled = yield* recall(query)
          return { ms: performance.now() - at, cards: recalled.cards.length, tokens: recalled.tokens }
        }),
      )
      return {
        pages,
        megabytes: bytes.length / 1024 / 1024,
        tokens: document.stats.tokens,
        records: document.stats.records,
        passages: document.stats.passages,
        seconds,
        reader,
        recall: {
          queries: timed.length,
          answered: timed.filter((item) => item.cards > 0).length,
          p50: percentile(
            timed.map((item) => item.ms),
            0.5,
          ),
          p95: percentile(
            timed.map((item) => item.ms),
            0.95,
          ),
          maxTokens: Math.max(...timed.map((item) => item.tokens)),
        },
      }
    }).pipe(Effect.provide(layer)),
  )
}

export type Large = Awaited<ReturnType<typeof keywordStage>>

/** The dated report as Markdown, every figure taken from the run it describes. */
export function markdown(input: {
  readonly report: Report
  readonly large?: Large
  readonly date: Date
  readonly revision: string
  readonly dirty: boolean
  /** The processor, system and load the run started on. */
  readonly machine: string
}) {
  const report = input.report
  const day = input.date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
  const of = (found: number, tasks: number) => `${found} of ${tasks} (${share(found, tasks)})`
  const row = (label: string, set: Report["found"]["working"]) =>
    `| ${label} | ${set.tasks} | ${of(set.keywords, set.tasks)} | ${of(set.activation, set.tasks)} | ${of(set.pagerank, set.tasks)} | not in this build |`
  const tier = (name: (typeof TIERS)[number]) =>
    `| ${name[0]!.toUpperCase()}${name.slice(1)} | ${report.tokens[name].budget} | ${report.tokens[name].mean.toFixed(0)} | ${report.tokens[name].max} |`
  const large = input.large
  return [
    `# Knowledge eval, ${day}`,
    "",
    `Generated by \`bun packages/core/script/knowledge-eval.ts\` at revision \`${input.revision.slice(0, 9)}\`${input.dirty ? " with uncommitted changes" : ""} on ${input.machine}. Every figure Vector publishes about the brain comes from a dated report like this one; \`report.json\` beside it holds every request and its result.`,
    "",
    "## What it measures",
    "",
    `The fixture is a small invented repository of ${report.fixture.files} source files and ${report.fixture.documents} short specs for it (\`packages/core/test/fixtures/knowledge\`): ${thousands(report.fixture.characters)} characters, about ${thousands(report.fixture.tokens)} tokens, read into ${report.fixture.records} records. Recall runs the way a Light request does: the request's words, the files it touches, and at most the Light budget of cards. No model is called and nothing is embedded.`,
    "",
    `- **${report.fixture.working} tasks** name the files they touch, mostly in words the governing requirement never uses ("change how long people stay signed in" while editing \`src/auth/session.ts\`).`,
    `- **${report.fixture.hops} tasks** edit a file that only imports the governed one, so no spec is linked to the edited file itself.`,
    `- **${report.fixture.irrelevant} requests** ask about nothing the specs say, such as "hi" or "how do I center a div?".`,
    "",
    "A task counts as found when the governing requirement's sentence is in what the request carries.",
    "",
    "## Recall",
    "",
    "| Tasks | Count | Keywords alone | Code links, spreading activation | Code graph, personalized PageRank | Search by meaning |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    row("Named files", report.found.working),
    row("Through an import", report.found.hops),
    "",
    `With the code graph a Light request carried ${report.cards.toFixed(1)} cards and ${report.tokens.light.mean.toFixed(0)} tokens on average (median ${report.lightMedian.toFixed(0)}); with spreading activation it carried ${report.activationTokens.toFixed(0)}. The ${report.fixture.irrelevant} unrelated requests carried ${sum(report.irrelevant.pagerank)} tokens with the code graph and ${sum(report.irrelevant.activation)} with spreading activation.${report.missed.length > 0 ? ` Missed: ${report.missed.map((query) => `"${query}"`).join(", ")}.` : ""}`,
    "",
    "## Tokens for each request size",
    "",
    `The same ${report.fixture.working} tasks at each size, through the code graph. Chat is what a greeting is sized as.`,
    "",
    "| Size | Budget | Mean | Most |",
    "| --- | ---: | ---: | ---: |",
    ...TIERS.map(tier),
    "",
    "## Keyword stage",
    "",
    `The ${report.fixture.documents} specs were searchable by keywords and linked to the code ${report.keyword.seconds.toFixed(2)} s after the first was added, read on the main thread as the test fixture reads them. A Light recall took ${report.keyword.recall.p50.toFixed(1)} ms at the median and ${report.keyword.recall.p95.toFixed(1)} ms at the 95th percentile.`,
    ...(large
      ? [
          "",
          `A generated ${large.pages}-page text PDF (${large.megabytes.toFixed(1)} MB, about ${thousands(large.tokens)} tokens if sent whole, ${thousands(large.records)} records in ${large.passages} passages) was searchable by keywords ${large.seconds.toFixed(2)} s after it was added, read in the ${large.reader === "worker" ? "background worker" : "main thread"}. ${large.recall.answered} of ${large.recall.queries} questions about it recalled cards, at most ${large.recall.maxTokens} tokens each as Standard requests, in ${large.recall.p50.toFixed(1)} ms at the median and ${large.recall.p95.toFixed(1)} ms at the 95th percentile.`,
        ]
      : []),
    "",
    "## Limits",
    "",
    "- The fixture is small and was written alongside the feature it measures. It shows that code links reach requirements keywords miss; it is not an independent benchmark, and it does not measure the quality of a model's answers.",
    "- Times are from one run on the machine named above and change with the machine and its load.",
    "- Search by meaning (local embeddings) is not in this build, so its column has no figure.",
    "- Token counts are Vector's estimate of what the recalled text costs, not a provider's count.",
    "",
    "Run it again with `cd packages/core && bun script/knowledge-eval.ts --out <folder>`.",
    "",
  ].join("\n")
}

if (import.meta.main) {
  const flag = (name: string) => {
    const at = process.argv.indexOf(name)
    return at >= 0 ? process.argv[at + 1] : undefined
  }
  const pages = Number(flag("--pages") ?? 300)
  const date = new Date()
  const host = machine()
  const report = await evaluate()
  const large = pages > 0 ? await keywordStage(pages) : undefined
  const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: import.meta.dir })
    .stdout.toString()
    .trim()
  const dirty =
    Bun.spawnSync(["git", "status", "--porcelain"], { cwd: import.meta.dir })
      .stdout.toString()
      .trim() !== ""
  const text = markdown({ report, large, date, revision, dirty, machine: host })
  console.log(text)
  const out = flag("--out")
  if (out) {
    await fs.mkdir(out, { recursive: true })
    const { cases, ...summary } = report
    await Bun.write(
      path.join(out, "report.json"),
      `${JSON.stringify({ date: date.toLocaleDateString("en-CA"), revision, dirty, machine: host, ...summary, ...(large ? { large } : {}), cases }, null, 2)}\n`,
    )
    await Bun.write(path.join(out, "README.md"), text)
    console.log(`Wrote ${path.join(out, "report.json")} and README.md`)
  }
}

async function run(queries: Queries, documents: Record<string, string>, repo: Record<string, string>, graph: Graph) {
  return withKnowledge(
    (setup) =>
      Effect.gen(function* () {
        const started = performance.now()
        const read = yield* Effect.forEach(Object.entries(documents), ([name, body]) =>
          Effect.gen(function* () {
            const result = yield* added(setup, text(name, body))
            const document = result.document
            if (!document || !BrainKnowledge.USABLE.includes(document.status))
              return yield* Effect.die(new Error(`${name} did not become searchable: ${document?.status}`))
            return document.stats
          }),
        )
        const seconds = (performance.now() - started) / 1000
        const recall = (item: Case, tier: BrainKnowledge.Tier, seeded: boolean) =>
          Effect.gen(function* () {
            const at = performance.now()
            const recalled = yield* setup.knowledge.recall(setup.place, {
              query: item.query,
              files: [],
              tier,
              tight: false,
              personal: true,
              exclude: new Set(),
              ...(seeded
                ? { seeds: item.seeds.map((seed) => ({ path: seed.path, weight: BrainFuse.SEED[seed.how] })) }
                : {}),
            })
            return { ...recalled, ms: performance.now() - at }
          })
        const score = (set: "working" | "hops", cases: readonly Case[]) =>
          Effect.forEach(cases, (item) =>
            Effect.gen(function* () {
              const linked = yield* recall(item, "light", true)
              const keywords = yield* recall(item, "light", false)
              const [chat, standard, thorough] = yield* Effect.forEach(
                ["chat", "standard", "thorough"] as const,
                (tier) => recall(item, tier, true),
              )
              return {
                set,
                query: item.query,
                files: item.seeds.map((seed) => seed.path),
                found: (linked.text ?? "").includes(item.expect!),
                keywords: (keywords.text ?? "").includes(item.expect!),
                cards: linked.cards.length,
                ms: linked.ms,
                tokens: {
                  chat: chat!.tokens,
                  light: linked.tokens,
                  standard: standard!.tokens,
                  thorough: thorough!.tokens,
                },
              }
            }),
          )
        const working = yield* score("working", queries.working)
        const hops = yield* score("hops", queries.hops)
        const times = [...working, ...hops].map((item) => item.ms)
        // The most an unrelated request carries at any size.
        const irrelevant = yield* Effect.forEach(queries.irrelevant, (item) =>
          Effect.gen(function* () {
            const sizes = yield* Effect.forEach(["light", "standard", "thorough"] as const, (tier) =>
              recall(item, tier, true),
            )
            return { query: item.query, tokens: Math.max(...sizes.map((size) => size.tokens)) }
          }),
        )
        return { documents: read, seconds, times, working, hops, irrelevant }
      }),
    { files: repo, git: true, graph },
  )
}

async function files(dir: string, base = dir): Promise<Record<string, string>> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return files(full, base)
      return { [path.relative(base, full).split(path.sep).join("/")]: await fs.readFile(full, "utf8") }
    }),
  )
  return Object.assign({}, ...nested)
}

function machine() {
  return `${os.cpus()[0]?.model ?? "an unknown processor"}, ${os.cpus().length} cores, ${os.platform()} ${os.arch()}, Bun ${Bun.version}, one-minute load average ${os.loadavg()[0]!.toFixed(1)} at the start`
}

function sum(values: readonly number[]) {
  return values.reduce((total, value) => total + value, 0)
}

function mean(values: readonly number[]) {
  return values.length === 0 ? 0 : sum(values) / values.length
}

function share(found: number, tasks: number) {
  return tasks === 0 ? "0%" : `${Math.round((found / tasks) * 100)}%`
}

function thousands(value: number) {
  return value >= 10_000 ? `${Math.round(value / 1000)}K` : value.toLocaleString("en-US")
}

function percentile(values: readonly number[], at: number) {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * at))] ?? 0
}
