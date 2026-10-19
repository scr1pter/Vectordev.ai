import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { SPEC_V1, SPEC_V2 } from "./fixture/documents"
import { added, text, withKnowledge, type Setup } from "./fixture/knowledge"

type Row = { id: string; item: number; kind: string; card: string; changed: number | null; status: string; uses: number }

const records = (setup: Setup) =>
  setup.db.all<Row>(sql`
    SELECT r.id, r.item, r.kind, r.card, r.changed_version AS changed, i.status, i.uses
    FROM brain_record r JOIN brain_item i ON i.id = r.item ORDER BY r.id`)

// The second version drops the glossary and adds a section.
const SPEC_V3 = SPEC_V2.replace(/## Glossary[\s\S]*?(?=## 1)/, "").concat(
  "\n## 4 Audit\n\nEvery refresh MUST be written to the audit log.\n",
)

describe("BrainKnowledge versions", () => {
  test("a new version keeps the ids, rows and counts of what it still says, and marks what changed", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const first = yield* added(setup, text("Auth spec.md", SPEC_V1))
        const before = yield* records(setup)
        // Each record was used once by a session.
        yield* setup.db.run(sql`UPDATE brain_item SET uses = 1`)
        const second = yield* added(setup, text("auth spec.md", SPEC_V2))
        const after = yield* records(setup)
        const events = yield* setup.db.all<{ entry: string; detail: string }>(
          sql`SELECT entry_id AS entry, detail FROM brain_event WHERE action = 'changed'`,
        )
        const documents = yield* setup.db.all<{ id: string; status: string; version: number }>(
          sql`SELECT id, status, version FROM brain_document ORDER BY version`,
        )
        return { first, second, before, after, events, documents }
      }),
    )
    expect(result.second.result).toMatchObject({ type: "version", previous: result.first.document!.id })
    expect(result.second.document).toMatchObject({ version: 2, previous: result.first.document!.id, status: "searchable" })
    expect(result.documents.map((row) => [row.version, row.status])).toEqual([
      [1, "superseded"],
      [2, "searchable"],
    ])
    // Reworded and reordered, the spec still says the same things, so its records keep their ids and rows.
    const ids = (rows: readonly Row[]) => rows.map((row) => row.id)
    expect(ids(result.after)).toEqual(expect.arrayContaining(ids(result.before)))
    const kept = result.after.filter((row) => ids(result.before).includes(row.id))
    expect(kept.every((row) => row.uses === 1)).toBe(true)
    expect(kept.map((row) => row.item)).toEqual(
      result.before.filter((row) => kept.some((item) => item.id === row.id)).map((row) => row.item),
    )
    // "at most 3 times" became "at most 5 times": the same record, changed in version 2, with its history.
    const retry = result.after.find((row) => row.card.includes("at most 5 times"))!
    expect(ids(result.before)).toContain(retry.id)
    expect(retry.changed).toBe(2)
    expect(result.events.map((event) => event.entry)).toContain(retry.id)
    expect(result.events.find((event) => event.entry === retry.id)!.detail).toContain("at most 3 times")
  })

  test("an unchanged passage keeps its row, now the new version's", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, text("Auth spec.md", SPEC_V1))
        const before = yield* setup.db.all<{ id: string; item: number }>(sql`SELECT id, item FROM brain_passage`)
        const second = yield* added(setup, text("Auth spec.md", `${SPEC_V1}\n## 4 Audit\n\nEvery refresh MUST be written to the audit log.\n`))
        const after = yield* setup.db.all<{ id: string; item: number; document: string }>(
          sql`SELECT id, item, document_id AS document FROM brain_passage`,
        )
        return { before, after, second: second.document!.id }
      }),
    )
    const same = result.after.filter((row) => result.before.some((item) => item.id === row.id))
    expect(same.length).toBeGreaterThan(0)
    expect(same.length).toBeLessThan(result.after.length)
    expect(same.every((row) => row.document === result.second)).toBe(true)
    expect(same.every((row) => result.before.find((item) => item.id === row.id)!.item === row.item)).toBe(true)
  })

  test("a record a new version no longer says is kept, archived, and is not recalled", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, text("Auth spec.md", SPEC_V1))
        const before = yield* records(setup)
        yield* added(setup, text("Auth spec.md", SPEC_V3))
        const after = yield* records(setup)
        const recall = yield* setup.knowledge.recall(setup.place, {
          query: "what does SLO stand for, the service level objective?",
          files: [],
          tier: "standard",
          tight: false,
          personal: true,
          exclude: new Set(),
        })
        return { before, after, recall }
      }),
    )
    const term = result.before.find((row) => row.kind === "term")!
    expect(result.after.find((row) => row.id === term.id)?.status).toBe("archived")
    expect(result.after.some((row) => row.card.includes("audit log") && row.status === "active")).toBe(true)
    expect(result.recall.cards).not.toContain(term.id)
  })
})
