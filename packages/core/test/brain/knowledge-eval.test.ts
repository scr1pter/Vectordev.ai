import { describe, expect, test } from "bun:test"
import { evaluate, markdown } from "../../script/knowledge-eval"

// The knowledge eval (script/knowledge-eval.ts): five specs of a small repository and 58 requests. Forty are tasks with
// the files they touch, mostly in words the governing requirement never uses; eight edit a file that only imports the
// governed one; ten ask about nothing the specs say. Code-anchored recall has to find the requirement for at least 80%
// of the tasks, at least 20 points more than keywords alone, and send nothing at all for the other ten. The code graph
// (personalized PageRank) replaced spreading activation over code links only because it does at least as well on both
// sets of tasks. Search by meaning (here the hash stand-in for the local model) must not cost what the other channels
// found, nor send anything for the ten unrelated requests. The same run is what the dated report, and every number
// published from it, comes from; with the real model it runs as `bun script/knowledge-eval.ts --model <folder>`.

describe("knowledge eval", () => {
  test("anchor recall@5 is at least 0.8, 0.2 above keywords alone, PageRank at least activation, and irrelevant requests cost 0 tokens", async () => {
    const report = await evaluate()
    expect(report.fixture.working).toBe(40)
    expect(report.fixture.hops).toBe(8)
    expect(report.fixture.irrelevant).toBe(10)
    expect(report.fixture.documents).toBe(5)
    const working = report.found.working
    const hops = report.found.hops
    console.log(
      `knowledge eval (meaning by ${report.dense.model}: keywords and meaning ${working.meaning}/${working.tasks}, every channel ${working.all}/${working.tasks} and ${hops.all}/${hops.tasks}): anchor recall@5 PageRank ${(working.pagerank / working.tasks).toFixed(2)}, activation ${(working.activation / working.tasks).toFixed(2)}, keywords alone ${(working.keywords / working.tasks).toFixed(2)} (${working.tasks} tasks); through an import PageRank ${(hops.pagerank / hops.tasks).toFixed(2)}, activation ${(hops.activation / hops.tasks).toFixed(2)}, keywords alone ${(hops.keywords / hops.tasks).toFixed(2)} (${hops.tasks} tasks); ${report.cards.toFixed(1)} cards and ${report.tokens.light.mean.toFixed(0)} tokens a request (activation ${report.activationTokens.toFixed(0)})${report.missed.length ? `; missed: ${report.missed.join(" | ")}` : ""}`,
    )
    expect(working.pagerank / working.tasks).toBeGreaterThanOrEqual(0.8)
    expect((working.pagerank - working.keywords) / working.tasks).toBeGreaterThanOrEqual(0.2)
    expect(report.cards).toBeLessThanOrEqual(5)
    expect(working.pagerank).toBeGreaterThanOrEqual(working.activation)
    expect(hops.pagerank).toBeGreaterThanOrEqual(hops.activation)
    // What only the graph can reach: a requirement of a file the edited one imports.
    expect(hops.pagerank / hops.tasks).toBeGreaterThanOrEqual(0.75)
    expect(report.irrelevant.pagerank).toEqual(Array.from({ length: 10 }, () => 0))
    expect(report.irrelevant.activation).toEqual(Array.from({ length: 10 }, () => 0))
    // Meaning adds to what keywords and code links find, and to nothing an unrelated request asks.
    expect(report.dense.model).toBe("hash stand-in")
    expect(report.dense.embedded).toBeGreaterThan(0)
    expect(working.meaning).toBeGreaterThanOrEqual(working.keywords)
    expect(working.all).toBeGreaterThanOrEqual(working.pagerank)
    expect(hops.all).toBeGreaterThanOrEqual(hops.pagerank)
    expect(report.dense.irrelevant).toEqual(Array.from({ length: 10 }, () => 0))
    // Only the real model's floor is swept: the stand-in's says nothing about it.
    expect(report.dense.sweep).toEqual([])
    // A greeting is sized Chat and recalls nothing; every other size stays inside its budget.
    expect(report.tokens.chat).toEqual({ mean: 0, max: 0, budget: 0 })
    for (const tier of ["light", "standard", "thorough"] as const)
      expect(report.tokens[tier].max).toBeLessThanOrEqual(report.tokens[tier].budget)
    // The dated report is dated, says what it is not, and quotes the counts it measured.
    const text = markdown({
      report,
      date: new Date(2026, 9, 19),
      revision: "0123456789abcdef",
      dirty: false,
      machine: "a test machine",
    })
    expect(text).toContain("# Knowledge eval, 19 October 2026")
    expect(text).toContain(`| Named files | 40 | ${working.keywords} of 40`)
    expect(text).toContain("it is not an independent benchmark")
    expect(text).toContain("| Keywords and meaning | Every channel |")
    expect(text).toContain("hash stand-in")
    expect(text).not.toContain("not in this build")
    expect(text).not.toContain("## The meaning floor")
    expect(text).not.toMatch(/\bexactly\b|never exceeds|absolute privacy|\bprojects?\b/i)
    // With the model, the floor's margin is the one the sweep measured, never a claim of room to spare.
    const swept = markdown({
      report: {
        ...report,
        dense: {
          ...report.dense,
          model: "the pinned model",
          floor: 0.2,
          clear: 0.18,
          leak: { floor: 0.17, requests: 1, tokens: 122 },
          sweep: [0.17, 0.18, 0.2].map((floor) => ({
            floor,
            meaning: { working: 13, hops: 3 },
            all: { working: 40, hops: 8 },
            irrelevant: Array.from({ length: 10 }, (_, index) => (floor === 0.17 && index === 0 ? 122 : 0)),
          })),
        },
      },
      date: new Date(2026, 9, 19),
      revision: "0123456789abcdef",
      dirty: false,
      machine: "a test machine",
    })
    expect(swept).toContain("| 0.20 (shipped) | 13 of 40 (33%) | 3 of 8 (38%) | 40 of 40 and 8 of 8 | 0 | 0 |")
    expect(swept).toContain(
      "On this fixture unrelated requests carried no cards from 0.18 up, and at 0.17 one of them carried 122 tokens, so the shipped floor sits 0.02 above the least that kept them out.",
    )
    expect(swept).not.toContain("room to spare")
  }, 110_000)

  // The pinned model, where its files are at hand: meaning must add to keywords and take nothing from the code graph,
  // and send nothing for an unrelated request.
  const real = process.env.VECTOR_TEST_EMBED_DIR
  test.skipIf(!real)(
    "with the pinned model, every channel finds what the code graph does and unrelated requests cost 0 tokens",
    async () => {
      const report = await evaluate({ model: real! })
      console.log(
        `knowledge eval with ${report.dense.model}: keywords and meaning ${report.found.working.meaning}/${report.found.working.tasks} and ${report.found.hops.meaning}/${report.found.hops.tasks}, every channel ${report.found.working.all}/${report.found.working.tasks} and ${report.found.hops.all}/${report.found.hops.tasks}, unrelated ${report.dense.irrelevant.join(",")}, recall p95 ${report.dense.recall.p95.toFixed(1)} ms`,
      )
      expect(report.dense.model).not.toBe("hash stand-in")
      expect(report.found.working.meaning).toBeGreaterThan(report.found.working.keywords)
      expect(report.found.working.all).toBeGreaterThanOrEqual(report.found.working.pagerank)
      expect(report.found.hops.all).toBeGreaterThanOrEqual(report.found.hops.pagerank)
      expect(report.dense.irrelevant).toEqual(Array.from({ length: 10 }, () => 0))
      // The sweep reruns the same requests at each floor, and at the shipped one gives what the run gave.
      const shipped = report.dense.sweep.find((row) => row.floor === report.dense.floor)
      expect(shipped?.meaning).toEqual({ working: report.found.working.meaning, hops: report.found.hops.meaning })
      expect(shipped?.irrelevant).toEqual(report.dense.irrelevant)
      expect("clear" in report.dense ? report.dense.clear : undefined).toBeLessThanOrEqual(report.dense.floor ?? 0)
      // With the model warm a request's recall stays within the design's 90 ms at the 95th percentile.
      expect(report.dense.recall.p95).toBeLessThanOrEqual(90)
    },
    110_000,
  )
})
