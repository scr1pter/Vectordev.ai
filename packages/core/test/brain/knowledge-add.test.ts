import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { eq, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { BrainJobTable } from "@vectordevai/core/brain/sql"
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

  test("the agent keeps a file by where it really is: a link out of the repository is refused unless the user attached it", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          const outside = path.join(path.dirname(setup.root), "outside-notes.md")
          yield* Effect.promise(async () => {
            await fs.writeFile(
              outside,
              "# Notes\n\nThe private ledger codename is zebrafinch and the vault opens at dawn.",
            )
            await fs.writeFile(path.join(path.dirname(setup.root), ".env"), "TOKEN=abc")
            await fs.mkdir(path.join(setup.root, "docs"), { recursive: true })
            await fs.symlink(outside, path.join(setup.root, "docs", "notes.md"))
            await fs.symlink("../../.env", path.join(setup.root, "docs", "settings.md"))
          })
          const add = (input: Parameters<typeof setup.knowledge.add>[1]) => setup.knowledge.add(setup.place, input)
          return {
            link: yield* add({ type: "path", path: "docs/notes.md", origin: "agent" }),
            absolute: yield* add({ type: "path", path: outside, origin: "agent" }),
            secret: yield* add({ type: "path", path: "docs/settings.md", origin: "agent", attached: true }),
            searched: yield* setup.knowledge.search(setup.place, {
              query: "ledger codename zebrafinch",
              personal: true,
            }),
            attached: yield* add({ type: "path", path: "docs/notes.md", origin: "agent", attached: true }),
          }
        }),
      {},
    )
    expect(result.link).toMatchObject({ type: "refused", reason: "outside" })
    expect(result.absolute).toMatchObject({ type: "refused", reason: "outside" })
    expect(result.secret).toMatchObject({ type: "refused", reason: "secret" })
    expect(JSON.stringify(result.searched)).not.toContain("zebrafinch")
    expect(result.attached).toMatchObject({ type: "queued" })
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

  // Two processes on one brain.db: the first holds an upload's only bytes while it reads something else, past the
  // upload's lease, and the second starts its own drainer meanwhile.
  const sharing = async (expire: number, wait: number, options: { readonly changed?: boolean } = {}) => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "repo")
    await fs.mkdir(root, { recursive: true })
    const file = path.join(tmp.path, "brain.db")
    const place = placeFor(root)
    const gate = Promise.withResolvers<void>()
    const first: string[] = []
    const second: string[] = []
    const result = await Effect.runPromise(
      services(
        place,
        (a) =>
          Effect.gen(function* () {
            yield* a.knowledge.add(place, text("big.md", "# Big\n\nUploads MUST stop at 50 MB per file."))
            const edited = path.join(root, "second.md")
            yield* Effect.promise(() => fs.writeFile(edited, "# Second\n\nRetries MUST stop after 3 tries."))
            const upload = yield* a.knowledge.add(
              place,
              options.changed ? { type: "path", path: edited, origin: "cli" } : text("second.md", "# Second\n\nRetries MUST stop after 3 tries."),
            )
            if (upload.type === "refused") throw new Error(upload.message)
            // A file edited after it was added: the next process cannot read the bytes it was added with.
            if (options.changed) yield* Effect.promise(() => fs.writeFile(edited, "# Second\n\nRetries MUST stop after 5 tries."))
            yield* a.db
              .update(BrainJobTable)
              .set({ lease_until: Date.now() - expire })
              .where(eq(BrainJobTable.document_id, upload.document.id))
              .run()
            yield* Effect.sleep(wait)
            yield* services(
              place,
              (b) =>
                Effect.gen(function* () {
                  yield* b.knowledge.add(place, text("third.md", "# Third\n\nTimeouts MUST be 30 seconds."))
                  yield* Effect.sleep("500 millis")
                }),
              { file, dir: tmp.path, worker: countingWorker(second), owner: "b" },
            )
            gate.resolve()
            return { id: upload.document.id, done: yield* a.knowledge.wait(place, upload.document.id, "searchable", 10_000) }
          }),
        { file, dir: tmp.path, worker: countingWorker(first, gate.promise), owner: "a" },
      ),
    )
    // The other process did read: its own document, and only that.
    expect(second).toHaveLength(1)
    return { ...result, first, second }
  }

  test("another process leaves an upload alone while the process that has its bytes may still read it", async () => {
    const result = await sharing(1, 0)
    expect(result.second).not.toContain(result.id)
    expect(result.first).toContain(result.id)
    expect(result.done?.status).toBe("searchable")
  }, 30_000)

  test("a file changed since it was added goes back to the process that has its bytes, not to failed", async () => {
    const result = await sharing(1, 0, { changed: true })
    expect(result.second).not.toContain(result.id)
    expect(result.first).toContain(result.id)
    expect(result.done?.status).toBe("searchable")
  }, 60_000)

  test("the process that has an upload's bytes keeps its lease while it reads something else", async () => {
    // Long enough out that the upload would count as left behind, had its process not renewed it since.
    const result = await sharing(11 * 60_000, 31_000)
    expect(result.second).not.toContain(result.id)
    expect(result.done?.status).toBe("searchable")
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

  test("a job that dies is retried a minute later, not again at once", async () => {
    const calls: string[] = []
    const dying = Layer.succeed(
      BrainWorker.Service,
      BrainWorker.Service.of({
        extract: (input) =>
          Effect.sync(() => calls.push(input.document)).pipe(Effect.andThen(Effect.die(new Error("the store broke")))),
        probe: () => Effect.die("not used"),
        status: () => Effect.succeed({ mode: "worker" as const, threads: 0 }),
      }),
    )
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          const queued = yield* setup.knowledge.add(setup.place, text("Auth spec.md", SPEC_V1))
          yield* Effect.sleep("300 millis")
          const job = yield* setup.db.get<{ state: string; attempts: number; next: number; error: string }>(
            sql`SELECT state, attempts, next_at AS next, error FROM brain_job`,
          )
          return { queued, job, documents: yield* setup.knowledge.documents(setup.place, { personal: true }) }
        }),
      { worker: dying },
    )
    expect(calls).toHaveLength(1)
    expect(result.job).toMatchObject({ state: "queued", attempts: 1, error: "Vector could not store what it read from this document." })
    expect(result.job!.next).toBeGreaterThan(Date.now() + 50_000)
    expect(result.documents[0]?.status).toBe("queued")
  })

})
