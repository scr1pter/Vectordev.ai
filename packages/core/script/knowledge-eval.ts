#!/usr/bin/env bun
// The knowledge eval, and the only source of the numbers Vector publishes about the brain. Nothing here calls a model.
//
// It adds the five specs of a small invented repository (test/fixtures/knowledge) and sends 58 requests through recall
// as Light requests: 40 tasks with the files they touch, mostly in words the governing requirement never uses; 8 that
// edit a file which only imports the governed one; 10 that ask about nothing the specs say. For each task it records
// whether the governing requirement came back by keywords alone, through code links by spreading activation, and
// through the code graph by personalized PageRank, with the cards and tokens sent. Then it measures the tokens each
// request size sends and how long the keyword stage takes: for the five specs, and for a generated 300-page PDF read
// in the background reader. Search by meaning runs the same requests with the local model: the pinned
// arctic-embed-xs int8 files when --model (or VECTOR_TEST_EMBED_DIR) names a folder of them, otherwise a hash stand-in
// that knows spelling, not meaning, and the report says which it was. With the model it also sweeps the meaning floor
// over FLOORS on the same embedded fixture, so the report shows what the shipped floor leaves out and lets through.
//
//   bun script/knowledge-eval.ts                print the report
//   bun script/knowledge-eval.ts --out <dir>    also write <dir>/report.json and <dir>/README.md
//   bun script/knowledge-eval.ts --pages 300    pages of the generated PDF (0 leaves that stage out)
//   bun script/knowledge-eval.ts --model <dir>  search by meaning with the pinned model's files in <dir>
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Brain } from "../src/brain/brain"
import { BrainDatabase } from "../src/brain/database"
import { BrainEmbed } from "../src/brain/embed"
import { BrainEmbedManifest } from "../src/brain/embed-manifest"
import { BrainFuse } from "../src/brain/fuse"
import { BrainKnowledge } from "../src/brain/knowledge"
import { BrainWorker } from "../src/brain/worker/host"
import { LayerNode } from "../src/effect/layer-node"
import { FetchHttpClient } from "effect/unstable/http"
import { Global } from "../src/global"
import { Ripgrep } from "../src/ripgrep"
import { added, text, withKnowledge } from "../test/brain/fixture/knowledge"
import { specPdf, specQueries } from "../test/brain/fixture/spec-pdf"
import { tmpdir } from "../test/fixture/tmpdir"

const FIXTURE = path.join(import.meta.dir, "..", "test", "fixtures", "knowledge")
const TIERS = ["chat", "light", "standard", "thorough"] as const
// The meaning floors the model run sweeps, around the shipped 0.2.
const FLOORS = [0.14, 0.15, 0.16, 0.17, 0.18, 0.19, 0.2, 0.21, 0.22, 0.25, 0.3]

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

/**
 * The search model a run uses: none, the hash stand-in, or the pinned model's files in a folder, with the floors to
 * sweep after the run at the model's own floor.
 */
type Meaning =
  | { readonly type: "off" }
  | { readonly type: "hash" }
  | { readonly type: "model"; readonly dir: string; readonly floors?: readonly number[] }

/**
 * Recall on the fixture with each way of reaching code-linked records, and with search by meaning, summed up the way
 * the report quotes it. `model` is a folder of the pinned arctic-embed-xs files; without one the hash stand-in runs.
 */
export async function evaluate(options: { readonly model?: string } = {}) {
  const queries: Queries = await Bun.file(path.join(FIXTURE, "queries.json")).json()
  const documents = await files(path.join(FIXTURE, "documents"))
  const repo = await files(path.join(FIXTURE, "repo"))
  const pagerank = await run(queries, documents, repo, "pagerank")
  const activation = await run(queries, documents, repo, "activation")
  const meaning: Meaning = options.model ? { type: "model", dir: options.model, floors: FLOORS } : { type: "hash" }
  const dense = await run(queries, documents, repo, "pagerank", meaning)
  const count = (items: readonly { readonly found: boolean }[]) => items.filter((item) => item.found).length
  const keywords = (items: readonly { readonly keywords: boolean }[]) => items.filter((item) => item.keywords).length
  const found = (set: "working" | "hops") => ({
    tasks: pagerank[set].length,
    keywords: keywords(pagerank[set]),
    activation: count(activation[set]),
    pagerank: count(pagerank[set]),
    // Keywords and meaning with no code links, then every channel at once.
    meaning: keywords(dense[set]),
    all: count(dense[set]),
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
    dense: {
      model:
        meaning.type === "model"
          ? `${BrainEmbedManifest.MODELS["arctic-embed-xs-q8"].repo}@${BrainEmbedManifest.MODELS["arctic-embed-xs-q8"].revision.slice(0, 12)} int8`
          : "hash stand-in",
      tokens: mean(dense.working.map((item) => item.tokens.light)),
      irrelevant: dense.irrelevant.map((item) => item.tokens),
      recall: { p50: percentile(dense.times, 0.5), p95: percentile(dense.times, 0.95) },
      embedded: dense.embedded,
      seconds: dense.embedSeconds,
      ...(meaning.type === "model" ? margin(dense.sweep, BrainEmbedManifest.MODELS["arctic-embed-xs-q8"].floor) : {}),
      // The same requests at each swept floor: what meaning finds, and the most each unrelated request carries.
      sweep: dense.sweep,
    },
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
      const near = [...dense.working, ...dense.hops][index]!
      return {
        set: item.set,
        query: item.query,
        files: item.files,
        keywords: item.keywords,
        activation: other.found,
        pagerank: item.found,
        meaning: near.keywords,
        all: near.found,
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
    `| ${label} | ${set.tasks} | ${of(set.keywords, set.tasks)} | ${of(set.activation, set.tasks)} | ${of(set.pagerank, set.tasks)} | ${of(set.meaning, set.tasks)} | ${of(set.all, set.tasks)} |`
  const real = report.dense.model !== "hash stand-in"
  const tier = (name: (typeof TIERS)[number]) =>
    `| ${name[0]!.toUpperCase()}${name.slice(1)} | ${report.tokens[name].budget} | ${report.tokens[name].mean.toFixed(0)} | ${report.tokens[name].max} |`
  const large = input.large
  const dense = report.dense
  const swept = (row: Report["dense"]["sweep"][number]) =>
    `| ${row.floor.toFixed(2)}${row.floor === dense.floor ? " (shipped)" : ""} | ${of(row.meaning.working, report.fixture.working)} | ${of(row.meaning.hops, report.fixture.hops)} | ${row.all.working} of ${report.fixture.working} and ${row.all.hops} of ${report.fixture.hops} | ${row.irrelevant.filter((tokens) => tokens > 0).length} | ${sum(row.irrelevant)} |`
  const leak = "leak" in dense ? dense.leak : undefined
  const clear = "clear" in dense ? dense.clear : undefined
  const counted = (count: number) => ["no", "one", "two", "three", "four", "five"][count] ?? String(count)
  const measured =
    clear === undefined
      ? `unrelated requests still carried cards at the shipped floor, ${dense.floor}`
      : `unrelated requests carried no cards from ${clear.toFixed(2)} up${leak ? `, and at ${leak.floor.toFixed(2)} ${counted(leak.requests)} of them carried ${leak.tokens} tokens` : ""}`
  const room =
    clear === undefined ? "" : `, so the shipped floor sits ${((dense.floor ?? 0) - clear).toFixed(2)} above the least that kept them out`
  return [
    `# Knowledge eval, ${day}`,
    "",
    `Generated by \`bun packages/core/script/knowledge-eval.ts\` at revision \`${input.revision.slice(0, 9)}\`${input.dirty ? " with uncommitted changes" : ""} on ${input.machine}. Every figure Vector publishes about the brain comes from a dated report like this one; \`report.json\` beside it holds every request and its result.`,
    "",
    "## What it measures",
    "",
    `The fixture is a small invented repository of ${report.fixture.files} source files and ${report.fixture.documents} short specs for it (\`packages/core/test/fixtures/knowledge\`): ${thousands(report.fixture.characters)} characters, about ${thousands(report.fixture.tokens)} tokens, read into ${report.fixture.records} records. Recall runs the way a Light request does: the request's words, the files it touches, and at most the Light budget of cards. No language model is called. ${real ? `Search by meaning used the local search model, ${report.dense.model}, on this computer: it embedded ${report.dense.embedded} records and passages in ${report.dense.seconds.toFixed(1)} s, running on the main thread as the test fixture runs it.` : "Search by meaning used a hash stand-in for the local model, which places words that share their letters near each other and knows nothing of meaning, so its column says little about the real model."}`,
    "",
    `- **${report.fixture.working} tasks** name the files they touch, mostly in words the governing requirement never uses ("change how long people stay signed in" while editing \`src/auth/session.ts\`).`,
    `- **${report.fixture.hops} tasks** edit a file that only imports the governed one, so no spec is linked to the edited file itself.`,
    `- **${report.fixture.irrelevant} requests** ask about nothing the specs say, such as "hi" or "how do I center a div?".`,
    "",
    "A task counts as found when the governing requirement's sentence is in what the request carries.",
    "",
    "## Recall",
    "",
    "| Tasks | Count | Keywords alone | Code links, spreading activation | Code graph, personalized PageRank | Keywords and meaning | Every channel |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    row("Named files", report.found.working),
    row("Through an import", report.found.hops),
    "",
    `"Keywords and meaning" is recall with no code links: the request's words and what it means. "Every channel" adds the code graph. With the code graph a Light request carried ${report.cards.toFixed(1)} cards and ${report.tokens.light.mean.toFixed(0)} tokens on average (median ${report.lightMedian.toFixed(0)}); with spreading activation it carried ${report.activationTokens.toFixed(0)}, and with every channel ${report.dense.tokens.toFixed(0)}. The ${report.fixture.irrelevant} unrelated requests carried ${sum(report.irrelevant.pagerank)} tokens with the code graph, ${sum(report.irrelevant.activation)} with spreading activation and ${sum(report.dense.irrelevant)} with every channel.${report.missed.length > 0 ? ` Missed: ${report.missed.map((query) => `"${query}"`).join(", ")}.` : ""}`,
    "",
    "## Tokens for each request size",
    "",
    `The same ${report.fixture.working} tasks at each size, through the code graph. Chat is what a greeting is sized as.`,
    "",
    "| Size | Budget | Mean | Most |",
    "| --- | ---: | ---: | ---: |",
    ...TIERS.map(tier),
    ...(real && dense.sweep.length > 0
      ? [
          "",
          "## The meaning floor",
          "",
          `A match by meaning is kept only when its centred cosine is at least the floor and within 0.08 of the best match. The same embedded fixture at each floor: the tasks as Light requests, and the most each unrelated request carried at any size.`,
          "",
          "| Floor | Keywords and meaning, named files | Keywords and meaning, through an import | Every channel | Unrelated requests with cards | Their tokens |",
          "| --- | ---: | ---: | ---: | ---: | ---: |",
          ...dense.sweep.map(swept),
          "",
          `On this fixture ${measured}${room}.`,
        ]
      : []),
    "",
    "## Keyword stage",
    "",
    `The ${report.fixture.documents} specs were searchable by keywords and linked to the code ${report.keyword.seconds.toFixed(2)} s after the first was added, read on the main thread as the test fixture reads them. A Light recall took ${report.keyword.recall.p50.toFixed(1)} ms at the median and ${report.keyword.recall.p95.toFixed(1)} ms at the 95th percentile; with every channel and the ${real ? "model" : "stand-in"} warm, ${report.dense.recall.p50.toFixed(1)} ms and ${report.dense.recall.p95.toFixed(1)} ms.`,
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
    real
      ? `- Search by meaning ran the pinned int8 model on this computer's CPU through ONNX Runtime's WebAssembly build; another machine embeds at another speed. Its floor (${dense.floor}, as a cosine less the mean every text shares) was set on this same fixture, where ${measured}${room}; the meaning columns are not an out-of-sample result.`
      : "- Search by meaning ran a hash stand-in, not the model: run it again with `--model <folder>` for the model's figures.",
    "- The 300-page PDF measures the keyword stage only; how long the model takes to embed it is not timed here.",
    "- Token counts are Vector's estimate of what the recalled text costs, not a provider's count.",
    "",
    `Run it again with \`cd packages/core && bun script/knowledge-eval.ts --out <folder>${real ? " --model <folder of the pinned model files>" : ""}\`.`,
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
  const model = flag("--model") ?? process.env.VECTOR_TEST_EMBED_DIR
  const report = await evaluate(model ? { model: path.resolve(model) } : {})
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

async function run(
  queries: Queries,
  documents: Record<string, string>,
  repo: Record<string, string>,
  graph: Graph,
  meaning: Meaning = { type: "off" },
) {
  // The floor the sweep has set, in place of the model's own while it runs.
  const gate: { floor?: number } = {}
  return withKnowledge(
    (setup) =>
      Effect.gen(function* () {
        if (meaning.type === "model") {
          const installed = yield* setup.embed.install(meaning.dir).pipe(Effect.orDie)
          if (installed.state !== "ready") return yield* Effect.die(new Error(`The search model is not ready: ${installed.error}`))
        }
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
        // With a model, every document is embedded before the requests, as it is once the background embedder is done.
        const embedding = performance.now()
        const ids = (yield* setup.knowledge.documents(setup.place, { personal: true })).map((document) => document.id)
        if (meaning.type !== "off")
          for (const id of ids) yield* setup.knowledge.wait(setup.place, id, "ready", 120_000)
        const embedSeconds = (performance.now() - embedding) / 1000
        const embedded = (yield* setup.knowledge.model(setup.place)).embedded?.done ?? 0
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
        const found = (cases: readonly Case[], seeded: boolean) =>
          Effect.forEach(cases, (item) =>
            recall(item, "light", seeded).pipe(Effect.map((recalled) => (recalled.text ?? "").includes(item.expect!))),
          ).pipe(Effect.map((items) => items.filter(Boolean).length))
        const sweep = yield* Effect.forEach(meaning.type === "model" ? (meaning.floors ?? []) : [], (floor) =>
          Effect.gen(function* () {
            gate.floor = floor
            const unrelated = yield* Effect.forEach(queries.irrelevant, (item) =>
              Effect.forEach(["light", "standard", "thorough"] as const, (tier) => recall(item, tier, true)).pipe(
                Effect.map((sizes) => Math.max(...sizes.map((size) => size.tokens))),
              ),
            )
            return {
              floor,
              meaning: { working: yield* found(queries.working, false), hops: yield* found(queries.hops, false) },
              all: { working: yield* found(queries.working, true), hops: yield* found(queries.hops, true) },
              irrelevant: unrelated,
            }
          }),
        ).pipe(Effect.ensuring(Effect.sync(() => delete gate.floor)))
        return { documents: read, seconds, times, working, hops, irrelevant, embedded, embedSeconds, sweep }
      }),
    {
      files: repo,
      git: true,
      graph,
      ...(meaning.type === "hash" ? { embed: BrainEmbed.layerHash() } : {}),
      ...(meaning.type === "model"
        ? {
            // The model's own service, with the floor the sweep has set in place of the model's.
            embed: (data: string) =>
              Layer.effect(
                BrainEmbed.Service,
                Effect.gen(function* () {
                  const embed = yield* BrainEmbed.Service
                  return BrainEmbed.Service.of({
                    ...embed,
                    current: () =>
                      embed
                        .current()
                        .pipe(
                          Effect.map((current) =>
                            current && gate.floor !== undefined ? { ...current, floor: gate.floor } : current,
                          ),
                        ),
                  })
                }),
              ).pipe(
                Layer.provide(
                  BrainEmbed.layerWith({ dir: path.join(data, "models", "embedding"), downloads: false }).pipe(
                    Layer.provide(FetchHttpClient.layer),
                    Layer.provide(BrainWorker.layerInline),
                    Layer.provide(Layer.succeed(Global.Service, Global.make({ data }))),
                  ),
                ),
              ),
          }
        : {}),
    },
  )
}

/**
 * How far the shipped floor sits above the least swept floor that, like every swept floor between it and the shipped
 * one, let no unrelated request carry a card; and the swept floor just below that, with what got through there.
 */
function margin(
  sweep: readonly { readonly floor: number; readonly irrelevant: readonly number[] }[],
  floor: number,
) {
  const below = sweep.filter((row) => row.floor <= floor).toReversed()
  const at = below.findIndex((row) => row.irrelevant.some((tokens) => tokens > 0))
  const clear = (at === -1 ? below.at(-1) : below[at - 1])?.floor
  const leak = at === -1 ? undefined : below[at]!
  return {
    floor,
    ...(clear === undefined ? {} : { clear }),
    ...(leak
      ? {
          leak: {
            floor: leak.floor,
            requests: leak.irrelevant.filter((tokens) => tokens > 0).length,
            tokens: sum(leak.irrelevant),
          },
        }
      : {}),
  }
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
