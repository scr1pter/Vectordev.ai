import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { BrainAnchor } from "@vectordevai/core/brain/anchor"
import { BrainAnchorTable, BrainEventTable, BrainPendingTable } from "@vectordevai/core/brain/sql"
import { tmpdir } from "../fixture/tmpdir"
import { bundle } from "./fixture/bundle"
import { added, text, withKnowledge, type Setup } from "./fixture/knowledge"

// Links from documents to code, found with Ripgrep in a real (temporary) git working tree: definitions, uses, routes,
// env reads and paths link; plain words and names the whole repository uses do not; a name the code does not have yet
// waits, and links itself once its file is added.

const SPEC = `# Auth spec

## 1 Sessions

The \`refreshTokenTtl\` MUST be 14 days.

Sessions are read with GET /v1/users/{id} and created with POST /v2/sessions.

The server MUST read \`DATABASE_URL\` at start.

Each upload goes through the upload handler before it is stored.

The \`commonThing\` MUST be logged.

Invoices MUST be numbered by \`InvoiceNumberer\`.

The session store lives in src/auth/store.ts.
`

const CODE = {
  "src/auth/session.ts": [
    "export const refreshTokenTtl = (days: number) => days * 86_400",
    "export function upload(file: Blob) {",
    "  return file",
    "}",
    "",
  ].join("\n"),
  "src/auth/store.ts": "export const store = new Map<string, string>()\n",
  "src/api/users.ts": [
    'router.get("/v1/users/:id", (request, response) => response.json(find(request.params.id)))',
    "",
  ].join("\n"),
  "src/api/sessions.ts": [
    'export const createSession = HttpApiEndpoint.post("createSession", "/v2/sessions", { success: Session })',
    "",
  ].join("\n"),
  "src/config.ts": ["export const database = process.env.DATABASE_URL ?? ''", ""].join("\n"),
  // Docs never anchor a document, even when they name the same things.
  "docs/notes.md": "The refreshTokenTtl is in src/auth/session.ts.\n",
  ...Object.fromEntries(
    Array.from({ length: 51 }, (_, index) => [
      `src/common/file${index}.ts`,
      `log(commonThing)\nlog(commonThing, ${index})\n`,
    ]),
  ),
}

const anchorsOf = (setup: Setup) => setup.db.select().from(BrainAnchorTable).all().pipe(Effect.orDie)

describe("BrainAnchor.names", () => {
  test("identifiers, SCREAMING_SNAKE names, paths, routes and code spans; never a plain word outside a code span", () => {
    const names = BrainAnchor.names({
      text: "Uploads over MAX_UPLOAD_BYTES fail in src/upload.ts; the uploadHandler retries GET /v1/files/{id}. Each upload is logged by `audit`.",
      code: ["audit"],
    })
    expect(names).toEqual(
      expect.arrayContaining([
        { kind: "symbol", text: "MAX_UPLOAD_BYTES" },
        { kind: "symbol", text: "uploadHandler" },
        { kind: "symbol", text: "audit" },
        { kind: "path", text: "src/upload.ts" },
        { kind: "route", text: "/v1/files/*", method: "GET" },
      ]),
    )
    expect(names.map((name) => name.text)).not.toContain("upload")
    expect(names.map((name) => name.text)).not.toContain("Uploads")
    // Product names with a capital inside read like identifiers and are none.
    expect(BrainAnchor.names({ text: "Deploy from GitHub with TypeScript and PostgreSQL." })).toEqual([])
  })

  test("a line defines, reads as an env variable, or only uses a name", () => {
    expect(BrainAnchor.classify("export function createSession(input) {", "createSession")).toBe("definition")
    expect(BrainAnchor.classify("const refreshTokenTtl = 14", "refreshTokenTtl")).toBe("definition")
    expect(BrainAnchor.classify("  handler: async (request) => {", "handler")).toBe("definition")
    expect(BrainAnchor.classify("func (s *Server) ServeUsers(w http.ResponseWriter) {", "ServeUsers")).toBe(
      "definition",
    )
    expect(BrainAnchor.classify("MAX_UPLOAD_BYTES = 64 * 1024 * 1024", "MAX_UPLOAD_BYTES")).toBe("definition")
    expect(BrainAnchor.classify("const url = process.env.DATABASE_URL", "DATABASE_URL")).toBe("env")
    expect(BrainAnchor.classify('url = os.getenv("DATABASE_URL")', "DATABASE_URL")).toBe("env")
    expect(BrainAnchor.classify("return refreshTokenTtl(days)", "refreshTokenTtl")).toBe("use")
    expect(BrainAnchor.classify("function *refreshTokens() {", "refreshTokens")).toBe("definition")
    expect(BrainAnchor.classify("function * refreshTokens() {", "refreshTokens")).toBe("definition")
  })

  // A pattern that backtracks takes about a second on these lines here (and minutes on a 500 KB one, below).
  test("the definition check stays quick on a long run of spaces", () => {
    const started = performance.now()
    expect(BrainAnchor.classify(`const${" ".repeat(50_000)}x = refreshTokenTtl`, "refreshTokenTtl")).toBe("use")
    expect(BrainAnchor.classify(`function${" ".repeat(50_000)}*${" ".repeat(50_000)}x(refreshTokenTtl)`, "refreshTokenTtl")).toBe("use")
    expect(performance.now() - started).toBeLessThan(200)
  })

  // On a 500 KB line, in a child process that is stopped if it takes too long. V8 (Electron and Node) backtracks on
  // runs of spaces as Bun's regex interpreter does.
  test.skipIf(!Bun.which("node"))("the definition check stays quick on a 500 KB line in V8", async () => {
    await using tmp = await tmpdir()
    await Bun.write(
      path.join(tmp.path, "anchor.mjs"),
      await bundle(path.join(import.meta.dir, "../../src/brain/anchor.ts")),
    )
    await Bun.write(
      path.join(tmp.path, "time.mjs"),
      [
        'import { classify } from "./anchor.mjs"',
        "const started = performance.now()",
        'const kind = classify("const" + " ".repeat(500_000) + "x = refreshTokenTtl", "refreshTokenTtl")',
        "console.log(JSON.stringify({ kind, ms: performance.now() - started }))",
      ].join("\n"),
    )
    const child = Bun.spawn([Bun.which("node")!, path.join(tmp.path, "time.mjs")], { stdout: "pipe", stderr: "pipe" })
    // A pattern that backtracks takes minutes on this line; it is stopped long before.
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000)
    const out = await new Response(child.stdout).text()
    clearTimeout(timer)
    expect(await child.exited).toBe(0)
    const timed = JSON.parse(out)
    expect(timed.kind).toBe("use")
    expect(timed.ms).toBeLessThan(500)
  }, 20_000)

  test("routes of each framework normalise to the document's shape", () => {
    const name = { kind: "route" as const, text: "/v1/users/*", method: "GET" }
    expect(BrainAnchor.registers('app.get("/v1/users/:id", handler)', name)).toBe(true)
    expect(BrainAnchor.registers('@Get("/v1/users/:id")', name)).toBe(true)
    expect(BrainAnchor.registers('@app.get("/v1/users/{id}")', name)).toBe(true)
    expect(BrainAnchor.registers('HttpApiEndpoint.get("getUser", "/v1/users/:id")', name)).toBe(true)
    expect(BrainAnchor.registers('mux.HandleFunc("GET /v1/users/{id}", users)', name)).toBe(true)
    expect(BrainAnchor.registers('app.post("/v1/users/:id", handler)', name)).toBe(false)
    expect(BrainAnchor.registers('const url = "/v1/users/" + id', name)).toBe(false)
    // A lookup is not a route: a router-like receiver or a handler after the path is.
    const health = { kind: "route" as const, text: "/v1/health" }
    expect(BrainAnchor.registers('const status = cache.get("/v1/health")', health)).toBe(false)
    expect(BrainAnchor.registers('const status = await api.get("/v1/health")', health)).toBe(false)
    expect(BrainAnchor.registers('app.get("/v1/health")', health)).toBe(true)
    expect(BrainAnchor.registers('r.Get("/v1/users/{id}", getUser)', name)).toBe(true)
    expect(BrainAnchor.registers('usersRouter.get("/v1/users/:id",', name)).toBe(true)
    expect(BrainAnchor.registers('billing.get("/v1/users/:id", async (c) => c.json(user))', name)).toBe(true)
    expect(BrainAnchor.registers('new Elysia().get("/v1/users/:id", ({ params }) => find(params.id))', name)).toBe(true)
  })
})

describe("BrainKnowledge links to code", () => {
  test("definitions, routes and env reads link; a name in 51 files and plain words do not; docs never anchor", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          const { document } = yield* added(setup, text("Auth spec.md", SPEC))
          const records = (yield* setup.knowledge.records(setup.place, { personal: true })).records
          return { document, records, anchors: yield* anchorsOf(setup) }
        }),
      { files: CODE, git: true },
    )
    expect(result.document?.status).toBe("searchable")
    const of = (quote: string) => result.records.find((record) => record.quote.includes(quote))!.id
    const linked = (owner: string) => result.anchors.filter((anchor) => anchor.owner === owner)
    expect(linked(of("refreshTokenTtl"))).toContainEqual(
      expect.objectContaining({
        path: "src/auth/session.ts",
        symbol: "refreshTokenTtl",
        line: 1,
        method: "definition",
        weight: 1,
        status: "fresh",
      }),
    )
    expect(linked(of("GET /v1/users"))).toContainEqual(
      expect.objectContaining({ path: "src/api/users.ts", method: "route", symbol: "GET /v1/users/*", line: 1 }),
    )
    expect(result.anchors).toContainEqual(
      expect.objectContaining({ path: "src/api/sessions.ts", method: "route", symbol: "POST /v2/sessions" }),
    )
    expect(linked(of("DATABASE_URL"))).toContainEqual(
      expect.objectContaining({ path: "src/config.ts", symbol: "DATABASE_URL", method: "env", weight: 0.7 }),
    )
    expect(result.anchors).toContainEqual(
      expect.objectContaining({ path: "src/auth/store.ts", method: "path", weight: 0.9 }),
    )
    // Used in 51 files: too common to say where anything is.
    expect(result.anchors.filter((anchor) => anchor.symbol === "commonThing")).toEqual([])
    // "upload" is a plain word in the document, though the code defines it.
    expect(result.anchors.filter((anchor) => anchor.symbol === "upload")).toEqual([])
    expect(result.anchors.some((anchor) => anchor.path.startsWith("docs/"))).toBe(false)
    expect(result.document?.stats.linked).toBeGreaterThanOrEqual(5)
  }, 30_000)

  test("a name the code does not have yet waits, and links itself when its file is added", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          yield* added(setup, text("Auth spec.md", SPEC))
          const waiting = yield* setup.db.select().from(BrainPendingTable).all().pipe(Effect.orDie)
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(setup.root, "src", "billing"), { recursive: true })
            await fs.writeFile(
              path.join(setup.root, "src", "billing", "invoice.ts"),
              "export class InvoiceNumberer {\n  next() { return 1 }\n}\n",
            )
          })
          const drift = yield* setup.knowledge.drift(setup.place, { force: true })
          const anchors = yield* anchorsOf(setup)
          const after = yield* setup.db.select().from(BrainPendingTable).all().pipe(Effect.orDie)
          const owner = waiting.find((row) => row.identifier === "InvoiceNumberer")?.owner ?? ""
          const events = yield* setup.db
            .select()
            .from(BrainEventTable)
            .where(eq(BrainEventTable.entry_id, owner))
            .all()
            .pipe(Effect.orDie)
          return { waiting, drift, anchors, after, events, owner }
        }),
      { files: CODE, git: true },
    )
    expect(result.waiting).toContainEqual(expect.objectContaining({ identifier: "InvoiceNumberer", kind: "symbol" }))
    expect(result.drift.linked).toBe(1)
    expect(result.anchors).toContainEqual(
      expect.objectContaining({
        owner: result.owner,
        path: "src/billing/invoice.ts",
        symbol: "InvoiceNumberer",
        method: "definition",
      }),
    )
    expect(result.after.some((row) => row.identifier === "InvoiceNumberer")).toBe(false)
    expect(result.events).toContainEqual(
      expect.objectContaining({
        action: "linked",
        actor: "vector",
        detail: expect.objectContaining({ path: "src/billing/invoice.ts" }),
      }),
    )
  }, 30_000)

  test("a file that is not UTF-8 keeps a document's links", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          yield* added(setup, text("Auth spec.md", SPEC))
          const before = yield* anchorsOf(setup)
          // "café refreshTokenTtl" in Latin-1, where é is the single byte 0xe9.
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(setup.root, "src", "legacy.ts"),
              Buffer.from([...Buffer.from("// caf"), 0xe9, ...Buffer.from(" refreshTokenTtl\n")]),
            ),
          )
          yield* setup.knowledge.link(setup.place)
          return { before, after: yield* anchorsOf(setup) }
        }),
      { files: CODE, git: true },
    )
    const ttl = (anchors: typeof result.before) =>
      anchors.filter((anchor) => anchor.symbol === "refreshTokenTtl" && anchor.method === "definition").map((anchor) => anchor.path)
    expect(ttl(result.before)).toEqual(["src/auth/session.ts"])
    expect(ttl(result.after)).toEqual(["src/auth/session.ts"])
  }, 30_000)

  test("a name on more lines than a pass reads is counted by its files, and a rare name beside it still links", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          const { document } = yield* added(
            setup,
            text("Users.md", "# Users\n\n## 1 Ids\n\nThe `userId` MUST be checked on each call.\n\nThe `refreshTokenTtl` MUST be 14 days.\n"),
          )
          const linked = yield* setup.knowledge.link(setup.place)
          return { document, linked, anchors: yield* anchorsOf(setup) }
        }),
      {
        files: {
          ...CODE,
          // 4,800 lines in 60 files: more than one pass reads, and more files than a useful name is in.
          ...Object.fromEntries(
            Array.from({ length: 60 }, (_, index) => [`src/users/f${index}.ts`, "log(userId)\n".repeat(80)]),
          ),
        },
        git: true,
      },
    )
    expect(result.document?.status).toBe("searchable")
    expect(result.anchors.filter((anchor) => anchor.symbol === "userId")).toEqual([])
    expect(result.linked.common).toContain("userId")
    expect(result.anchors).toContainEqual(
      expect.objectContaining({ path: "src/auth/session.ts", symbol: "refreshTokenTtl", method: "definition" }),
    )
  }, 30_000)

  test("a name whose lines do not all come back keeps the links it had", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          yield* added(setup, text("Dense.md", "# Dense\n\n## 1 Counter\n\nThe `denseCounter` MUST start at zero.\n"))
          const before = yield* anchorsOf(setup)
          // One generated file uses it on more lines than a pass reads, in too few files to be common.
          yield* Effect.promise(() =>
            fs.writeFile(path.join(setup.root, "src", "generated.ts"), "denseCounter()\n".repeat(4_100)),
          )
          yield* setup.knowledge.link(setup.place)
          return {
            before,
            after: yield* anchorsOf(setup),
            pending: yield* setup.db.select().from(BrainPendingTable).all().pipe(Effect.orDie),
          }
        }),
      {
        files: {
          "src/counter.ts": "export const denseCounter = () => 0\n",
          "src/use.ts": "denseCounter()\ndenseCounter()\n",
        },
        git: true,
      },
    )
    const links = (anchors: typeof result.before) =>
      anchors.map((anchor) => `${anchor.path}:${anchor.method}`).toSorted()
    expect(links(result.before)).toEqual(["src/counter.ts:definition", "src/use.ts:use"])
    expect(links(result.after)).toEqual(links(result.before))
    expect(result.pending).toEqual([])
  }, 30_000)

  test("outside a git working tree nothing is linked", async () => {
    const anchors = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          yield* added(setup, text("Auth spec.md", SPEC))
          return yield* anchorsOf(setup)
        }),
      { files: CODE },
    )
    expect(anchors).toEqual([])
  }, 30_000)

  test("the user's own link stays through a re-read, and an unlinked one is not made again", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          yield* added(setup, text("Auth spec.md", SPEC))
          const records = (yield* setup.knowledge.records(setup.place, { personal: true })).records
          const ttl = records.find((record) => record.quote.includes("refreshTokenTtl"))!
          const invoice = records.find((record) => record.quote.includes("InvoiceNumberer"))!
          const before = (yield* anchorsOf(setup)).find(
            (anchor) => anchor.owner === ttl.id && anchor.method === "definition",
          )!
          yield* setup.knowledge.changeRecord(setup.place, ttl.id, { unlink: before.id })
          yield* setup.knowledge.changeRecord(setup.place, invoice.id, {
            link: { path: "src/auth/store.ts", symbol: "store" },
          })
          const refused = yield* setup.knowledge.changeRecord(setup.place, invoice.id, {
            link: { path: "../outside.ts" },
          })
          yield* setup.knowledge.link(setup.place)
          return {
            ttl,
            invoice,
            refused,
            anchors: yield* anchorsOf(setup),
            detail: yield* setup.knowledge.record(setup.place, ttl.id, { personal: true }),
          }
        }),
      { files: CODE, git: true },
    )
    expect(result.anchors.some((anchor) => anchor.owner === result.ttl.id && anchor.method === "definition")).toBe(
      false,
    )
    expect(result.anchors).toContainEqual(
      expect.objectContaining({
        owner: result.invoice.id,
        path: "src/auth/store.ts",
        symbol: "store",
        method: "user",
        origin: "user",
        line: 1,
      }),
    )
    expect(result.refused).toMatchObject({ type: "refused" })
    expect(result.detail?.history.map((event) => event.action)).toContain("unlinked")
  }, 30_000)
})

describe("pointers and the spec guard", () => {
  test("a linked file names its requirements in one short line; a file nothing is linked to adds nothing", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          yield* added(setup, text("Auth spec.md", SPEC))
          const request = { personal: true, exclude: new Set<string>(), sessionID: "ses_1", requestID: "msg_1" }
          const pointer = yield* setup.knowledge.pointers(setup.place, {
            ...request,
            file: path.join(setup.root, "src/auth/session.ts"),
          })
          const guard = yield* setup.knowledge.guard(setup.place, { ...request, file: "src/api/users.ts" })
          const again = yield* setup.knowledge.pointers(setup.place, {
            ...request,
            file: "src/auth/session.ts",
            ids: pointer.ids,
          })
          return {
            pointer,
            guard,
            again,
            excluded: yield* setup.knowledge.pointers(setup.place, {
              ...request,
              file: "src/auth/session.ts",
              exclude: new Set(pointer.ids),
            }),
            none: yield* setup.knowledge.pointers(setup.place, { ...request, file: "src/common/file1.ts" }),
            links: yield* setup.knowledge.links(setup.place, "src/auth/session.ts", { personal: true }),
            hidden: yield* setup.knowledge.links(setup.place, "src/auth/session.ts", { personal: false }),
          }
        }),
      { files: CODE, git: true },
    )
    expect(result.pointer.text).toMatch(
      /^Documents linked to src\/auth\/session\.ts: \[r[0-9a-z]{12}\] requirement \(The refreshTokenTtl MUST be 14 days\.\)\.$/,
    )
    expect(result.pointer.tokens).toBeLessThanOrEqual(60)
    expect(result.guard.text).toMatch(
      /^Linked requirements: \[r[0-9a-z]{12}\] \(GET \/v1\/users\/\{id\}\)\. Check the change still meets them\.$/,
    )
    expect(result.guard.tokens).toBeLessThanOrEqual(50)
    expect(result.again.text).toBe(result.pointer.text)
    expect(result.excluded).toEqual({ ids: [], tokens: 0 })
    expect(result.none).toEqual({ ids: [], tokens: 0 })
    expect(result.links).toContainEqual(
      expect.objectContaining({
        type: "record",
        kind: "requirement",
        title: "Auth spec",
        anchor: expect.objectContaining({ method: "definition" }),
      }),
    )
    // An uploaded document is private: withheld where personal memory is.
    expect(result.hidden).toEqual([])
  }, 30_000)

  // git reports a repository's real path, while a read or an edit can come through a symlinked one (macOS /tmp and
  // /var, a linked folder of projects), and the other way round.
  test("a file read through a symlinked path of its repository has its pointer, guard and links", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          yield* added(setup, text("Auth spec.md", SPEC))
          const linked = path.join(setup.dir, "linked")
          yield* Effect.promise(() => fs.symlink(setup.root, linked))
          const request = { personal: true, exclude: new Set<string>() }
          const read = (place: typeof setup.place, root: string) =>
            Effect.gen(function* () {
              return {
                pointer: (yield* setup.knowledge.pointers(place, { ...request, file: path.join(root, "src/auth/session.ts") })).text,
                guard: (yield* setup.knowledge.guard(place, { ...request, file: path.join(root, "src/api/users.ts") })).text,
                links: (yield* setup.knowledge.links(place, path.join(root, "src/auth/session.ts"), { personal: true })).length,
              }
            })
          return {
            real: yield* read(setup.place, setup.root),
            throughLink: yield* read(setup.place, linked),
            fromLink: yield* read({ ...setup.place, root: linked }, setup.root),
          }
        }),
      { files: CODE, git: true },
    )
    expect(result.real.pointer).toMatch(/^Documents linked to src\/auth\/session\.ts: /)
    expect(result.real.guard).toMatch(/^Linked requirements: /)
    expect(result.real.links).toBeGreaterThan(0)
    expect(result.throughLink).toEqual(result.real)
    expect(result.fromLink).toEqual(result.real)
  }, 30_000)

  test("at most three ids in at most 60 tokens however many records a file has", async () => {
    const many = Array.from(
      { length: 8 },
      (_, index) => `The \`createSession${index}\` MUST log the request id it was given before it returns.`,
    ).join("\n\n")
    const code = Array.from({ length: 8 }, (_, index) => `export function createSession${index}() {}`).join("\n")
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          yield* added(setup, text("Sessions.md", `# Sessions\n\n## 1 Logging\n\n${many}\n`))
          return yield* setup.knowledge.pointers(setup.place, {
            file: "src/sessions.ts",
            personal: true,
            exclude: new Set(),
          })
        }),
      { files: { "src/sessions.ts": `${code}\n` }, git: true },
    )
    expect(result.ids.length).toBeGreaterThan(0)
    expect(result.ids.length).toBeLessThanOrEqual(3)
    expect(result.tokens).toBeLessThanOrEqual(60)
  }, 30_000)
})

describe("repository docs", () => {
  test("a scan's docs are linked together once they are read", async () => {
    const greps: string[] = []
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.$`git add -A`.cwd(setup.root).quiet())
          yield* setup.knowledge.scan(setup.place, { force: true })
          const documents = yield* setup.knowledge.documents(setup.place, { personal: false })
          for (const document of documents) yield* setup.knowledge.wait(setup.place, document.id, "searchable", 20_000)
          // Linked in a batch once the queue is empty, after the docs became searchable.
          for (let tries = 0; tries < 100; tries++) {
            const anchors = yield* anchorsOf(setup)
            if (anchors.length >= 2) return { documents, anchors }
            yield* Effect.sleep(50)
          }
          return { documents, anchors: yield* anchorsOf(setup) }
        }),
      {
        files: {
          ...CODE,
          "docs/auth.md": "# Auth\n\n## Sessions\n\nThe `refreshTokenTtl` MUST be 14 days.\n",
          "docs/config.md": "# Config\n\n## Database\n\nThe server MUST read `DATABASE_URL` at start.\n",
        },
        git: true,
        greps,
      },
    )
    // One pass for all of them: their names in one pattern, their routes in another.
    expect(greps.length).toBeLessThanOrEqual(2)
    expect(result.documents.length).toBeGreaterThanOrEqual(2)
    expect(result.documents.every((document) => document.origin === "repository")).toBe(true)
    expect(result.anchors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/auth/session.ts", symbol: "refreshTokenTtl", method: "definition" }),
        expect.objectContaining({ path: "src/config.ts", symbol: "DATABASE_URL", method: "env" }),
      ]),
    )
  }, 30_000)
})
