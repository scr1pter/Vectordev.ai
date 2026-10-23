import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { BrainExport } from "@vectordevai/core/brain/export"
import { SPEC_V1 } from "./fixture/documents"
import { added, text, withKnowledge, type Setup } from "./fixture/knowledge"

// Export and import of memory (section 6.5): the CLI and Settings share one export, a page to read or JSON, and an
// import brings everything in waiting for the user's approval.

const own = (setup: Setup, kind: "preference" | "decision" | "term" | "fact", body: string, scope: "personal" | "repository" = "personal") =>
  setup.brain.propose(setup.place, { kind, text: body, scope, origin: "user", evidence: { type: "user" } })

const fill = (setup: Setup) =>
  Effect.gen(function* () {
    yield* own(setup, "preference", "I prefer tables for comparisons")
    yield* own(setup, "term", "When I say ship it, I mean open a PR, wait for CI, then merge")
    yield* own(setup, "decision", "Keep the billing retries in the worker", "repository")
    yield* setup.brain.propose(setup.place, {
      kind: "preference",
      text: "Always run bun test before committing",
      scope: "personal",
      origin: "agent",
      evidence: { type: "message", quote: "Always run bun test before committing", verified: true },
      sessionID: "ses_1",
    })
    yield* added(setup, text("Auth spec.md", SPEC_V1))
  })

describe("BrainExport.render", () => {
  test("Markdown has a section per kind with facets, scopes and evidence, then the documents' records", async () => {
    const page = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* fill(setup)
        return yield* BrainExport.render({ brain: setup.brain, knowledge: setup.knowledge, place: setup.place, scope: "all", format: "markdown" })
      }),
    )
    expect(page).toStartWith("# Vector memory\n")
    expect(page).toContain("## Preferences")
    expect(page).toMatch(/- \*\*m\w+\*\* I prefer tables for comparisons _\(personal, format\)_/)
    expect(page).toContain("## Terms")
    expect(page).toContain("ship it")
    expect(page).toContain('message: "Always run bun test before committing"')
    expect(page).toContain("## Decisions")
    expect(page).toContain("## Documents")
    expect(page).toContain("### ")
  })

  test("a personal export holds the user's own entries and no repository entry or document", async () => {
    const file = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* fill(setup)
        return yield* BrainExport.collect({ brain: setup.brain, knowledge: setup.knowledge, place: setup.place, scope: "personal" })
      }),
    )
    expect(file.entries.every((entry) => entry.scope === "personal")).toBe(true)
    expect(file.entries.map((entry) => entry.text)).not.toContain("Keep the billing retries in the worker")
    expect(file.documents).toEqual([])
  })
})

describe("BrainExport.importText", () => {
  test("a JSON export imported into another brain lands every entry proposed, and none is used until approved", async () => {
    const json = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* fill(setup)
        return yield* BrainExport.render({ brain: setup.brain, knowledge: setup.knowledge, place: setup.place, scope: "all", format: "json" })
      }),
    )
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const imported = yield* BrainExport.importText({ brain: setup.brain, place: setup.place, text: json })
        const recalled = yield* setup.brain.recall(setup.place, { query: "tables comparisons", budget: 300, personal: true })
        const preference = imported.entries.find((entry) => entry.kind === "preference" && entry.text.includes("tables"))!
        yield* setup.brain.update(setup.place, preference.id, { action: "approve" }, "user")
        const approved = yield* setup.brain.recall(setup.place, { query: "tables comparisons", budget: 300, personal: true })
        const again = yield* BrainExport.importText({ brain: setup.brain, place: setup.place, text: json })
        return { imported, recalled, approved, again }
      }),
    )
    expect(result.imported.entries.map((entry) => [entry.kind, entry.status, entry.origin])).toEqual([
      ["preference", "proposed", "import"],
      ["preference", "proposed", "import"],
      ["term", "proposed", "import"],
      ["decision", "proposed", "import"],
    ])
    expect(result.imported.entries.find((entry) => entry.kind === "term")?.term?.key).toBe("ship it")
    expect(result.imported.entries.find((entry) => entry.kind === "decision")?.scope).toBe("repository")
    expect(result.recalled.ids).toEqual([])
    expect(result.approved.text).toContain("I prefer tables for comparisons")
    // The same file again changes nothing: its entries are known.
    expect(result.again.entries).toEqual([])
    expect(result.again.known).toBe(4)
  })

  test("a Markdown list is read by its headings, and forgotten entries are not imported again", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const forgotten = yield* own(setup, "preference", "I prefer long answers")
        if (forgotten.type !== "refused") yield* setup.brain.forget(setup.place, forgotten.entry.id)
        return yield* BrainExport.importText({
          brain: setup.brain,
          place: setup.place,
          text: [
            "# My notes",
            "",
            "## Preferences",
            "- I prefer bullet points over prose",
            "- I prefer long answers",
            "  - 2026-01-01 | user",
            "## Rules",
            "- Never force-push",
            "## Lessons",
            "- **m1a2b3** Flaky payment tests mean a stale fixture _(repository, archived)_",
            "- Run the migrations before the seed _(repository)_",
          ].join("\n"),
        })
      }),
    )
    expect(result.entries.map((entry) => [entry.kind, entry.text, entry.scope, entry.status])).toEqual([
      ["preference", "I prefer bullet points over prose", "personal", "proposed"],
      ["lesson", "Run the migrations before the seed", "repository", "proposed"],
    ])
    expect(result.refused).toBe(1)
  })
})
