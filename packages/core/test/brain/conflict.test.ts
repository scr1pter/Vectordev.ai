import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { BrainConflict } from "@vectordevai/core/brain/conflict"
import { learn } from "./fixture/documents"
import { added, text, withKnowledge } from "./fixture/knowledge"

// Disagreements between documents, rules and memory: a value, a modality, the way round, an endpoint's method or
// status. Each one is an item for the user and never settled by Vector; the same thing said twice, or two statements
// about different things, is no disagreement at all.

const A = `# Auth spec

## 1 Sessions

Refresh tokens expire after 14 days.

Clients MUST retry failed uploads.

Sessions are created by POST /v2/sessions.

POST /v2/sessions returns 201 with the session.
`

const B = `# Auth runbook

## 1 Sessions

Refresh tokens expire after 30 days.

Clients MUST NOT retry failed uploads.

Sessions are created by PUT /v2/sessions.

POST /v2/sessions returns 200 with the session.
`

const claims = async (doc: string, at: number) =>
  (await learn(doc, `${at}.md`, { document: `d${at}` })).records.map((record) =>
    BrainConflict.fromRecord({ ...record, source: "document", at, key: record.key.replace(/#\d+$/, "") }),
  )

const fact = (id: string, text: string, at = 1) => BrainConflict.fromText({ id, source: "user", at, text })

describe("BrainConflict.compare", () => {
  test("value, modality, endpoint method and endpoint status disagreements, with the newer document preferred", async () => {
    const older = await claims(A, 1)
    const newer = await claims(B, 2)
    const found = older.flatMap((a) => newer.flatMap((b) => BrainConflict.compare(a, b) ?? []))
    expect(found.map((item) => [item.type, item.said])).toEqual([
      ["value", { a: "14 days", b: "30 days" }],
      ["modality", { a: "must", b: "must-not" }],
      ["endpoint", { a: "POST /v2/sessions", b: "PUT /v2/sessions" }],
      ["endpoint", { a: "201", b: "200" }],
    ])
    expect(found.every((item) => newer.some((claim) => claim.id === item.prefer))).toBe(true)
  })

  test("the same words the other way round disagree; a rule outranks a newer document", () => {
    const found = BrainConflict.compare(
      fact("m1", "The billing service uses the shared database."),
      fact("m2", "The billing service does not use the shared database."),
    )
    expect(found).toMatchObject({ type: "polarity", said: { a: "so", b: "not" } })
    const rule = BrainConflict.fromText({
      id: "f1",
      source: "rule",
      at: 1,
      text: "Refresh tokens expire after 7 days.",
    })
    const document = BrainConflict.fromText({
      id: "r1",
      source: "document",
      at: 9,
      text: "Refresh tokens expire after 30 days.",
    })
    expect(BrainConflict.compare(document, rule)).toMatchObject({ type: "value", prefer: "f1" })
  })

  test("the same value said twice, other subjects, and other paths are no disagreement", async () => {
    const one = await claims("# A\n\n## Limits\n\nRefresh tokens expire after 14 days.\n", 1)
    const two = await claims("# B\n\n## Limits\n\nRefresh tokens expire after 14 days.\n", 2)
    expect(BrainConflict.compare(one[0]!, two[0]!)).toBeUndefined()
    expect(
      BrainConflict.compare(
        fact("m1", "Build the site from packages/web."),
        fact("m2", "Build the site from packages/app."),
      ),
    ).toBeUndefined()
    expect(
      BrainConflict.compare(
        fact("m1", "Refresh tokens expire after 14 days."),
        fact("m2", "Access tokens are signed with ES256 keys, rotated every 30 days."),
      ),
    ).toBeUndefined()
    expect(
      BrainConflict.compare(
        fact("m1", "Uploads MUST be scanned."),
        fact("m2", "Uploads MUST be scanned before they are stored."),
      ),
    ).toBeUndefined()
  })
})

describe("BrainKnowledge conflict check", () => {
  test("two documents that disagree open items for the user, cards say so, and both go in together", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, text("Auth spec.md", A))
        yield* Effect.sleep(5)
        yield* added(setup, text("Auth runbook.md", B))
        const review = (yield* setup.knowledge.review(setup.place)).filter((item) => item.kind === "conflict")
        const recalled = yield* setup.knowledge.recall(setup.place, {
          query: "when do refresh tokens expire?",
          files: [],
          tier: "standard",
          tight: false,
          personal: true,
          exclude: new Set(),
        })
        return { review, recalled }
      }),
    )
    expect(result.review.map((item) => item.detail.type).toSorted()).toEqual([
      "endpoint",
      "endpoint",
      "modality",
      "value",
    ])
    expect(result.review.every((item) => item.status === "open")).toBe(true)
    const value = result.review.find((item) => item.detail.type === "value")!
    expect(value.detail).toMatchObject({ said: { a: "30 days", b: "14 days" }, newer: value.a, prefer: value.a })
    // Neither side is heard alone.
    expect(result.recalled.cards).toEqual(expect.arrayContaining([value.a, value.b]))
    expect(result.recalled.text).toContain(`conflicts with [${value.a}], newer`)
    expect(result.recalled.text).toContain(`conflicts with [${value.b}])`)
  }, 30_000)

  test("memory and rules are checked too; keeping one side puts the other away; a dismissed item stays dismissed", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const memory = yield* setup.brain.propose(setup.place, {
          kind: "fact",
          text: "Refresh tokens expire after 7 days.",
          scope: "repository",
          origin: "user",
        })
        yield* added(setup, text("Auth spec.md", A))
        yield* added(setup, text("Auth runbook.md", B))
        const before = (yield* setup.knowledge.review(setup.place)).filter((item) => item.kind === "conflict")
        const withMemory = before.filter(
          (item) => memory.type !== "refused" && (item.a === memory.entry.id || item.b === memory.entry.id),
        )
        const modality = before.find((item) => item.detail.type === "modality")!
        yield* setup.knowledge.resolve(setup.place, modality.id, { action: "dismiss" })
        const value = before.find(
          (item) => item.detail.type === "value" && item.a.startsWith("r") && item.b?.startsWith("r"),
        )!
        const kept = yield* setup.knowledge.resolve(setup.place, value.id, { action: "keep", winner: value.b! })
        const loser = yield* setup.knowledge.record(setup.place, value.a, { personal: true })
        // The runbook read again says the same: what the user dismissed stays dismissed.
        yield* added(setup, { ...text("Auth runbook.md", `${B}\nAn extra closing line.\n`), replace: true })
        const after = (yield* setup.knowledge.review(setup.place)).filter((item) => item.kind === "conflict")
        return { withMemory, kept, loser, after, modality }
      }),
    )
    expect(result.withMemory.length).toBe(2)
    expect(result.withMemory.every((item) => item.detail.type === "value")).toBe(true)
    expect(result.kept).toMatchObject({ type: "item", item: { status: "resolved" } })
    expect(result.loser?.record.status).toBe("archived")
    expect(result.after.some((item) => item.id === result.modality.id)).toBe(false)
  }, 30_000)
})
