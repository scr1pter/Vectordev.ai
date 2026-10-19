import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { SPEC_V1, SPEC_V2 } from "./fixture/documents"
import { added, text, withKnowledge, type Setup } from "./fixture/knowledge"

const DAY = 24 * 60 * 60 * 1000

const recordOf = (setup: Setup, query: string) =>
  setup.knowledge
    .records(setup.place, { query, personal: true })
    .pipe(Effect.map((page) => page.records[0]!))

const edges = (setup: Setup) =>
  setup.db.all<{ source: string; target: string; type: string; weight: number }>(
    sql`SELECT source, target, type, weight FROM brain_edge ORDER BY type, source, target`,
  )

describe("BrainKnowledge.consolidate", () => {
  test("records two documents say word for word are linked as the same, both ways, once", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, text("Auth spec.md", SPEC_V1))
        yield* added(setup, text("Runbook.md", "# Runbook\n\n## Limits\n\nUploads are limited to 50 MB per file.\n"))
        const first = yield* setup.knowledge.consolidate(setup.place)
        const second = yield* setup.knowledge.consolidate(setup.place)
        return { first, second, edges: yield* edges(setup) }
      }),
    )
    expect(result.first.same).toBe(1)
    expect(result.second.same).toBe(0)
    const same = result.edges.filter((edge) => edge.type === "same_as")
    expect(same).toHaveLength(2)
    expect(same[0]!.source).toBe(same[1]!.target)
    expect(same.every((edge) => edge.weight === 0.8)).toBe(true)
  })

  test("document credit halves over 90 days between passes", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, text("Auth spec.md", SPEC_V1))
        const retry = yield* recordOf(setup, "retry 429")
        yield* setup.db.run(sql`UPDATE brain_item SET helpful = 4, harmful = 2, ignored = 2 WHERE ref = ${retry.id}`)
        // The first pass starts the clock.
        yield* setup.knowledge.consolidate(setup.place)
        const start = yield* setup.db.get<{ helpful: number }>(sql`SELECT helpful FROM brain_item WHERE ref = ${retry.id}`)
        yield* setup.db.run(sql`UPDATE brain_state SET credited_at = credited_at - ${90 * DAY}`)
        yield* setup.knowledge.consolidate(setup.place)
        const after = yield* setup.db.get<{ helpful: number; harmful: number; ignored: number }>(
          sql`SELECT helpful, harmful, ignored FROM brain_item WHERE ref = ${retry.id}`,
        )
        return { start, after }
      }),
    )
    expect(result.start!.helpful).toBe(4)
    expect(result.after!.helpful).toBeCloseTo(2, 3)
    expect(result.after!.harmful).toBeCloseTo(1, 3)
    expect(result.after!.ignored).toBeCloseTo(1, 3)
  })

  test("a resolved review item goes after 180 days; a dismissed one stays", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const old = Date.now() - 200 * DAY
        for (const [id, status] of [
          ["v1", "resolved"],
          ["v2", "dismissed"],
          ["v3", "resolved"],
        ] as const)
          yield* setup.db.run(sql`
            INSERT INTO brain_review (id, repository_id, kind, a, subject, detail, status, created_at, updated_at)
            VALUES (${id}, 'repo-1', 'drift', 'rx', 'x', '{}', ${status}, ${old}, ${id === "v3" ? Date.now() : old})`)
        const done = yield* setup.knowledge.consolidate(setup.place)
        return { done, left: yield* setup.db.all<{ id: string }>(sql`SELECT id FROM brain_review ORDER BY id`) }
      }),
    )
    expect(result.done.pruned).toBe(1)
    expect(result.left.map((row) => row.id)).toEqual(["v2", "v3"])
  })
})

describe("learning from documents", () => {
  test("a quote that is not in the passage is refused; one that is, is found with its document", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, text("Auth spec.md", SPEC_V1))
        const retry = yield* recordOf(setup, "retry 429")
        const quote = (input: { id: string; quote: string; personal?: boolean }) =>
          setup.knowledge.quoted(setup.place, { personal: true, ...input })
        return {
          retry,
          made: yield* quote({ id: retry.id, quote: "Clients MUST retry at most 10 times after a 429" }),
          short: yield* quote({ id: retry.id, quote: "retry" }),
          real: yield* quote({ id: retry.id, quote: "Clients MUST   retry at most 3 times\nafter a 429 response." }),
          passage: yield* quote({ id: retry.passage, quote: "retry at most 3 times after a 429 response" }),
          guest: yield* quote({ id: retry.id, quote: "Clients MUST retry at most 3 times", personal: false }),
          missing: yield* quote({ id: "rnothing", quote: "Clients MUST retry at most 3 times" }),
        }
      }),
    )
    expect(result.made).toMatchObject({ type: "refused" })
    expect(result.short).toMatchObject({ type: "refused" })
    expect(result.real).toMatchObject({ type: "found", verified: true, document: { visibility: "private", title: "Auth spec" } })
    expect(result.passage).toMatchObject({ type: "found" })
    // A private document is no evidence where it may not be read.
    expect(result.guest).toMatchObject({ type: "refused" })
    expect(result.missing).toMatchObject({ type: "refused" })
  })

  test("an entry learned from a record is derived from it and related to the records it bears on", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, text("Auth spec.md", SPEC_V1))
        const retry = yield* recordOf(setup, "retry 429")
        const written = yield* setup.brain.propose(setup.place, {
          kind: "fact",
          text: "Clients retry at most 3 times after a 429 response.",
          scope: "repository",
          origin: "agent",
          evidence: { type: "document", path: retry.id, quote: "Clients MUST retry at most 3 times after a 429 response.", verified: true },
          private: true,
        })
        if (written.type === "refused") throw new Error(written.message)
        const made = yield* setup.knowledge.derive(setup.place, { entry: written.entry, from: retry.id })
        const detail = yield* setup.brain.get(setup.place, written.entry.id, { personal: true })
        return { retry, written, made, edges: yield* edges(setup), detail }
      }),
    )
    // Learn freely: in use at once, and as private as the document it came from.
    expect(result.written).toMatchObject({ type: "added", entry: { status: "active", private: true, confidence: 0.8 } })
    expect(result.detail!.evidence.at(-1)).toMatchObject({
      type: "document",
      path: result.retry.id,
      quote: "Clients MUST retry at most 3 times after a 429 response.",
    })
    expect(result.edges).toContainEqual({
      source: result.written.entry.id,
      target: result.retry.id,
      type: "derived_from",
      weight: 0.9,
    })
    expect(result.made).toBe(result.edges.length)
  })

  test("a document quote that does not state the memory raises nothing", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, text("Auth spec.md", SPEC_V1))
        const retry = yield* recordOf(setup, "retry 429")
        return yield* setup.brain.propose(setup.place, {
          kind: "fact",
          text: "Clients retry at most 5 times after a 429 response.",
          scope: "repository",
          origin: "agent",
          evidence: { type: "document", path: retry.id, quote: "Clients MUST retry at most 3 times after a 429 response.", verified: true },
        })
      }),
    )
    // Still learned (and the user can undo it), but on its own word: unchecked confidence.
    expect(result).toMatchObject({ type: "added", entry: { confidence: 0.5 } })
  })

  test("Make this a memory saves the user's own advisory entry with the record as evidence, derived from it", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, text("Auth spec.md", SPEC_V1))
        const record = yield* recordOf(setup, "uploads 50 MB")
        const changed = yield* setup.knowledge.changeRecord(setup.place, record.id, { action: "make-memory" })
        const entry = changed?.type === "changed" ? changed.entry : undefined
        const detail = entry ? yield* setup.brain.get(setup.place, entry.id, { personal: true }) : undefined
        return { record, entry, detail, edges: yield* edges(setup) }
      }),
    )
    expect(result.entry).toMatchObject({ origin: "user", status: "active", private: true })
    expect(["decision", "fact"]).toContain(result.entry!.kind)
    expect(result.detail!.evidence[0]).toMatchObject({ type: "document", path: result.record.id, quote: result.record.quote })
    expect(result.edges).toContainEqual({ source: result.entry!.id, target: result.record.id, type: "derived_from", weight: 0.9 })
  })
})

describe("versions and History", () => {
  test("a new version says what it added, changed and removed, keeps the user's edits and pins, and lists it in History", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, text("Auth spec.md", SPEC_V1))
        const upload = yield* recordOf(setup, "uploads 50 MB")
        const retry = yield* recordOf(setup, "retry 429")
        yield* setup.knowledge.changeRecord(setup.place, upload.id, { text: "Uploads stop at 50 MB a file." })
        yield* setup.knowledge.changeRecord(setup.place, retry.id, { pinned: true })
        const v3 = SPEC_V2.replace(/## Glossary[\s\S]*?(?=## 1)/, "").concat(
          "\n## 4 Audit\n\nEvery refresh MUST be written to the audit log.\n",
        )
        const second = yield* added(setup, text("Auth spec.md", v3))
        const detail = yield* setup.knowledge.document(setup.place, second.document!.id, { personal: true })
        return { detail, first: second.result.type === "version" ? second.result.previous : undefined, retry }
      }),
    )
    const diff = result.detail!.diff!
    expect(diff).toMatchObject({ version: 2, previous: result.first, edits: 1, pins: 1 })
    expect(diff.added.requirement).toBe(1)
    expect(diff.changed.requirement).toBeGreaterThanOrEqual(1)
    expect(diff.removed.term).toBe(1)
    expect(Object.values(diff.unchanged).reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0)
    const actions = result.detail!.history.map((event) => event.action)
    expect(actions).toEqual(expect.arrayContaining(["version", "added", "changed", "edited", "pinned"]))
    // Newest first, and record steps name their record.
    expect(result.detail!.history.map((event) => event.at)).toEqual(
      result.detail!.history.map((event) => event.at).toSorted((a, b) => b - a),
    )
    expect(result.detail!.history.find((event) => event.action === "pinned")!.record).toBe(result.retry.id)
    expect(result.detail!.usage).toEqual({ runs: 0, passed: 0, reverted: 0 })
  })

  test("History counts the runs that used the document and how many passed", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const first = yield* added(setup, text("Auth spec.md", SPEC_V1))
        const retry = yield* recordOf(setup, "retry 429")
        for (const [request, outcome] of [
          ["msg_1", "pass"],
          ["msg_2", "none"],
          ["msg_3", "pass"],
        ] as const)
          yield* setup.knowledge.credit(setup.place, {
            sessionID: "ses_a",
            requestID: request,
            outcome,
            delivered: [retry.id, retry.passage],
            cited: [retry.id],
            fetched: [retry.passage],
            edited: [],
          })
        yield* setup.knowledge.reverted(setup.place, { sessionID: "ses_a", requests: ["msg_3"] })
        return yield* setup.knowledge.document(setup.place, first.document!.id, { personal: true })
      }),
    )
    expect(result!.usage).toEqual({ runs: 3, passed: 1, reverted: 1 })
  })
})
