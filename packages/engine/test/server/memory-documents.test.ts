import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "fs/promises"
import path from "path"
import { Flag } from "@vectordevai/core/flag/flag"
import { createVectorClient } from "@vectordevai/sdk/v2"
import { ServerAuth } from "../../src/server/auth"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { lines, pdf } from "../../../core/test/brain/fixture/pdf"

// The document routes under /memory/, over a real listener with an owner and an invited guest, as `vector serve`
// runs them for the app: uploads as multipart form data held in memory, files by path, pasted text, the paged views
// of a document and its records, citations, kept originals, and the gate that keeps all of it the owner's.

const SPEC = `# Auth spec

## 1 Sessions

The client MUST refresh the session before it expires.
Refresh tokens expire after 14 days.

## 2 Limits

Clients MUST retry at most 3 times after a 429 response.
Uploads are limited to 50 MB per file.
`

const MB = 1024 * 1024
const keys = [
  "VECTOR_SERVER_USERNAME",
  "VECTOR_SERVER_PASSWORD",
  "VECTOR_SERVER_GUEST_USERNAME",
  "VECTOR_SERVER_GUEST_PASSWORD",
  "VECTOR_SERVER_GUEST_WORKSPACES",
  "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
  "VECTOR_DISABLE_DEFAULT_PLUGINS",
] as const
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
const basic = (username: string, password: string) => ServerAuth.header({ username, password }) ?? ""
const owner = { authorization: basic("vector", "owner-secret") }
const guest = { authorization: basic("guest", "guest-secret") }

let listener: Awaited<ReturnType<typeof Server.listen>>
let shared: Awaited<ReturnType<typeof tmpdir>>

beforeAll(async () => {
  shared = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
  Object.assign(process.env, {
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
    VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: shared.path }),
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
  })
  Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"
  listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
})

afterAll(async () => {
  await listener.stop(true)
  Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
  for (const key of keys) {
    const value = previous[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await shared[Symbol.asyncDispose]()
})

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const at = (directory: string, route: string) => {
  const url = new URL(route, listener.url)
  url.searchParams.set("directory", directory)
  return url
}
// A listener reused across tests: a pooled keep-alive socket could carry one test's request into another's.
const call = (url: URL, init: RequestInit = {}) => fetch(url, { ...init, keepalive: false })
const json = (directory: string, route: string, method: string, body: unknown, headers = owner) =>
  call(at(directory, route), {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
const get = async (directory: string, route: string) => {
  const response = await call(at(directory, route), { headers: owner })
  expect(response.status).toBe(200)
  return (await response.json()) as any
}
const upload = (directory: string, name: string, bytes: Uint8Array<ArrayBuffer> | string, fields: Record<string, string> = {}) => {
  const form = new FormData()
  form.set("file", new File([bytes], name))
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  return call(at(directory, "/memory/documents"), { method: "POST", headers: owner, body: form })
}
// Documents are read in the background; the app polls the list until it says a document is searchable.
const searchable = async (directory: string, id: string) => {
  for (let tries = 0; tries < 200; tries++) {
    const list = await get(directory, "/memory/documents")
    const document = list.documents.find((item: { id: string }) => item.id === id)
    if (document && ["searchable", "partial", "held", "failed"].includes(document.status) && !list.indexing)
      return document
    await Bun.sleep(50)
  }
  throw new Error(`document ${id} was never read`)
}

describe("memory document routes", () => {
  test("every document route is the owner's own: an invited guest gets 403 on each, and the owner gets in", async () => {
    // The guest may use this workspace (a session list answers), so a 403 below is the owner-only gate itself.
    expect((await call(at(shared.path, "/session"), { headers: guest })).status).toBe(200)
    const form = new FormData()
    form.set("file", new File([SPEC], "spec.md"))
    const routes: [string, string, BodyInit?][] = [
      ["GET", "/memory/documents"],
      ["POST", "/memory/documents", form],
      ["POST", "/memory/documents/path", JSON.stringify({ path: "spec.md" })],
      ["POST", "/memory/documents/text", JSON.stringify({ name: "notes", text: SPEC })],
      ["POST", "/memory/documents/probe", JSON.stringify({ path: "spec.md" })],
      ["GET", "/memory/documents/dnone"],
      ["PATCH", "/memory/documents/dnone", JSON.stringify({ title: "x" })],
      ["DELETE", "/memory/documents/dnone"],
      ["GET", "/memory/documents/dnone/pages/1"],
      ["GET", "/memory/documents/dnone/file"],
      ["GET", "/memory/records"],
      ["GET", "/memory/records/rnone"],
      ["PATCH", "/memory/records/rnone", JSON.stringify({ pinned: true })],
      ["GET", "/memory/knowledge?ids=rnone"],
      ["GET", "/memory/settings"],
      ["PATCH", "/memory/settings", JSON.stringify({ keepOriginals: true })],
    ]
    for (const [method, route, body] of routes) {
      const url = new URL(route, listener.url)
      url.searchParams.set("directory", shared.path)
      const headers = typeof body === "string" ? { ...guest, "content-type": "application/json" } : guest
      const response = await call(url, { method, headers, ...(body ? { body } : {}) })
      expect([method, route, response.status]).toEqual([method, route, 403])
    }
    // Nothing a guest sent was kept, and the owner reads the same list.
    expect((await get(shared.path, "/memory/documents")).documents).toEqual([])
    expect((await get(shared.path, "/memory/settings")).keepOriginals).toBe(false)
  }, 30_000)

  test("an upload over 64 MB is refused before it is read, by its length or as it streams, and nothing is kept", async () => {
    await using tmp = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
    const boundary = "vector-boundary"
    const head = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.md"\r\nContent-Type: text/markdown\r\n\r\n`,
    )
    const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`)
    // With its length declared, as a browser sends a form.
    const whole = new Uint8Array(head.length + 64 * MB + 1 + tail.length).fill(0x61)
    whole.set(head)
    whole.set(tail, whole.length - tail.length)
    const declared = await call(at(tmp.path, "/memory/documents"), {
      method: "POST",
      headers: { ...owner, "content-type": `multipart/form-data; boundary=${boundary}` },
      body: whole,
    })
    expect(declared.status).toBe(413)
    expect(await declared.json()).toMatchObject({ name: "MemoryTooLargeError" })
    const form = await upload(tmp.path, "big.md", new Uint8Array(64 * MB + 1).fill(0x61))
    expect(form.status).toBe(413)
    // Streamed with no length: the form parser stops at the limit.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(head)
        for (let sent = 0; sent < 65 * MB; sent += MB) controller.enqueue(new Uint8Array(MB).fill(0x61))
        controller.enqueue(tail)
        controller.close()
      },
    })
    const streamed = await call(at(tmp.path, "/memory/documents"), {
      method: "POST",
      headers: { ...owner, "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
      // @ts-expect-error - Bun and Node need it for a streamed request body
      duplex: "half",
    })
    expect(streamed.status).toBe(413)
    const text = await json(tmp.path, "/memory/documents/text", "POST", { name: "big", text: "a".repeat(2 * MB + 1) })
    expect(text.status).toBe(413)
    expect((await get(tmp.path, "/memory/documents")).documents).toEqual([])
  }, 60_000)

  test("an upload is read into a document the app can page through, and a file of the same name asks first", async () => {
    await using tmp = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
    const created = await upload(tmp.path, "Auth spec.md", SPEC, { title: "The auth spec" })
    expect(created.status).toBe(200)
    const result = (await created.json()) as { type: string; document: { id: string; title: string } }
    expect(result).toMatchObject({ type: "queued", document: { title: "The auth spec", origin: "upload", visibility: "private" } })
    const id = result.document.id
    expect(await searchable(tmp.path, id)).toMatchObject({ status: "searchable", stored: false, title: "The auth spec" })

    const list = await get(tmp.path, "/memory/documents")
    expect(list).toMatchObject({
      model: { state: "absent" },
      settings: { learning: true, repositoryDocs: true, keepOriginals: false },
      limits: { upload: 64 * MB, text: 2 * MB, documents: 200, repository: 300, perMinute: 20 },
      indexing: false,
    })
    expect(["worker", "in-process"]).toContain(list.worker.mode)

    const detail = await get(tmp.path, `/memory/documents/${id}`)
    expect(detail.outline.map((section: { heading: string }) => section.heading)).toContain("2 Limits")
    expect(detail.records.records.length).toBe(detail.counts.records)
    expect(detail.versions).toEqual([expect.objectContaining({ id, version: 1 })])

    const first = await get(tmp.path, `/memory/records?document=${id}&limit=1`)
    expect(first.records).toHaveLength(1)
    expect(first.cursor).toBe("1")
    const next = await get(tmp.path, `/memory/records?document=${id}&limit=1&cursor=${first.cursor}`)
    expect(next.records[0].id).not.toBe(first.records[0].id)
    const [retry] = (await get(tmp.path, `/memory/records?query=${encodeURIComponent("retry 429")}`)).records
    expect(retry.card).toContain("retry at most 3 times")

    const record = await get(tmp.path, `/memory/records/${retry.id}`)
    expect(record.passage.text).toContain("retry at most 3 times")
    const edited = await json(tmp.path, `/memory/records/${retry.id}`, "PATCH", { text: "Clients give up after three tries.", pinned: true })
    expect(edited.status).toBe(200)
    expect(await edited.json()).toMatchObject({ record: { card: "Clients give up after three tries.", userEdited: true, pinned: true } })
    const memory = await json(tmp.path, `/memory/records/${retry.id}`, "PATCH", { action: "make-memory" })
    expect(await memory.json()).toMatchObject({ entry: { text: "Clients give up after three tries.", private: true } })

    const cards = await get(tmp.path, `/memory/knowledge?ids=${retry.id},${id},rnothing`)
    expect(cards.map((card: { id: string; kind: string }) => [card.id, card.kind])).toEqual([
      [retry.id, "requirement"],
      [id, "document"],
    ])
    const tooMany = await call(at(tmp.path, `/memory/knowledge?ids=${Array.from({ length: 51 }, (_, index) => `r${index}`).join(",")}`), {
      headers: owner,
    })
    expect(tooMany.status).toBe(400)

    // A markdown file has no pages to read one by one, and nothing was kept to download.
    expect((await call(at(tmp.path, `/memory/documents/${id}/pages/1`), { headers: owner })).status).toBe(400)
    expect((await call(at(tmp.path, `/memory/documents/${id}/file`), { headers: owner })).status).toBe(400)

    const asked = await upload(tmp.path, "Auth spec.md", `${SPEC}\nUploads MUST be scanned.\n`)
    expect(asked.status).toBe(400)
    expect(await asked.json()).toMatchObject({ data: { code: "refused", reason: "version", document: { id } } })
    const replaced = await upload(tmp.path, "Auth spec.md", `${SPEC}\nUploads MUST be scanned.\n`, { replace: "true" })
    const version = (await replaced.json()) as { type: string; previous: string; document: { id: string } }
    expect(version).toMatchObject({ type: "version", previous: id })
    await searchable(tmp.path, version.document.id)

    const renamed = await json(tmp.path, `/memory/documents/${version.document.id}`, "PATCH", { title: "Auth spec v2" })
    expect(await renamed.json()).toMatchObject({ id: version.document.id, title: "Auth spec v2", version: 2 })
    const versions = (await get(tmp.path, `/memory/documents/${version.document.id}`)).versions
    expect(versions.map((item: { version: number; status: string }) => [item.version, item.status])).toEqual([
      [2, "searchable"],
      [1, "superseded"],
    ])
    // Forgetting a document forgets every version of it.
    const removed = await call(at(tmp.path, `/memory/documents/${version.document.id}`), { method: "DELETE", headers: owner })
    expect(await removed.json()).toBe(true)
    expect((await call(at(tmp.path, `/memory/documents/${id}`), { headers: owner })).status).toBe(400)
    expect((await get(tmp.path, "/memory/documents")).documents).toEqual([])
  }, 60_000)

  test("path mode reads regular files the owner chose and repository files, and refuses links, pipes and escapes", async () => {
    await using tmp = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
    await using outside = await tmpdir()
    const book = pdf({
      pages: Array.from({ length: 21 }, (_, index) => ({ runs: lines([`Page ${index + 1}: uploads are limited to 50 MB per file.`]) })),
    })
    await fs.writeFile(path.join(outside.path, "book.pdf"), book)
    await fs.writeFile(path.join(outside.path, "secret-plan.md"), "# Plan\n\nThe vault opens at dawn.")
    await fs.writeFile(path.join(tmp.path, "spec.md"), SPEC)
    await fs.symlink(path.join(outside.path, "secret-plan.md"), path.join(tmp.path, "plan.md"))
    await fs.symlink(outside.path, path.join(tmp.path, "linked"))
    execFileSync("mkfifo", [path.join(tmp.path, "pipe.md")])
    const add = (body: Record<string, unknown>) => json(tmp.path, "/memory/documents/path", "POST", body)

    const chosen = await add({ path: path.join(outside.path, "book.pdf") })
    expect(chosen.status).toBe(200)
    expect(await chosen.json()).toMatchObject({ type: "queued", document: { format: "pdf", origin: "upload" } })
    const repository = await add({ path: "spec.md" })
    expect(await repository.json()).toMatchObject({ type: "queued" })
    for (const [file, reason] of [
      ["plan.md", "unsupported"],
      [path.join(tmp.path, "plan.md"), "unsupported"],
      ["pipe.md", "not-found"],
      ["linked/secret-plan.md", "outside"],
      ["missing.md", "not-found"],
      [".env", "secret"],
    ] as const) {
      const response = await add({ path: file, origin: "chat" })
      expect([file, response.status, (await response.json()).data?.reason]).toEqual([file, 400, reason])
    }

    const probe = await json(tmp.path, "/memory/documents/probe", "POST", { path: path.join(outside.path, "book.pdf") })
    expect(await probe.json()).toMatchObject({ format: "pdf", pages: 21, suggest: "remember-instead" })
    const small = await json(tmp.path, "/memory/documents/probe", "POST", { path: "spec.md" })
    expect(await small.json()).toMatchObject({ format: "markdown", suggest: "none" })
    const linked = await json(tmp.path, "/memory/documents/probe", "POST", { path: "plan.md" })
    expect(linked.status).toBe(400)

    const listed = await get(tmp.path, "/memory/documents")
    const id = listed.documents.find((document: { format: string }) => document.format === "pdf").id
    await searchable(tmp.path, id)
    const page = await get(tmp.path, `/memory/documents/${id}/pages/21`)
    expect(page).toMatchObject({ page: 21, pages: 21, unread: false })
    expect(page.passages.map((passage: { text: string }) => passage.text).join("\n")).toContain("Page 21")
    expect((await call(at(tmp.path, `/memory/documents/${id}/pages/22`), { headers: owner })).status).toBe(400)
  }, 60_000)

  test("the generated SDK uploads a file as multipart form data and reads it back", async () => {
    await using tmp = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
    const sdk = createVectorClient({ baseUrl: listener.url.origin, directory: tmp.path, headers: owner })
    const uploaded = await sdk.memory.documents.upload({ file: new File([SPEC], "Auth spec.md"), title: "From the SDK" })
    expect(uploaded.error).toBeUndefined()
    expect(uploaded.data).toMatchObject({ type: "queued", document: { title: "From the SDK", format: "markdown" } })
    await searchable(tmp.path, uploaded.data!.document.id)
    const records = await sdk.memory.records.list({ document: uploaded.data!.document.id, limit: "2" })
    expect(records.data?.records).toHaveLength(2)
    const asked = await sdk.memory.documents.upload({ file: new File([`${SPEC}\nMore.\n`], "Auth spec.md") })
    expect(asked.error).toMatchObject({ data: { reason: "version" } })
  }, 60_000)

  test("a repository that keeps originals serves the kept copy only as a download, and stops when told", async () => {
    await using tmp = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
    const on = await json(tmp.path, "/memory/settings", "PATCH", { keepOriginals: true })
    expect(await on.json()).toMatchObject({ learning: true, keepOriginals: true, repositoryDocs: true })
    const created = (await (await upload(tmp.path, "notes <script>.html", "<h1>Notes</h1><p>Uploads MUST be scanned.</p>")).json()) as {
      document: { id: string }
    }
    const id = created.document.id
    expect(await searchable(tmp.path, id)).toMatchObject({ stored: true })
    const file = await call(at(tmp.path, `/memory/documents/${id}/file`), { headers: owner })
    expect(file.status).toBe(200)
    expect(file.headers.get("content-type")).toBe("application/octet-stream")
    expect(file.headers.get("content-disposition")).toStartWith('attachment; filename="notes _script_.html"')
    expect(file.headers.get("x-content-type-options")).toBe("nosniff")
    expect(file.headers.get("content-security-policy")).toBe("sandbox")
    expect(await file.text()).toBe("<h1>Notes</h1><p>Uploads MUST be scanned.</p>")
    const off = await json(tmp.path, "/memory/settings", "PATCH", { keepOriginals: false })
    expect(await off.json()).toMatchObject({ keepOriginals: false })
    expect((await call(at(tmp.path, `/memory/documents/${id}/file`), { headers: owner })).status).toBe(400)
  }, 60_000)
})
