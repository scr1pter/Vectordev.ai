import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { BrainWorker } from "@vectordevai/core/brain/worker/host"
import { SPEC_V1 } from "./fixture/documents"
import { added, countingWorker, placeFor, services, text, withKnowledge } from "./fixture/knowledge"
import { lines, pdf } from "./fixture/pdf"
import { tmpdir } from "../fixture/tmpdir"

describe("BrainKnowledge.add", () => {
  test("a spec becomes a searchable document of sections, passages, records and keyword postings", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const { result, document } = yield* added(setup, text("Auth spec.md", SPEC_V1))
        const rows = yield* setup.db.all<{ table: string; count: number }>(sql`
          SELECT 'sections' AS "table", count(*) AS count FROM brain_section
          UNION ALL SELECT 'passages', count(*) FROM brain_passage
          UNION ALL SELECT 'records', count(*) FROM brain_record
          UNION ALL SELECT 'items', count(*) FROM brain_item
          UNION ALL SELECT 'postings', count(*) FROM brain_posting
          UNION ALL SELECT 'jobs', count(*) FROM brain_job`)
        const state = yield* setup.db.get<{ items: number; length: number; revision: number }>(
          sql`SELECT items, item_length_sum AS length, knowledge_revision AS revision FROM brain_state WHERE repository_id = 'repo-1'`,
        )
        const df = yield* setup.db.get<{ df: number }>(
          sql`SELECT df FROM brain_term WHERE repository_id = 'repo-1' AND term = 'refresh'`,
        )
        return {
          result,
          document,
          counts: Object.fromEntries(rows.map((row) => [row.table, row.count])),
          state,
          df,
          listed: yield* setup.knowledge.documents(setup.place, { personal: true }),
        }
      }),
    )
    expect(result.result.type).toBe("queued")
    expect(result.document).toMatchObject({
      title: "Auth spec",
      format: "markdown",
      origin: "upload",
      visibility: "private",
      status: "searchable",
      version: 1,
      ordinal: 1,
    })
    expect(result.document!.stats.records).toBeGreaterThan(3)
    expect(result.document!.stats.kinds.requirement).toBeGreaterThan(0)
    expect(result.counts.records).toBe(result.document!.stats.records)
    expect(result.counts.items).toBe(result.counts.records! + result.counts.passages!)
    expect(result.counts.postings).toBeGreaterThan(result.counts.items!)
    // The job is done and gone; the index knows how many items it holds and how long they are.
    expect(result.counts.jobs).toBe(0)
    expect(result.state!.items).toBe(result.counts.items)
    expect(result.state!.length).toBeGreaterThan(0)
    expect(result.df!.df).toBeGreaterThan(0)
    expect(result.listed.map((document) => document.id)).toEqual([result.document!.id])
  })

  test("the same bytes again are the same document", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const first = yield* added(setup, text("Auth spec.md", SPEC_V1))
        const second = yield* setup.knowledge.add(setup.place, { ...text("auth-copy.md", SPEC_V1), origin: "cli" })
        return { first: first.document!.id, second }
      }),
    )
    expect(result.second).toMatchObject({ type: "unchanged", document: { id: result.first } })
  })

  test("a PDF keeps its pages", async () => {
    const bytes = pdf({
      pages: [
        { runs: [{ text: "Upload guide", x: 72, y: 740, size: 20, font: "bold" }, ...lines(["Uploads are limited to 50 MB per file."], { top: 700 })] },
        { runs: lines(["Clients MUST retry at most 3 times after a 429 response."]) },
      ],
    })
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const { document } = yield* added(setup, { type: "bytes", name: "upload.pdf", bytes, origin: "upload" })
        const pages = yield* setup.db.all<{ page: number }>(sql`SELECT DISTINCT page FROM brain_record ORDER BY page`)
        return { document, pages: pages.map((row) => row.page) }
      }),
    )
    expect(result.document).toMatchObject({ format: "pdf", pages: 2, status: "searchable" })
    expect(result.pages).toEqual([1, 2])
  })

  test("files that are not documents are refused before anything is stored", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          const add = (input: Parameters<typeof setup.knowledge.add>[1]) => setup.knowledge.add(setup.place, input)
          return {
            secret: yield* add({ type: "path", path: ".env", origin: "agent" }),
            program: yield* add({ type: "bytes", name: "tool", bytes: new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1]), origin: "upload" }),
            empty: yield* add({ type: "bytes", name: "empty.md", bytes: new Uint8Array(), origin: "upload" }),
            missing: yield* add({ type: "path", path: "docs/missing.md", origin: "agent" }),
            folder: yield* add({ type: "path", path: "docs", origin: "agent" }),
            guest: yield* add({ ...text("notes.md", SPEC_V1), hold: "guest" }),
            documents: yield* setup.knowledge.documents(setup.place, { personal: true }),
          }
        }),
      { files: { ".env": "TOKEN=abc", "docs/readme.md": "# Docs" } },
    )
    expect(result.secret).toMatchObject({ type: "refused", reason: "secret" })
    expect(result.program).toMatchObject({ type: "refused", reason: "unsupported" })
    expect(result.empty).toMatchObject({ type: "refused", reason: "empty" })
    expect(result.missing).toMatchObject({ type: "refused", reason: "not-found" })
    expect(result.folder).toMatchObject({ type: "refused", reason: "not-found" })
    expect(result.guest).toMatchObject({ type: "refused", reason: "guest" })
    expect(result.documents).toEqual([])
  })

  test("a file added by path is read from where it really is, and is the user's own", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          const { document } = yield* added(setup, { type: "path", path: "specs/auth.md", origin: "agent" })
          return document
        }),
      { files: { "specs/auth.md": SPEC_V1 } },
    )
    expect(result).toMatchObject({ name: "auth.md", origin: "agent", visibility: "private", status: "searchable" })
    expect(result!.sourcePath).toEndWith(path.join("specs", "auth.md"))
  })

  test("more than 20 documents a minute are refused", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const results = yield* Effect.forEach(Array.from({ length: 21 }, (_, index) => index), (index) =>
          setup.knowledge.add(setup.place, text(`note ${index}.md`, `# Note ${index}\n\nThe service MUST log request ${index}.`)),
        )
        return results.map((item) => item.type)
      }),
    )
    expect(result.slice(0, 20).every((type) => type === "queued")).toBe(true)
    expect(result[20]).toBe("refused")
  })

  test("a job leased by one process is never read by another, and one left behind is taken over", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "repo")
    await fs.mkdir(path.join(root, "specs"), { recursive: true })
    await fs.writeFile(path.join(root, "specs", "auth.md"), SPEC_V1)
    const file = path.join(tmp.path, "data", "brain", "brain.db")
    const place = placeFor(root)
    const first: string[] = []
    const second: string[] = []
    const gate = Promise.withResolvers<void>()
    const result = await Effect.runPromise(
      services(
        place,
        (a) =>
          Effect.gen(function* () {
            const queued = yield* a.knowledge.add(place, { type: "path", path: "specs/auth.md", origin: "cli" })
            if (queued.type === "refused") throw new Error(queued.message)
            // Another process on the same brain.db, with its own drainer running.
            const other = yield* services(
              place,
              (b) =>
                Effect.gen(function* () {
                  yield* b.knowledge.add(place, text("other.md", "# Other\n\nThe service MUST log every request."))
                  yield* Effect.sleep("300 millis")
                  return yield* b.knowledge.documents(place, { personal: true })
                }),
              { file, dir: tmp.path, worker: countingWorker(second), owner: "b" },
            )
            gate.resolve()
            const done = yield* a.knowledge.wait(place, queued.document.id, "searchable", 10_000)
            return { other, done, id: queued.document.id }
          }),
        { file, dir: tmp.path, worker: countingWorker(first, gate.promise), owner: "a" },
      ),
    )
    expect(first).toEqual([result.id])
    expect(second).not.toContain(result.id)
    expect(result.done?.status).toBe("searchable")

    // A process that stopped mid-read leaves its lease to run out; the next one reads the file again from its path.
    const left = await Effect.runPromise(
      services(
        place,
        (c) =>
          Effect.gen(function* () {
            yield* c.db.run(sql`UPDATE brain_document SET status = 'reading'`)
            yield* c.db.run(
              sql`INSERT INTO brain_job (id, repository_id, document_id, kind, state, lease_owner, lease_until, next_at, created_at, updated_at)
                  VALUES ('j-left', 'repo-1', ${result.id}, 'extract', 'running', 'gone', ${Date.now() - 1}, 0, 0, 0)`,
            )
            // Any add starts this process's drainer, which finds the job left behind.
            yield* c.knowledge.add(place, text("third.md", "# Third\n\nThe client MUST send a request id."))
            return yield* c.knowledge.wait(place, result.id, "searchable", 10_000)
          }),
        { file, dir: tmp.path, worker: countingWorker([]), owner: "c" },
      ),
    )
    expect(left?.status).toBe("searchable")
  }, 60_000)

  test("a document read in the background worker from source is stored the same way", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          const { document } = yield* added(setup, text("Auth spec.md", SPEC_V1))
          return { document, status: yield* setup.knowledge.worker() }
        }),
      {
        worker: BrainWorker.layer.pipe(
          Layer.provide(Layer.succeed(BrainWorker.Source, BrainWorker.Source.of({ load: Effect.succeed(undefined) }))),
        ),
      },
    )
    expect(result.status.mode).toBe("worker")
    expect(result.document?.status).toBe("searchable")
    expect(result.document?.stats.records).toBeGreaterThan(3)
  }, 60_000)
})
