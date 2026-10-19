import { describe, expect, test } from "bun:test"
import { evaluate, markdown } from "../../script/knowledge-eval"

// The knowledge eval (script/knowledge-eval.ts): five specs of a small repository and 58 requests. Forty are tasks with
// the files they touch, mostly in words the governing requirement never uses; eight edit a file that only imports the
// governed one; ten ask about nothing the specs say. Code-anchored recall has to find the requirement for at least 80%
// of the tasks, at least 20 points more than keywords alone, and send nothing at all for the other ten. The code graph
// (personalized PageRank) replaced spreading activation over code links only because it does at least as well on both
// sets of tasks. The same run is what the dated report, and every number published from it, comes from.

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
      `knowledge eval: anchor recall@5 PageRank ${(working.pagerank / working.tasks).toFixed(2)}, activation ${(working.activation / working.tasks).toFixed(2)}, keywords alone ${(working.keywords / working.tasks).toFixed(2)} (${working.tasks} tasks); through an import PageRank ${(hops.pagerank / hops.tasks).toFixed(2)}, activation ${(hops.activation / hops.tasks).toFixed(2)}, keywords alone ${(hops.keywords / hops.tasks).toFixed(2)} (${hops.tasks} tasks); ${report.cards.toFixed(1)} cards and ${report.tokens.light.mean.toFixed(0)} tokens a request (activation ${report.activationTokens.toFixed(0)})${report.missed.length ? `; missed: ${report.missed.join(" | ")}` : ""}`,
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
    expect(text).toContain("Search by meaning (local embeddings) is not in this build")
    expect(text).not.toMatch(/\bexactly\b|never exceeds|absolute privacy|\bprojects?\b/i)
  }, 110_000)
})
