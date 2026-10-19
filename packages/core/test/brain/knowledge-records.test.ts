import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { SPEC_V1, SPEC_V2 } from "./fixture/documents"
import { added, countingWorker, text, withKnowledge } from "./fixture/knowledge"
import { lines, pdf } from "./fixture/pdf"

// What the app's document page and the CLI read: records page by page, one record with its history, the user's edits
// and decisions on records, a page of a PDF with the spans its records came from, and the settings for kept originals.

describe("BrainKnowledge records", () => {
  test("records page through a document in document order, and a cursor picks up where a page ended", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const { document } = yield* added(setup, text("Auth spec.md", SPEC_V1))
        const all = yield* setup.knowledge.records(setup.place, { document: document!.id, limit: 100, personal: true })
        const first = yield* setup.knowledge.records(setup.place, { document: document!.id, limit: 2, personal: true })
        const second = yield* setup.knowledge.records(setup.place, {
          document: document!.id,
          limit: 2,
          cursor: first.cursor,
          personal: true,
        })
        const requirements = yield* setup.knowledge.records(setup.place, { kind: "requirement", personal: true })
        const searched = yield* setup.knowledge.records(setup.place, { query: "retry 429 response", personal: true })
        // A guest's view, or a model that may train: a private upload's records are not there at all.
        const guest = yield* setup.knowledge.records(setup.place, { personal: false })
        return { document, all, first, second, requirements, searched, guest }
      }),
    )
    expect(result.all.records.length).toBe(result.document!.stats.records)
    expect(result.all.cursor).toBeUndefined()
    expect(result.first.records).toHaveLength(2)
    expect(result.first.cursor).toBe("2")
    expect([...result.first.records, ...result.second.records].map((record) => record.id)).toEqual(
      result.all.records.slice(0, 4).map((record) => record.id),
    )
    expect(result.requirements.records.length).toBeGreaterThan(0)
    expect(result.requirements.records.every((record) => record.kind === "requirement")).toBe(true)
    expect(result.searched.records[0]!.card).toContain("retry at most 3 times")
    expect(result.all.records[0]).toMatchObject({ status: "active", userEdited: false, pinned: false, origin: "extracted" })
    expect(result.guest.records).toEqual([])
  })

  test("an edited record is found by its new words, keeps them when the document is read again, and says so", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          const { document } = yield* added(setup, { type: "path", path: "spec.md", origin: "cli" })
          const [retry] = (yield* setup.knowledge.records(setup.place, { query: "retry 429", personal: true })).records
          const changed = yield* setup.knowledge.changeRecord(setup.place, retry!.id, {
            text: "Clients back off and try no more than three times when throttled.",
            pinned: true,
          })
          const found = yield* setup.knowledge.records(setup.place, { query: "throttled", personal: true })
          const old = yield* setup.knowledge.search(setup.place, { query: "retry 429 response", personal: true })
          yield* setup.knowledge.reindex(setup.place, document!.id)
          yield* setup.knowledge.wait(setup.place, document!.id, "searchable", 20_000)
          const detail = yield* setup.knowledge.record(setup.place, retry!.id, { personal: true })
          const again = yield* setup.knowledge.records(setup.place, { query: "throttled", personal: true })
          const secret = yield* setup.knowledge.changeRecord(setup.place, retry!.id, {
            text: "The deploy key is ghp_abcdefghijklmnopqrstuvwxyz0123456789",
          })
          return { retry, changed, found, old, detail, again, secret }
        }),
      { files: { "spec.md": SPEC_V1 } },
    )
    expect(result.changed).toMatchObject({ type: "changed", record: { userEdited: true, pinned: true } })
    expect(result.found.records.map((record) => record.id)).toEqual([result.retry!.id])
    expect(result.old.map((card) => card.id)).not.toContain(result.retry!.id)
    expect(result.detail!.record.card).toBe("Clients back off and try no more than three times when throttled.")
    expect(result.again.records.map((record) => record.id)).toEqual([result.retry!.id])
    expect(result.detail!.passage?.text).toContain("Clients MUST retry at most 3 times")
    expect(result.detail!.history.map((event) => event.action)).toEqual(["pinned", "edited"])
    expect(result.secret).toMatchObject({ type: "refused" })
  })

  test("a record the user puts away stays away when the document is read again, until they restore it", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          const { document } = yield* added(setup, { type: "path", path: "spec.md", origin: "cli" })
          const [retry] = (yield* setup.knowledge.records(setup.place, { query: "retry 429", personal: true })).records
          yield* setup.knowledge.changeRecord(setup.place, retry!.id, { action: "not-applicable" })
          yield* setup.knowledge.reindex(setup.place, document!.id)
          yield* setup.knowledge.wait(setup.place, document!.id, "searchable", 20_000)
          const shown = yield* setup.knowledge.records(setup.place, { personal: true })
          const archived = yield* setup.knowledge.records(setup.place, { status: "archived", personal: true })
          const searched = yield* setup.knowledge.search(setup.place, { query: "retry 429 response", personal: true })
          yield* setup.knowledge.changeRecord(setup.place, retry!.id, { action: "restore" })
          const restored = yield* setup.knowledge.search(setup.place, { query: "retry 429 response", personal: true })
          return { retry, shown, archived, searched, restored }
        }),
      { files: { "spec.md": SPEC_V1 } },
    )
    expect(result.shown.records.map((record) => record.id)).not.toContain(result.retry!.id)
    expect(result.archived.records.map((record) => record.id)).toEqual([result.retry!.id])
    expect(result.searched.map((card) => card.id)).not.toContain(result.retry!.id)
    expect(result.restored.map((card) => card.id)).toContain(result.retry!.id)
  })

  test("a record saved as memory is the user's own entry, as private as its document", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, text("Auth spec.md", SPEC_V1))
        const [record] = (yield* setup.knowledge.records(setup.place, { query: "uploads 50 MB", personal: true })).records
        const changed = yield* setup.knowledge.changeRecord(setup.place, record!.id, { action: "make-memory" })
        return { record, changed }
      }),
    )
    expect(result.changed).toMatchObject({
      type: "changed",
      entry: { text: result.record!.card, origin: "user", status: "active", private: true },
    })
  })

  test("cards resolve records, passages and documents for citation chips, and never what a request may not see", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const { document } = yield* added(setup, text("Auth spec.md", SPEC_V1))
        const [record] = (yield* setup.knowledge.records(setup.place, { query: "retry 429", personal: true })).records
        const ids = [record!.id, record!.passage, document!.id, "rnothing"]
        return {
          record,
          document,
          owner: yield* setup.knowledge.cards(setup.place, ids, { personal: true }),
          guest: yield* setup.knowledge.cards(setup.place, ids, { personal: false }),
        }
      }),
    )
    expect(result.owner.map((card) => [card.id, card.kind])).toEqual([
      [result.record!.id, "requirement"],
      [result.record!.passage, "passage"],
      [result.document!.id, "document"],
    ])
    expect(result.owner[0]).toMatchObject({ title: "Auth spec", section: "2 Limits" })
    expect(result.guest).toEqual([])
  })
})

describe("BrainKnowledge titles", () => {
  test("a title the user gives while a document waits to be read stays theirs", async () => {
    const gate = Promise.withResolvers<void>()
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          const named = yield* setup.knowledge.add(setup.place, text("Auth spec.md", SPEC_V1))
          const plain = yield* setup.knowledge.add(setup.place, text("Limits.md", SPEC_V2))
          if (named.type === "refused" || plain.type === "refused") throw new Error("not added")
          yield* setup.knowledge.update(setup.place, named.document.id, { title: "Login rules" })
          gate.resolve()
          return {
            named: yield* setup.knowledge.wait(setup.place, named.document.id, "searchable", 20_000),
            plain: yield* setup.knowledge.wait(setup.place, plain.document.id, "searchable", 20_000),
          }
        }),
      { worker: countingWorker([], gate.promise) },
    )
    expect(result.named?.title).toBe("Login rules")
    // Without a name from the user, the document's own heading is its title.
    expect(result.plain?.title).toBe("Auth spec")
  })
})

describe("BrainKnowledge pages", () => {
  test("a page shows its passages and the spans its records were read from", async () => {
    const bytes = pdf({
      pages: [
        { runs: [{ text: "Upload guide", x: 72, y: 740, size: 20, font: "bold" }, ...lines(["Uploads are limited to 50 MB per file."], { top: 700 })] },
        { runs: lines(["Clients MUST retry at most 3 times after a 429 response."]) },
      ],
    })
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const { document } = yield* added(setup, { type: "bytes", name: "upload.pdf", bytes, origin: "upload" })
        const markdown = yield* added(setup, text("Auth spec.md", SPEC_V1))
        return {
          two: yield* setup.knowledge.page(setup.place, document!.id, 2, { personal: true }),
          three: yield* setup.knowledge.page(setup.place, document!.id, 3, { personal: true }),
          guest: yield* setup.knowledge.page(setup.place, document!.id, 2, { personal: false }),
          markdown: yield* setup.knowledge.page(setup.place, markdown.document!.id, 1, { personal: true }),
        }
      }),
    )
    expect(result.two).toMatchObject({ page: 2, pages: 2, unread: false })
    const passage = result.two!.passages[0]!
    const span = passage.records.find((item) => item.page === 2)!
    expect(span.kind).toBe("requirement")
    expect(passage.text.slice(span.start, span.end)).toContain("Clients MUST retry at most 3 times")
    expect(result.three).toBeUndefined()
    expect(result.guest).toBeUndefined()
    expect(result.markdown).toBeUndefined()
  })
})

describe("BrainKnowledge versions, pausing and path mode", () => {
  test("a new version waits for the user when the caller asks first", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const first = yield* added(setup, text("Auth spec.md", SPEC_V1))
        const asked = yield* setup.knowledge.add(setup.place, { ...text("Auth spec.md", SPEC_V2), replace: false })
        const listed = yield* setup.knowledge.documents(setup.place, { personal: true })
        const replaced = yield* setup.knowledge.add(setup.place, { ...text("Auth spec.md", SPEC_V2), replace: true })
        return { first: first.document!, asked, listed, replaced }
      }),
    )
    expect(result.asked).toMatchObject({ type: "refused", reason: "version", document: { id: result.first.id } })
    expect(result.listed.map((document) => document.id)).toEqual([result.first.id])
    expect(result.replaced).toMatchObject({ type: "version", previous: result.first.id })
  })

  test("pause holds a document that waits to be read until the user resumes it", async () => {
    const calls: string[] = []
    const gate = Promise.withResolvers<void>()
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          const first = yield* setup.knowledge.add(setup.place, text("First.md", SPEC_V1))
          const second = yield* setup.knowledge.add(setup.place, text("Second.md", SPEC_V2))
          if (first.type === "refused" || second.type === "refused") throw new Error("not added")
          yield* setup.knowledge.update(setup.place, second.document.id, { action: "pause" })
          gate.resolve()
          yield* setup.knowledge.wait(setup.place, first.document.id, "searchable", 20_000)
          const waiting = yield* setup.knowledge.wait(setup.place, second.document.id, "searchable", 400)
          const listed = yield* setup.knowledge.documents(setup.place, { personal: true })
          const indexing = yield* setup.knowledge.indexing(setup.place)
          yield* setup.knowledge.update(setup.place, second.document.id, { action: "resume" })
          const resumed = yield* setup.knowledge.wait(setup.place, second.document.id, "searchable", 20_000)
          return { second: second.document.id, waiting, listed, indexing, resumed }
        }),
      { worker: countingWorker(calls, gate.promise) },
    )
    expect(result.waiting).toBeUndefined()
    expect(result.listed.find((document) => document.id === result.second)?.paused).toBe(true)
    expect(result.indexing).toBe(false)
    expect(result.resumed?.status).toBe("searchable")
    expect(calls).toHaveLength(2)
  })

  test("path mode reads regular files only and refuses a path that is itself a link", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.symlink(path.join(setup.root, "spec.md"), path.join(setup.root, "link.md"))
            await fs.mkdir(path.join(setup.dir, "elsewhere"))
            await fs.writeFile(path.join(setup.dir, "elsewhere", "plan.md"), "# Plan\n\nThe vault opens at dawn.")
            await fs.symlink(path.join(setup.dir, "elsewhere"), path.join(setup.root, "linked"))
          })
          execFileSync("mkfifo", [path.join(setup.root, "pipe.md")])
          const add = (file: string) =>
            setup.knowledge.add(setup.place, { type: "path", path: file, origin: "upload", links: false })
          return {
            link: yield* add("link.md"),
            pipe: yield* add("pipe.md"),
            folder: yield* add("docs"),
            file: yield* add("spec.md"),
            followed: yield* setup.knowledge.add(setup.place, { type: "path", path: "link.md", origin: "cli" }),
            // A repository path that leads out through a linked folder is not a repository file, even from a chat.
            escaped: yield* setup.knowledge.add(setup.place, {
              type: "path",
              path: "linked/plan.md",
              origin: "chat",
              attached: false,
              links: false,
            }),
          }
        }),
      { files: { "spec.md": SPEC_V1, "docs/readme.md": "# Docs" } },
    )
    expect(result.link).toMatchObject({ type: "refused", reason: "unsupported" })
    expect(result.pipe).toMatchObject({ type: "refused", reason: "not-found" })
    expect(result.folder).toMatchObject({ type: "refused", reason: "not-found" })
    expect(result.file).toMatchObject({ type: "queued" })
    // A link the user names on the command line is opened, like any program opens one.
    expect(result.followed).toMatchObject({ type: "unchanged" })
    expect(result.escaped).toMatchObject({ type: "refused", reason: "outside" })
  })
})

describe("BrainKnowledge kept originals", () => {
  test("a repository that keeps originals keeps each file privately, reads it again from the copy, and deletes it when told", async () => {
    const bytes = new TextEncoder().encode(SPEC_V1)
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const folder = path.join(setup.dir, "data", "brain", "documents")
        const before = yield* setup.knowledge.settings(setup.place)
        const off = yield* added(setup, { type: "bytes", name: "Off.md", bytes: new TextEncoder().encode(SPEC_V2), origin: "upload" })
        const settings = yield* setup.knowledge.configure(setup.place, { keepOriginals: true })
        const { document } = yield* added(setup, { type: "bytes", name: "Auth spec.md", bytes, origin: "upload" })
        const original = yield* setup.knowledge.original(setup.place, document!.id)
        const files = yield* Effect.promise(() => fs.readdir(folder))
        const modes = yield* Effect.promise(async () => ({
          folder: (await fs.stat(folder)).mode & 0o777,
          file: (await fs.stat(path.join(folder, files[0]!))).mode & 0o777,
        }))
        // An upload has no file to read again but its copy.
        const reread = yield* setup.knowledge.reindex(setup.place, document!.id)
        yield* setup.knowledge.wait(setup.place, document!.id, "searchable", 20_000)
        yield* setup.knowledge.configure(setup.place, { keepOriginals: false })
        const after = yield* Effect.promise(() => fs.readdir(folder))
        const [listed] = (yield* setup.knowledge.documents(setup.place, { personal: true })).filter(
          (item) => item.id === document!.id,
        )
        return { before, settings, off: off.document, document, original, files, modes, reread, after, listed }
      }),
    )
    expect(result.before).toEqual({ repositoryDocs: true, keepOriginals: false })
    expect(result.settings.keepOriginals).toBe(true)
    expect(result.off?.stored).toBe(false)
    expect(result.document?.stored).toBe(true)
    expect(new TextDecoder().decode(result.original!.bytes)).toBe(SPEC_V1)
    expect(result.files).toHaveLength(1)
    if (process.platform !== "win32") expect(result.modes).toEqual({ folder: 0o700, file: 0o600 })
    expect(result.reread).toBe(1)
    expect(result.after).toEqual([])
    expect(result.listed?.stored).toBe(false)
  })
})
