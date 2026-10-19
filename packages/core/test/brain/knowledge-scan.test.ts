import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { placeFor, withKnowledge } from "./fixture/knowledge"

const FILES = {
  "README.md": "# Billing service\n\nThe billing service MUST round money to integer cents.",
  "docs/guide.md": "# Guide\n\nRefresh tokens expire after 14 days.",
  "docs/adr/0001-queues.md": "# Use one queue\n\nWe decided to use one queue because ordering matters.",
  "api/openapi.yaml": "openapi: 3.0.0\ninfo:\n  title: Billing\n  version: '1'\npaths:\n  /v1/invoices:\n    get:\n      responses:\n        '200':\n          description: ok\n",
  "CHANGELOG.md": "# Changelog\n\n- The service MUST do things.",
  ".vector/RULES.md": "- Money is integer cents.",
  "BRAIN.md": "- A lesson.",
  "src/index.ts": "export const x = 1\n",
  "docs/notes.txt": "Plain notes that are not tracked by git.",
  "docs/.env.md": "TOKEN=abc",
}

const git = (root: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

const track = (root: string, files: readonly string[]) => {
  git(root, "init", "-q")
  git(root, "add", "--", ...files)
}

describe("BrainKnowledge.scan", () => {
  test("reads the repository's tracked docs, and only them", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          track(setup.root, Object.keys(FILES).filter((file) => file !== "docs/notes.txt"))
          const queued = yield* setup.knowledge.scan(setup.place)
          const documents = yield* setup.knowledge.documents(setup.place, { personal: false })
          yield* Effect.forEach(documents, (document) => setup.knowledge.wait(setup.place, document.id, "searchable", 10_000))
          // Within ten minutes a scan does nothing; forced, it reads only what changed.
          const soon = yield* setup.knowledge.scan(setup.place)
          yield* Effect.promise(() => fs.writeFile(path.join(setup.root, "docs/guide.md"), "# Guide\n\nRefresh tokens expire after 30 days."))
          const changed = yield* setup.knowledge.scan(setup.place, { force: true })
          // A doc git no longer tracks is no longer one of the repository's docs.
          git(setup.root, "rm", "-q", "--cached", "docs/adr/0001-queues.md")
          yield* setup.knowledge.scan(setup.place, { force: true })
          const final = yield* setup.knowledge.documents(setup.place, { personal: false })
          yield* Effect.forEach(final, (document) => setup.knowledge.wait(setup.place, document.id, "searchable", 10_000))
          return {
            queued,
            soon,
            changed,
            names: documents.map((document) => document.sourcePath).toSorted(),
            final: (yield* setup.knowledge.documents(setup.place, { personal: false })).map((document) => [
              document.sourcePath,
              document.version,
              document.visibility,
              document.status,
            ]),
          }
        }),
      { files: FILES },
    )
    expect(result.queued).toBe(4)
    expect(result.names).toEqual(["README.md", "api/openapi.yaml", "docs/adr/0001-queues.md", "docs/guide.md"])
    expect(result.soon).toBe(0)
    expect(result.changed).toBe(1)
    expect(result.final.toSorted()).toEqual([
      ["README.md", 1, "repository", "searchable"],
      ["api/openapi.yaml", 1, "repository", "searchable"],
      ["docs/guide.md", 2, "repository", "searchable"],
    ])
  })

  test("an untrusted repository's docs are read and held for the user", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          track(setup.root, ["README.md"])
          const place = placeFor(setup.root, true)
          yield* setup.knowledge.scan(place)
          const [document] = yield* setup.knowledge.documents(place, { personal: false })
          return {
            document: yield* setup.knowledge.wait(place, document!.id, "searchable", 10_000),
            recall: yield* setup.knowledge.recall(place, {
              query: "how does the billing service round money?",
              files: [],
              tier: "standard",
              tight: false,
              personal: false,
              exclude: new Set(),
            }),
          }
        }),
      { files: { "README.md": FILES["README.md"] } },
    )
    expect(result.document).toMatchObject({ status: "held", hold: "untrusted-repository", origin: "repository" })
    expect(result.recall.text ?? "").toBe("")
  })

  test("a tracked link is never read as a doc, wherever it points", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          const outside = path.join(path.dirname(setup.root), "outside-notes.txt")
          yield* Effect.promise(async () => {
            await fs.writeFile(outside, "The private ledger codename is zebrafinch and the vault opens at dawn.\n")
            await fs.mkdir(path.join(setup.root, "docs"), { recursive: true })
            await fs.symlink(outside, path.join(setup.root, "docs", "notes.md"))
            await fs.symlink("../README.md", path.join(setup.root, "docs", "readme.md"))
          })
          track(setup.root, ["README.md", "docs/notes.md", "docs/readme.md"])
          const queued = yield* setup.knowledge.scan(setup.place, { force: true })
          const documents = yield* setup.knowledge.documents(setup.place, { personal: true })
          yield* Effect.forEach(documents, (document) =>
            setup.knowledge.wait(setup.place, document.id, "searchable", 10_000),
          )
          return {
            queued,
            sources: documents.map((document) => document.sourcePath),
            found: yield* setup.knowledge.search(setup.place, { query: "ledger codename zebrafinch", personal: true }),
          }
        }),
      { files: { "README.md": FILES["README.md"] } },
    )
    expect(result.queued).toBe(1)
    expect(result.sources).toEqual(["README.md"])
    expect(JSON.stringify(result.found)).not.toContain("zebrafinch")
  })

  test("a doc under a directory swapped for a link out of the repository is not read", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          const elsewhere = path.join(path.dirname(setup.root), "elsewhere")
          track(setup.root, ["README.md", "docs/guide.md"])
          yield* Effect.promise(async () => {
            await fs.mkdir(elsewhere, { recursive: true })
            await fs.writeFile(
              path.join(elsewhere, "guide.md"),
              "# Guide\n\nThe vault opens at dawn, codename zebrafinch.",
            )
            await fs.rm(path.join(setup.root, "docs"), { recursive: true })
            await fs.symlink(elsewhere, path.join(setup.root, "docs"))
          })
          yield* setup.knowledge.scan(setup.place, { force: true })
          return (yield* setup.knowledge.documents(setup.place, { personal: true })).map(
            (document) => document.sourcePath,
          )
        }),
      { files: { "README.md": FILES["README.md"], "docs/guide.md": FILES["docs/guide.md"] } },
    )
    expect(result).toEqual(["README.md"])
  })

  test("with repository docs off, nothing is read", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          track(setup.root, ["README.md"])
          yield* setup.db.run(sql`INSERT INTO brain_state (repository_id, repository_docs) VALUES ('repo-1', 0)`)
          return yield* setup.knowledge.scan(setup.place)
        }),
      { files: { "README.md": FILES["README.md"] } },
    )
    expect(result).toBe(0)
  })
})
