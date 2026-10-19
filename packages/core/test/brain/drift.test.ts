import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { BrainAnchor } from "@vectordevai/core/brain/anchor"
import { BrainDrift } from "@vectordevai/core/brain/drift"
import { BrainAnchorTable, BrainEdgeTable } from "@vectordevai/core/brain/sql"
import { added, text, withKnowledge, type Setup } from "./fixture/knowledge"

// Whether linked code still says what it did: a moved line is fresh, a changed definition drifted and a deleted one
// missing, and a constant whose value is not the document's ("50 MB" against 64 * 1024 * 1024) is drift the user
// settles, never Vector.

const SPEC = `# Limits

## 1 Uploads

Uploads are limited to at most 50 MB per file by \`MAX_UPLOAD_BYTES\`.

## 2 Sessions

The \`refreshTokenTtl\` MUST be 14 days.
`

const SESSION = "export const refreshTokenTtl = (days: number) => days * 86_400\n"
const CODE = {
  "src/upload.ts": "// Upload limits.\nexport const MAX_UPLOAD_BYTES = 64 * 1024 * 1024\n",
  "src/auth/session.ts": SESSION,
}

const write = (setup: Setup, file: string, content: string) =>
  Effect.promise(async () => {
    // A write in the same millisecond as the last check is still a change.
    await Bun.sleep(5)
    await fs.writeFile(path.join(setup.root, file), content)
  })

const anchorFor = (setup: Setup, symbol: string) =>
  setup.db
    .select()
    .from(BrainAnchorTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.find((row) => row.symbol === symbol)!),
    )

describe("BrainDrift", () => {
  test("the evaluator reads plain arithmetic and nothing else", () => {
    expect(BrainDrift.evaluate("64 * 1024 * 1024")).toBe(67_108_864)
    expect(BrainDrift.evaluate("1_024 * (2 + 2)")).toBe(4_096)
    expect(BrainDrift.evaluate("-5 + 10 / 4")).toBe(-2.5)
    expect(BrainDrift.evaluate("30e3")).toBe(30_000)
    expect(BrainDrift.evaluate("limit * 2")).toBeUndefined()
    expect(BrainDrift.evaluate("Math.max(1, 2)")).toBeUndefined()
    expect(BrainDrift.evaluate('"50"')).toBeUndefined()
    expect(BrainDrift.evaluate("1 / 0")).toBeUndefined()
    expect(BrainDrift.evaluate("(1 + 2")).toBeUndefined()
    expect(BrainDrift.evaluate(Array.from({ length: 33 }, () => "1").join(" + "))).toBeUndefined()
  })

  test("units come from the name or a trailing comment, and a name with none is never checked", () => {
    expect(BrainDrift.unit("MAX_UPLOAD_BYTES")).toBe("B")
    expect(BrainDrift.unit("uploadLimitMb")).toBe("MB")
    expect(BrainDrift.unit("REQUEST_TIMEOUT_MS")).toBe("ms")
    expect(BrainDrift.unit("ttlSeconds")).toBe("s")
    expect(BrainDrift.unit("IDLE_MINUTES")).toBe("min")
    // "items" is not milliseconds.
    expect(BrainDrift.unit("MAX_ITEMS")).toBeUndefined()
    expect(BrainDrift.unit("LIMIT", "seconds")).toBe("s")
    expect(BrainAnchor.value("export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;", "MAX_UPLOAD_BYTES")).toEqual({
      raw: "64 * 1024 * 1024",
      value: 67_108_864,
      unit: "B",
    })
    expect(BrainAnchor.value("const LIMIT = 30 // seconds", "LIMIT")).toEqual({ raw: "30", value: 30, unit: "s" })
    expect(BrainAnchor.value("const LIMIT = compute(30)", "LIMIT")).toBeUndefined()
    expect(BrainDrift.format(67_108_864, "MB")).toBe("64 MB")
  })

  test("a moved line is fresh, a changed definition drifted, a deleted symbol missing", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          yield* added(setup, text("Limits.md", SPEC))
          const linked = yield* anchorFor(setup, "refreshTokenTtl")
          yield* write(setup, "src/auth/session.ts", `// Sessions.\n\n${SESSION}`)
          yield* setup.knowledge.drift(setup.place, { force: true })
          const moved = yield* anchorFor(setup, "refreshTokenTtl")
          yield* write(
            setup,
            "src/auth/session.ts",
            "// Sessions.\n\nexport const refreshTokenTtl = (days: number, leeway = 0) => days * 86_400 + leeway\n",
          )
          const counts = yield* setup.knowledge.drift(setup.place, { force: true })
          const changed = yield* anchorFor(setup, "refreshTokenTtl")
          const review = yield* setup.knowledge.review(setup.place)
          yield* write(setup, "src/auth/session.ts", "// Sessions live elsewhere now.\n")
          yield* setup.knowledge.drift(setup.place, { force: true })
          const gone = yield* anchorFor(setup, "refreshTokenTtl")
          yield* write(setup, "src/auth/session.ts", `// Sessions.\n\n${SESSION}`)
          yield* setup.knowledge.drift(setup.place, { force: true })
          return {
            linked,
            moved,
            counts,
            changed,
            review,
            gone,
            back: yield* anchorFor(setup, "refreshTokenTtl"),
            after: yield* setup.knowledge.review(setup.place),
          }
        }),
      { files: CODE, git: true },
    )
    expect(result.linked).toMatchObject({ line: 1, status: "fresh", method: "definition" })
    expect(result.moved).toMatchObject({ line: 3, status: "fresh" })
    expect(result.changed).toMatchObject({ line: 3, status: "drifted" })
    expect(result.counts).toMatchObject({ checked: 1, drifted: 1 })
    expect(result.review).toContainEqual(
      expect.objectContaining({
        kind: "drift",
        subject: "refreshTokenTtl",
        detail: expect.objectContaining({ type: "drifted", path: "src/auth/session.ts", line: 3 }),
      }),
    )
    expect(result.gone.status).toBe("missing")
    // Back as it was, it is fresh, and nothing about it needs a look.
    expect(result.back.status).toBe("fresh")
    expect(result.after.some((item) => item.subject === "refreshTokenTtl")).toBe(false)
  }, 30_000)

  test("a 500 KB line never stalls the check, and a line that long is never a link's line", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          yield* added(setup, text("Limits.md", SPEC))
          yield* write(
            setup,
            "src/auth/session.ts",
            `const${" ".repeat(500_000)}x\nexport const refreshTokenTtl = (days: number, leeway = 0) => days * 86_400 + leeway\n`,
          )
          const started = performance.now()
          yield* setup.knowledge.drift(setup.place, { force: true })
          const ms = performance.now() - started
          const changed = yield* anchorFor(setup, "refreshTokenTtl")
          yield* write(setup, "src/auth/session.ts", `export const refreshTokenTtl = 1 // ${"x".repeat(5_000)}\n`)
          yield* setup.knowledge.drift(setup.place, { force: true })
          return { ms, changed, long: yield* anchorFor(setup, "refreshTokenTtl") }
        }),
      { files: CODE, git: true },
    )
    expect(result.changed).toMatchObject({ line: 2, status: "drifted" })
    expect(result.ms).toBeLessThan(2_000)
    expect(result.long.status).toBe("missing")
  }, 30_000)

  test("50 MB in the document against 64 * 1024 * 1024 in the code opens a value drift, which the user settles", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          yield* added(setup, text("Limits.md", SPEC))
          const anchor = yield* anchorFor(setup, "MAX_UPLOAD_BYTES")
          const [item] = (yield* setup.knowledge.review(setup.place)).filter((row) => row.kind === "drift")
          const recalled = yield* setup.knowledge.recall(setup.place, {
            query: "how large may an upload be per file?",
            files: [],
            tier: "standard",
            tight: false,
            personal: true,
            exclude: new Set(),
          })
          const kept = yield* setup.knowledge.resolve(setup.place, item!.id, { action: "keep-code" })
          const after = yield* setup.knowledge.recall(setup.place, {
            query: "how large may an upload be per file?",
            files: [],
            tier: "standard",
            tight: false,
            personal: true,
            exclude: new Set(),
          })
          const edges = yield* setup.db.select().from(BrainEdgeTable).all().pipe(Effect.orDie)
          return { anchor, item, recalled, kept, after, edges, open: yield* setup.knowledge.review(setup.place) }
        }),
      { files: CODE, git: true },
    )
    expect(result.anchor).toMatchObject({
      method: "constant",
      weight: 0.8,
      value: { raw: "64 * 1024 * 1024", value: 67_108_864, unit: "B" },
    })
    expect(result.item).toMatchObject({
      kind: "drift",
      a: result.anchor.owner,
      detail: { type: "value", document: "50 MB", code: "64 MB", path: "src/upload.ts", line: 2, value: 67_108_864 },
    })
    expect(result.recalled.text).toContain(
      "Uploads are limited to at most 50 MB per file by MAX_UPLOAD_BYTES. (code says 64 MB)",
    )
    expect(result.kept).toMatchObject({ type: "item", item: { status: "resolved", winner: "code" } })
    const entry = result.kept?.type === "item" ? result.kept.entry : undefined
    expect(entry).toMatchObject({ kind: "decision", origin: "user", status: "active" })
    expect(entry?.text).toContain("64 MB")
    expect(result.edges).toContainEqual(
      expect.objectContaining({ source: entry!.id, target: result.anchor.owner, type: "derived_from" }),
    )
    expect(result.open.some((item) => item.kind === "drift")).toBe(false)
    expect(result.after.text ?? "").not.toContain("code says")
  }, 30_000)

  test("keeping the document leaves the code to the user and the item settled", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          yield* added(setup, text("Limits.md", SPEC))
          const [item] = (yield* setup.knowledge.review(setup.place)).filter((row) => row.kind === "drift")
          const kept = yield* setup.knowledge.resolve(setup.place, item!.id, { action: "keep-document" })
          yield* setup.knowledge.drift(setup.place, { force: true })
          return {
            item,
            kept,
            open: yield* setup.knowledge.review(setup.place),
            entries: yield* setup.brain.list(setup.place, {}),
          }
        }),
      { files: CODE, git: true },
    )
    expect(result.kept).toMatchObject({ type: "item", item: { status: "resolved", winner: result.item!.a } })
    expect(result.open.some((item) => item.kind === "drift")).toBe(false)
    expect(result.entries).toEqual([])
  }, 30_000)
})

describe("BrainKnowledge drift of records put away", () => {
  test("a record the user put away is not raised when its code changes", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          yield* added(setup, text("Limits.md", SPEC))
          const linked = yield* anchorFor(setup, "refreshTokenTtl")
          yield* setup.knowledge.changeRecord(setup.place, linked.owner, { action: "not-applicable" })
          yield* write(setup, "src/auth/session.ts", "// Sessions live elsewhere now.\n")
          yield* setup.knowledge.drift(setup.place, { force: true })
          return (yield* setup.knowledge.review(setup.place)).filter((item) => item.a === linked.owner)
        }),
      { files: CODE, git: true },
    )
    expect(result).toEqual([])
  }, 30_000)
})
