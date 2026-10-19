import { describe, expect, test } from "bun:test"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainCredit } from "@vectordevai/core/brain/credit"
import { Token } from "@vectordevai/core/util/token"
import { SPEC_V1 } from "./fixture/documents"
import { added, text, withKnowledge, type Setup } from "./fixture/knowledge"

const DAY = 24 * 60 * 60 * 1000

type Counts = { ref: string; helpful: number; harmful: number; ignored: number; last: number | null }

const counts = (setup: Setup) =>
  setup.db.all<Counts>(sql`SELECT ref, helpful, harmful, ignored, last_helpful_at AS last FROM brain_item ORDER BY ref`)

const entry = (setup: Setup, id: string) =>
  setup.db.get<{ helpful: number; harmful: number }>(sql`SELECT helpful, harmful FROM brain_entry WHERE id = ${id}`)

// A record of the spec, by the words of its card.
const recordOf = (setup: Setup, query: string) =>
  setup.knowledge
    .records(setup.place, { query, personal: true })
    .pipe(Effect.map((page) => page.records[0]!))

const lesson = (setup: Setup, words: string) =>
  setup.brain
    .propose(setup.place, { kind: "lesson", text: words, scope: "repository", origin: "user" })
    .pipe(Effect.map((result) => (result.type === "refused" ? "" : result.entry.id)))

describe("BrainCredit", () => {
  test("proven stays within its bounds and moves 0.08 per run", () => {
    expect(BrainCredit.proven({ helpful: 0, harmful: 0, ignored: 0 })).toBe(1)
    expect(BrainCredit.proven({ helpful: 1, harmful: 0, ignored: 0 })).toBeCloseTo(1.08)
    expect(BrainCredit.proven({ helpful: 2, harmful: 1, ignored: 0 })).toBeCloseTo(1.08)
    expect(BrainCredit.proven({ helpful: 0, harmful: 0, ignored: 3 })).toBeCloseTo(0.94)
    // Ignored counts no more than 10 times, and credit never passes 0.7 or 1.3.
    expect(BrainCredit.proven({ helpful: 0, harmful: 0, ignored: 50 })).toBeCloseTo(0.8)
    expect(BrainCredit.proven({ helpful: 40, harmful: 0, ignored: 0 })).toBe(1.3)
    expect(BrainCredit.proven({ helpful: 0, harmful: 40, ignored: 0 })).toBe(0.7)
  })

  test("counts halve every 90 days", () => {
    expect(BrainCredit.decay(4, 90 * DAY)).toBeCloseTo(2)
    expect(BrainCredit.decay(4, 180 * DAY)).toBeCloseTo(1)
    expect(BrainCredit.decay(4, 45 * DAY)).toBeCloseTo(4 / Math.SQRT2)
    expect(BrainCredit.decay(4, 0)).toBe(4)
    expect(BrainCredit.decay(0, 90 * DAY)).toBe(0)
  })

  test("credit never lifts held content or content under the confidence floor", () => {
    const strong = { helpful: 5, harmful: 0, ignored: 0 }
    expect(BrainCredit.lift(strong, { confidence: 0.9 })).toBeCloseTo(1.3)
    expect(BrainCredit.lift(strong, { confidence: 0.5 })).toBe(1)
    expect(BrainCredit.lift(strong, { confidence: 0.9, held: true })).toBe(1)
    // What the user marked wrong still weighs it down.
    expect(BrainCredit.lift({ helpful: 0, harmful: 2, ignored: 0 }, { confidence: 0.5 })).toBeCloseTo(0.84)
  })
})

describe("BrainKnowledge.credit", () => {
  test("a cited card in a run that passed gains one; one only recalled gains nothing", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, text("Auth spec.md", SPEC_V1))
        const retry = yield* recordOf(setup, "retry 429")
        const upload = yield* recordOf(setup, "uploads 50 MB")
        const credited = yield* setup.knowledge.credit(setup.place, {
          sessionID: "ses_a",
          requestID: "msg_1",
          outcome: "pass",
          delivered: [retry.id, upload.id],
          cited: [retry.id],
          fetched: [],
          edited: [],
        })
        // Crediting the same request again changes nothing.
        const again = yield* setup.knowledge.credit(setup.place, {
          sessionID: "ses_a",
          requestID: "msg_1",
          outcome: "pass",
          delivered: [retry.id, upload.id],
          cited: [retry.id],
          fetched: [],
          edited: [],
        })
        const after = yield* counts(setup)
        const record = yield* setup.knowledge.record(setup.place, retry.id, { personal: true })
        return { retry, upload, credited, again, after, record }
      }),
    )
    expect(result.credited).toMatchObject({ helpful: 1, skipped: false })
    expect(result.again.skipped).toBe(true)
    expect(result.after.find((row) => row.ref === result.retry.id)).toMatchObject({ helpful: 1, harmful: 0 })
    expect(result.after.find((row) => row.ref === result.retry.id)!.last).not.toBeNull()
    expect(result.after.find((row) => row.ref === result.upload.id)).toMatchObject({ helpful: 0, harmful: 0 })
    // "Used in 1 run · 1 passed" on its card.
    expect(result.record!.record).toMatchObject({ runs: 1, passed: 1 })
  })

  test("a run with no check that went green records the citation and gains nothing; a made-up citation counts not at all", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, text("Auth spec.md", SPEC_V1))
        const retry = yield* recordOf(setup, "retry 429")
        const upload = yield* recordOf(setup, "uploads 50 MB")
        yield* setup.knowledge.credit(setup.place, {
          sessionID: "ses_a",
          requestID: "msg_1",
          outcome: "none",
          delivered: [retry.id],
          // The upload record was never given to the run.
          cited: [retry.id, upload.id],
          fetched: [],
          edited: [],
        })
        return { retry, upload, after: yield* counts(setup), uses: yield* setup.db.all(sql`SELECT entry_id, cited, outcome FROM brain_use`) }
      }),
    )
    expect(result.after.every((row) => row.helpful === 0)).toBe(true)
    expect(result.uses).toEqual([{ entry_id: result.retry.id, cited: 1, outcome: null }])
  })

  test("opening a card with get counts as using it, and a memory entry it cited gains one too", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, text("Auth spec.md", SPEC_V1))
        const retry = yield* recordOf(setup, "retry 429")
        const id = yield* lesson(setup, "Run the auth tests one file at a time from packages/core.")
        yield* setup.knowledge.credit(setup.place, {
          sessionID: "ses_a",
          requestID: "msg_1",
          outcome: "pass",
          delivered: [id],
          cited: [id],
          fetched: [retry.id],
          edited: [],
        })
        return { retry, item: (yield* counts(setup)).find((row) => row.ref === retry.id), entry: yield* entry(setup, id) }
      }),
    )
    expect(result.item).toMatchObject({ helpful: 1 })
    expect(result.entry).toEqual({ helpful: 1, harmful: 0 })
  })

  test("a revert takes the credit back: the cited record counts it as harmful, the entry never does", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, text("Auth spec.md", SPEC_V1))
        const retry = yield* recordOf(setup, "retry 429")
        const upload = yield* recordOf(setup, "uploads 50 MB")
        const id = yield* lesson(setup, "Run the auth tests one file at a time from packages/core.")
        yield* setup.knowledge.credit(setup.place, {
          sessionID: "ses_a",
          requestID: "msg_1",
          outcome: "pass",
          delivered: [retry.id, upload.id, id],
          cited: [retry.id, id],
          fetched: [upload.id],
          edited: [],
        })
        const reverted = yield* setup.knowledge.reverted(setup.place, { sessionID: "ses_a", requests: ["msg_1"] })
        // A second revert of the same request changes nothing more.
        const twice = yield* setup.knowledge.reverted(setup.place, { sessionID: "ses_a", requests: ["msg_1"] })
        const items = yield* counts(setup)
        // Tidying archives an entry more often harmful than helpful; a reverted run must not set that off.
        yield* setup.brain.consolidate(setup.place, { force: true })
        const status = yield* setup.db.get<{ status: string }>(sql`SELECT status FROM brain_entry WHERE id = ${id}`)
        const record = yield* setup.knowledge.record(setup.place, retry.id, { personal: true })
        return { retry, upload, reverted, twice, items, entry: yield* entry(setup, id), status, record }
      }),
    )
    expect(result.reverted).toBe(3)
    expect(result.twice).toBe(0)
    expect(result.items.find((row) => row.ref === result.retry.id)).toMatchObject({ helpful: 0, harmful: 1 })
    // Only opened, not cited: the credit goes back and nothing counts against it.
    expect(result.items.find((row) => row.ref === result.upload.id)).toMatchObject({ helpful: 0, harmful: 0 })
    expect(result.entry).toEqual({ helpful: 0, harmful: 0 })
    expect(result.status).toEqual({ status: "active" })
    // A record is never put away for it either: that stays the user's call.
    expect(result.record!.record.status).toBe("active")
    expect(result.record!.record).toMatchObject({ runs: 1, passed: 0 })
  })

  test("a card given five times and never used is counted as ignored, and drops in value", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, text("Auth spec.md", SPEC_V1))
        const retry = yield* recordOf(setup, "retry 429")
        const upload = yield* recordOf(setup, "uploads 50 MB")
        yield* setup.db.run(sql`UPDATE brain_item SET uses = 5 WHERE ref IN (${retry.id}, ${upload.id})`)
        const credited = yield* setup.knowledge.credit(setup.place, {
          sessionID: "ses_a",
          requestID: "msg_1",
          outcome: "none",
          delivered: [retry.id, upload.id],
          cited: [retry.id],
          fetched: [],
          edited: [],
        })
        return { retry, upload, credited, items: yield* counts(setup) }
      }),
    )
    expect(result.credited.ignored).toBe(1)
    expect(result.items.find((row) => row.ref === result.upload.id)!.ignored).toBe(1)
    // Cited, so not ignored, though nothing passed.
    expect(result.items.find((row) => row.ref === result.retry.id)!.ignored).toBe(0)
  })

  test("a cited record is linked to the files a passing run changed, and the link goes with a revert", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          yield* added(setup, text("Auth spec.md", SPEC_V1))
          const retry = yield* recordOf(setup, "retry 429")
          const credit = (requestID: string, edited: string[]) =>
            setup.knowledge.credit(setup.place, {
              sessionID: "ses_a",
              requestID,
              outcome: "pass",
              delivered: [retry.id],
              cited: [retry.id],
              fetched: [],
              edited,
            })
          const credited = yield* credit("msg_1", [path.join(setup.root, "src", "retry.ts"), "../outside.ts", "src/missing.ts"])
          const anchors = yield* setup.db.all(
            sql`SELECT owner, path, method, weight, origin, status FROM brain_anchor WHERE origin = 'outcome'`,
          )
          yield* setup.knowledge.reverted(setup.place, { sessionID: "ses_a", requests: ["msg_1"] })
          const gone = yield* setup.db.all(sql`SELECT owner FROM brain_anchor WHERE origin = 'outcome'`)
          return { retry, credited, anchors, gone }
        }),
      { files: { "src/retry.ts": "export const MAX_RETRIES = 3\n" } },
    )
    expect(result.credited.applied).toBe(1)
    expect(result.anchors).toEqual([
      { owner: result.retry.id, path: "src/retry.ts", method: "outcome", weight: 0.5, origin: "outcome", status: "fresh" },
    ])
    expect(result.gone).toEqual([])
  })

  test("two credits of one request that end together count it once", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          yield* added(setup, text("Auth spec.md", SPEC_V1))
          const retry = yield* recordOf(setup, "retry 429")
          const credit = () =>
            setup.knowledge.credit(setup.place, {
              sessionID: "ses_a",
              requestID: "msg_1",
              outcome: "pass",
              delivered: [retry.id],
              cited: [retry.id],
              fetched: [],
              edited: [path.join(setup.root, "src", "retry.ts")],
            })
          const both = yield* Effect.all([credit(), credit()], { concurrency: "unbounded" })
          return {
            retry,
            both,
            items: yield* counts(setup),
            events: yield* setup.db.all(sql`SELECT entry_id FROM brain_event WHERE action = 'credited'`),
            anchors: yield* setup.db.all(sql`SELECT path FROM brain_anchor WHERE origin = 'outcome'`),
          }
        }),
      { files: { "src/retry.ts": "export const MAX_RETRIES = 3\n" } },
    )
    expect(result.both.map((credited) => credited.skipped).toSorted()).toEqual([false, true])
    expect(result.items.find((row) => row.ref === result.retry.id)!.helpful).toBe(1)
    expect(result.events).toHaveLength(1)
    expect(result.anchors).toHaveLength(1)
  })

  test("a credited card outranks an otherwise equal one in recall, and an entry's credit decays at tidying", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const id = yield* lesson(setup, "Run the auth tests one file at a time from packages/core.")
        yield* setup.brain.credit([id], 2)
        const proven = (yield* setup.brain.candidates(setup.place, { query: "run the auth tests", personal: true }))[0]!
        // Tidying 90 days after the last pass halves the count.
        yield* setup.brain.consolidate(setup.place, { force: true })
        yield* setup.db.run(sql`UPDATE brain_state SET consolidated_at = consolidated_at - ${90 * DAY}`)
        yield* setup.brain.consolidate(setup.place, { force: true })
        return { proven, entry: yield* entry(setup, id) }
      }),
    )
    expect(result.proven.proven).toBeCloseTo(1.16)
    expect(result.entry!.helpful).toBeCloseTo(1, 1)
  })
})

describe("proven knowledge in recall", () => {
  test("of two cards that match a request alike, the one runs proved useful goes first", async () => {
    const SPEC = `# Limits

## Retries

Clients MUST retry the upload at most 3 times.

## Backoff

Clients MUST retry the upload after a backoff of 2 seconds.
`
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, text("Limits.md", SPEC))
        const ask = (budget?: number) =>
          setup.knowledge.recall(setup.place, {
            query: "how should clients retry the upload?",
            files: [],
            tier: "standard",
            tight: false,
            personal: true,
            exclude: new Set(),
            ...(budget ? { budget } : {}),
          })
        const both = yield* ask()
        // Room for the wrapper and one card only.
        const lines = both.text!.split("\n").filter((line) => both.cards.some((id) => line.includes(`[${id}]`)))
        const room =
          Token.estimate(Brain.recallText(["-"], { newest: true, documents: true })) +
          Math.max(...lines.map((line) => Token.estimate(`${line}\n`)))
        const before = yield* ask(room)
        const other = both.cards.find((id) => !before.cards.includes(id))!
        yield* setup.db.run(sql`UPDATE brain_item SET helpful = 4 WHERE ref = ${other}`)
        const after = yield* ask(room)
        return { both, before, after, other }
      }),
    )
    expect(result.both.cards.length).toBeGreaterThanOrEqual(2)
    expect(result.before.cards).toHaveLength(1)
    expect(result.after.cards).toEqual([result.other])
  })
})
