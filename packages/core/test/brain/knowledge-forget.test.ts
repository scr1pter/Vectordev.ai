import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { SPEC_V1, SPEC_V2 } from "./fixture/documents"
import { added, text, withKnowledge, type Setup } from "./fixture/knowledge"

const TABLES = [
  "brain_document",
  "brain_section",
  "brain_item",
  "brain_passage",
  "brain_record",
  "brain_term",
  "brain_posting",
  "brain_job",
  "brain_use",
  "brain_event",
] as const

const counts = (setup: Setup) =>
  Effect.gen(function* () {
    const rows = yield* setup.db.all<{ name: string; count: number }>(
      sql.raw(TABLES.map((table) => `SELECT '${table}' AS name, count(*) AS count FROM ${table}`).join(" UNION ALL ")),
    )
    return Object.fromEntries(rows.map((row) => [row.name, row.count]))
  })

const ask = (query: string) => ({
  query,
  files: [],
  tier: "standard" as const,
  tight: false,
  personal: true,
  exclude: new Set<string>(),
  sessionID: "ses_1",
})

describe("BrainKnowledge.remove", () => {
  test("forgetting a document removes every row of it and of its earlier versions", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const empty = yield* counts(setup)
        yield* added(setup, text("Auth spec.md", SPEC_V1))
        const second = yield* added(setup, text("Auth spec.md", SPEC_V2))
        const recalled = yield* setup.knowledge.recall(setup.place, ask("what is the refresh token TTL?"))
        // A card the session was shown, and a get, leave use rows; the version left change history.
        const lines = yield* setup.knowledge.lines(setup.place, recalled.cards, { personal: true, sessionID: "ses_1" })
        yield* setup.knowledge.get(setup.place, { id: recalled.cards[0]!, budget: 600, personal: true, sessionID: "ses_1" })
        const before = yield* counts(setup)
        const removed = yield* setup.knowledge.remove(setup.place, second.document!.id)
        const after = yield* counts(setup)
        const state = yield* setup.db.get<{ items: number; length: number }>(
          sql`SELECT items, item_length_sum AS length FROM brain_state WHERE repository_id = 'repo-1'`,
        )
        return {
          empty,
          before,
          removed,
          after,
          state,
          shown: lines.size,
          lines: yield* setup.knowledge.lines(setup.place, recalled.cards, { personal: true, sessionID: "ses_1" }),
          recall: yield* setup.knowledge.recall(setup.place, ask("what is the refresh token TTL?")),
          again: yield* setup.knowledge.remove(setup.place, second.document!.id),
        }
      }),
    )
    expect(result.before.brain_document).toBe(2)
    expect(result.before.brain_posting).toBeGreaterThan(0)
    expect(result.before.brain_use).toBeGreaterThan(0)
    expect(result.before.brain_event).toBeGreaterThan(0)
    expect(result.shown).toBeGreaterThan(0)
    expect(result.removed).toBe("removed")
    expect(result.after).toEqual(result.empty)
    expect(result.state).toEqual({ items: 0, length: 0 })
    // Not even a session that was shown its cards gets them again.
    expect(result.lines.size).toBe(0)
    expect(result.recall.text ?? "").toBe("")
    expect(result.again).toBe("not-found")
  })

  test("a forgotten document is not added back by a chat or the agent, but the user can add it again", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const first = yield* added(setup, text("Auth spec.md", SPEC_V1))
        yield* setup.knowledge.remove(setup.place, first.document!.id)
        return {
          chat: yield* setup.knowledge.add(setup.place, { ...text("Auth spec.md", SPEC_V1), origin: "chat" }),
          agent: yield* setup.knowledge.add(setup.place, { ...text("Auth spec.md", SPEC_V1), origin: "agent" }),
          upload: (yield* added(setup, text("Auth spec.md", SPEC_V1))).document?.status,
          later: yield* setup.knowledge.add(setup.place, { ...text("Auth copy.md", SPEC_V1), origin: "chat" }),
        }
      }),
    )
    expect(result.chat).toMatchObject({ type: "refused", reason: "forgotten" })
    expect(result.agent).toMatchObject({ type: "refused", reason: "forgotten" })
    expect(result.upload).toBe("searchable")
    // Added again by the user, it is simply here.
    expect(result.later.type).toBe("unchanged")
  })
})
