import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { cliIt, type RunResult, type SpawnOpts } from "../../lib/cli-process"

// `vector memory doc` as a user runs it: the real CLI in a process of its own, with its own home and data folder,
// in a repository of its own. Documents are read on this computer; no model is asked anything.

const SPEC = `# Auth spec

## 1 Sessions

The client MUST refresh the session before it expires.
Refresh tokens expire after 14 days.

## 2 Limits

Clients MUST retry at most 3 times after a 429 response.
Uploads are limited to 50 MB per file.
`

// A repository in the fixture's home, and `vector memory doc …` run in it. The test process keeps its databases in
// memory, which a child would inherit; each CLI run here is a process of its own, so they share files in the home.
const repository = (
  fixture: { readonly home: string; readonly vector: { readonly spawn: (args: string[], opts?: SpawnOpts) => Effect.Effect<RunResult> } },
  files: Record<string, string>,
) =>
  Effect.promise(async () => {
    const root = path.join(fixture.home, "repo")
    await fs.mkdir(root, { recursive: true })
    for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(root, name), content)
    return {
      root,
      doc: (args: string[], opts: { readonly stdin?: string } = {}) =>
        fixture.vector.spawn(["memory", "doc", ...args], {
          cwd: root,
          env: { VECTOR_AGENT_DB: path.join(fixture.home, "vector.db") },
          timeoutMs: 60_000,
          ...opts,
        }),
    }
  })

cliIt.concurrent(
  "doc add - keeps what a converter pipes in as Markdown, under the name given, and search finds it",
  (fixture) =>
    Effect.gen(function* () {
      const repo = yield* repository(fixture, {})
      const added = yield* repo.doc(["add", "-", "--name", "scan.pdf", "--json"], { stdin: SPEC })
      fixture.vector.expectExit(added, 0, "vector memory doc add -")
      const [result] = JSON.parse(added.stdout) as { file: string; type: string; document: Record<string, unknown> }[]
      expect(result).toMatchObject({
        file: "-",
        type: "queued",
        document: { title: "scan.pdf", format: "markdown", origin: "cli", status: "searchable" },
      })
      const search = yield* repo.doc(["search", "retry", "429", "--why", "--json"])
      fixture.vector.expectExit(search, 0, "vector memory doc search")
      const [card] = JSON.parse(search.stdout) as { text: string; title: string; why: string[] }[]
      expect(card).toMatchObject({ title: "scan.pdf", why: ["retry", "429"] })
      expect(card!.text).toContain("retry at most 3 times")
      const empty = yield* repo.doc(["add"])
      fixture.vector.expectExit(empty, 1, "vector memory doc add with no file")
    }),
  120_000,
)

cliIt.concurrent(
  "doc extract --json shows what Vector would learn and stores nothing",
  (fixture) =>
    Effect.gen(function* () {
      const repo = yield* repository(fixture, { "spec.md": SPEC })
      const extracted = yield* repo.doc(["extract", "spec.md", "--json"])
      fixture.vector.expectExit(extracted, 0, "vector memory doc extract")
      const structured = JSON.parse(extracted.stdout) as { title: string; records: { kind: string; card: string }[] }
      expect(structured.title).toBe("Auth spec")
      expect(structured.records.some((record) => record.kind === "requirement" && record.card.includes("retry"))).toBe(true)
      const listed = yield* repo.doc(["list", "--json"])
      fixture.vector.expectExit(listed, 0, "vector memory doc list")
      expect(JSON.parse(listed.stdout)).toEqual([])
      // The same file added is kept, so the empty list above is the dry run's doing.
      fixture.vector.expectExit(yield* repo.doc(["add", "spec.md"]), 0, "vector memory doc add")
      expect(JSON.parse((yield* repo.doc(["list", "--json"])).stdout)).toHaveLength(1)
    }),
  120_000,
)

cliIt.concurrent(
  "doc add asks for --replace before a new version replaces a document, and show and forget find it by number",
  (fixture) =>
    Effect.gen(function* () {
      const repo = yield* repository(fixture, { "spec.md": SPEC })
      fixture.vector.expectExit(yield* repo.doc(["add", "spec.md"]), 0, "vector memory doc add")
      yield* Effect.promise(() => fs.appendFile(path.join(repo.root, "spec.md"), "\nUploads MUST be scanned.\n"))
      const asked = yield* repo.doc(["add", "spec.md"])
      fixture.vector.expectExit(asked, 1, "vector memory doc add, a new version")
      expect(asked.stdout + asked.stderr).toContain("Run again with --replace")
      const replaced = yield* repo.doc(["add", "spec.md", "--replace", "--json"])
      fixture.vector.expectExit(replaced, 0, "vector memory doc add --replace")
      expect(JSON.parse(replaced.stdout)[0]).toMatchObject({ type: "version", document: { version: 2, ordinal: 2 } })
      const shown = yield* repo.doc(["show", "2", "--records", "--kind", "requirement", "--json"])
      fixture.vector.expectExit(shown, 0, "vector memory doc show --records")
      const records = JSON.parse(shown.stdout) as { kind: string }[]
      expect(records.length).toBeGreaterThan(0)
      expect(records.every((record) => record.kind === "requirement")).toBe(true)
      const read = yield* repo.doc(["read", "2", "2 Limits"])
      fixture.vector.expectExit(read, 0, "vector memory doc read")
      expect(read.stdout).toContain("retry at most 3 times")
      const exported = yield* fixture.vector.spawn(["memory", "export"], {
        cwd: repo.root,
        env: { VECTOR_AGENT_DB: path.join(fixture.home, "vector.db") },
        timeoutMs: 60_000,
      })
      fixture.vector.expectExit(exported, 0, "vector memory export")
      expect(exported.stdout).toContain("## Documents")
      expect(exported.stdout).toContain("retry at most 3 times")
      fixture.vector.expectExit(yield* repo.doc(["forget", "2"]), 0, "vector memory doc forget")
      expect(JSON.parse((yield* repo.doc(["list", "--json"])).stdout)).toEqual([])
    }),
  180_000,
)

cliIt.concurrent(
  "repo-docs on says the repository's docs are shared like its memory, not private",
  (fixture) =>
    Effect.gen(function* () {
      const repo = yield* repository(fixture, {})
      const shown = yield* fixture.vector.spawn(["memory", "repo-docs", "on"], {
        cwd: repo.root,
        env: { VECTOR_AGENT_DB: path.join(fixture.home, "vector.db") },
        timeoutMs: 60_000,
      })
      fixture.vector.expectExit(shown, 0, "vector memory repo-docs on")
      expect(shown.stderr).toContain("not private")
      expect(shown.stderr).toContain("shared like the repository's memory")
      const help = yield* fixture.vector.spawn(["memory", "repo-docs", "--help"], { cwd: repo.root, timeoutMs: 60_000 })
      fixture.vector.expectExit(help, 0, "vector memory repo-docs --help")
      expect(`${help.stdout}${help.stderr}`.replace(/\s+/g, " ")).toContain("shared like its memory, not private")
    }),
  120_000,
)
