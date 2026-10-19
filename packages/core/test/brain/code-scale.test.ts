import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { BrainFuse } from "@vectordevai/core/brain/fuse"
import { BrainGraph } from "@vectordevai/core/brain/graph"
import { added, text, withKnowledge } from "./fixture/knowledge"

// The code index and the code graph at the size of a real repository: 2,000 files index in under 20 seconds (the
// target is 3), a pass with nothing changed or one file changed takes under a second, and the graph is built and
// walked in well under a request's patience.

const FOLDERS = 50
const PER_FOLDER = 40

function synthetic() {
  return Object.fromEntries(
    Array.from({ length: FOLDERS * PER_FOLDER }, (_, n) => {
      const folder = n % FOLDERS
      const file = Math.floor(n / FOLDERS)
      const next = (n + 1) % (FOLDERS * PER_FOLDER)
      const other = (n * 7 + 3) % (FOLDERS * PER_FOLDER)
      const target = (index: number) => `../area${index % FOLDERS}/module${Math.floor(index / FOLDERS)}`
      return [
        `src/area${folder}/module${file}.ts`,
        [
          `import { handle${next} } from "${target(next)}"`,
          `import { LIMIT_${other}_MS } from "${target(other)}"`,
          "",
          `export const LIMIT_${n}_MS = ${n} * 1000`,
          "",
          `export function handle${n}(input: string) {`,
          `  return handle${next}(input).slice(0, LIMIT_${other}_MS)`,
          "}",
          ...(n % 10 === 0 ? [`router.get("/v1/items${n}/:id", (request) => handle${n}(request.params.id))`] : []),
          ...(n % 7 === 0 ? [`const key${n} = process.env.KEY_${n} ?? ""`] : []),
          "",
        ].join("\n"),
      ]
    }),
  )
}

describe("code index at scale", () => {
  test("2,000 files index in under 20 s, and a pass after a change reads only it, in under a second", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          const first = yield* setup.knowledge.code(setup.place)
          const again = yield* setup.knowledge.code(setup.place)
          yield* Effect.promise(() =>
            fs.writeFile(path.join(setup.root, "src/area3/module7.ts"), "export function handle353() {\n  return 1\n}\n"),
          )
          const changed = yield* setup.knowledge.code(setup.place)
          yield* added(
            setup,
            text(
              "Items spec.md",
              [
                "# Items spec",
                "",
                "## 1 Handlers",
                "",
                "`handle400` MUST trim its input.",
                "",
                "GET /v1/items400/{id} returns one item.",
                "",
              ].join("\n"),
            ),
          )
          const ask = (path: string) =>
            setup.knowledge.recall(setup.place, {
              query: "make this a little faster",
              files: [],
              tier: "standard",
              tight: false,
              personal: true,
              exclude: new Set(),
              seeds: [{ path, weight: BrainFuse.SEED.edited }],
            })
          // The first walk builds the graph; the second finds it built.
          const built = Date.now()
          const near = yield* ask("src/area49/module7.ts")
          const cold = Date.now() - built
          const walked = Date.now()
          yield* ask("src/area0/module8.ts")
          const warm = Date.now() - walked
          return { first, again, changed, near, cold, warm }
        }),
      { files: synthetic(), git: true },
    )
    console.log(
      `code index: ${result.first.files} files in ${result.first.ms} ms, unchanged pass ${result.again.ms} ms, one change ${result.changed.ms} ms; code graph built and walked ${result.cold} ms, walked ${result.warm} ms`,
    )
    expect(result.first).toMatchObject({ files: 2_000, parsed: 2_000 })
    expect(result.first.ms).toBeLessThan(20_000)
    expect(result.again).toMatchObject({ parsed: 0, reused: 2_000 })
    expect(result.again.ms).toBeLessThan(1_000)
    expect(result.changed).toMatchObject({ parsed: 1, reused: 1_999 })
    expect(result.changed.ms).toBeLessThan(1_000)
    // module7 of area49 calls handle400, and imports its file: its requirement comes in.
    expect(result.near.text ?? "").toContain("handle400 MUST trim its input.")
    expect(result.cold).toBeLessThan(5_000)
    expect(result.warm).toBeLessThan(500)
  }, 60_000)

  test("a graph of 50,000 links is built in under 2 s and walked in under 200 ms", () => {
    const nodes = 12_000
    // Each file to the next one along and to ones further off, and every third link to a record of its own.
    const edges = Array.from({ length: 25_000 }, (_, n) => {
      const source = `F:${n % nodes}`
      const target = n % 3 === 0 ? `r${n}` : `F:${(n + 1 + Math.floor(n / nodes) * 997) % nodes}`
      return [
        { source, target, weight: 0.32 },
        { source: target, target: source, weight: 0.22 },
      ]
    }).flat()
    const started = Date.now()
    const graph = BrainGraph.build(edges)
    const builtIn = Date.now() - started
    const walking = Date.now()
    const mass = BrainGraph.rank(
      graph,
      new Map(Array.from({ length: BrainFuse.SEEDS }, (_, n) => [`F:${n * 97}`, BrainFuse.SEED.edited] as const)),
    )
    const walkedIn = Date.now() - walking
    console.log(`code graph: ${graph.ids.length} nodes, ${graph.targets.length} links, built ${builtIn} ms, walked ${walkedIn} ms`)
    expect(graph.targets.length).toBeGreaterThan(40_000)
    expect(mass.size).toBeGreaterThan(0)
    expect(builtIn).toBeLessThan(2_000)
    expect(walkedIn).toBeLessThan(200)
  })
})
