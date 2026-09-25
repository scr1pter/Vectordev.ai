import { expect, test } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"

const bundles = new Map(
  ["client", "v2/client", "request"].map((entry) => [
    `/${entry}.js`,
    execFileSync(
      "bun",
      [
        "build",
        fileURLToPath(new URL(`../../../sdk/js/src/${entry}.ts`, import.meta.url)),
        "--target=browser",
        "--format=esm",
      ],
      { encoding: "utf8" },
    ),
  ]),
)
const requests: Array<{ method?: string; url?: string; body: string; contentType?: string }> = []
const server = createServer(async (request, response) => {
  if (bundles.has(request.url ?? "")) {
    response.setHeader("content-type", "application/javascript")
    response.end(bundles.get(request.url!))
    return
  }
  if (request.url === "/") {
    response.setHeader("content-type", "text/html")
    response.end("<!doctype html><title>SDK HTTP receiver</title>")
    return
  }
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const data = {
    method: request.method,
    url: request.url,
    body: Buffer.concat(chunks).toString("base64"),
    contentType: request.headers["content-type"],
  }
  requests.push(data)
  if (request.url?.startsWith("/wait")) return
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify(data))
})
let origin = ""
test.beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing test HTTP port")
  origin = `http://127.0.0.1:${address.port}`
})
test.afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
})

test("both SDK clients send directory-scoped JSON and bodyless GET to a real HTTP server", async ({ page }) => {
  await page.goto(origin)
  requests.length = 0
  await page.evaluate(async () => {
    for (const entry of ["client", "v2/client"]) {
      const url = `/${entry}.js`
      const sdk = await import(url)
      const client = sdk.createVectorClient({ baseUrl: location.origin, directory: "/project space" })
      await client.session.create(entry === "client" ? { body: { title: "same turn" } } : { title: "same turn" })
      await client.session.list()
    }
  })
  expect(
    requests.map((request) => ({
      method: request.method,
      body: Buffer.from(request.body, "base64").toString(),
      directory: new URL(request.url!, origin).searchParams.get("directory"),
    })),
  ).toEqual([
    { method: "POST", body: '{"title":"same turn"}', directory: "/project space" },
    { method: "GET", body: "", directory: "/project space" },
    { method: "POST", body: '{"title":"same turn"}', directory: "/project space" },
    { method: "GET", body: "", directory: "/project space" },
  ])
  expect(
    requests
      .filter((request) => request.method === "POST")
      .every((request) => request.contentType === "application/json"),
  ).toBe(true)
})

test("URL rewriting preserves multipart and binary bytes, headers, and cancellation in Chromium", async ({ page }) => {
  await page.goto(origin)
  const result = await page.evaluate(async () => {
    const moduleURL = "/request.js"
    const sdk = await import(moduleURL)
    const form = new FormData()
    form.set("name", "Vector")
    form.set("file", new Blob([new Uint8Array([0, 1, 254, 255])]), "bytes.bin")
    const multipart = new Request(`${location.origin}/upload`, { method: "POST", body: form })
    const before = await multipart.clone().arrayBuffer()
    const response = await fetch(await sdk.requestWithURL(multipart, new URL(`${multipart.url}?directory=project`)))
    const binary = new Request(`${location.origin}/upload`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-vector-test": "kept" },
      body: new Uint8Array([0, 1, 254, 255]),
    })
    const rewritten = await sdk.requestWithURL(binary, new URL(`${binary.url}?directory=project`))
    const binaryResponse = await fetch(rewritten)
    const abort = new AbortController()
    const pending = fetch(
      await sdk.requestWithURL(
        new Request(`${location.origin}/wait`, { method: "POST", body: "cancel", signal: abort.signal }),
        new URL(`${location.origin}/wait?directory=project`),
      ),
    ).catch((error: Error) => error.name)
    abort.abort()
    return {
      multipart: await response.json(),
      expected: btoa(String.fromCharCode(...new Uint8Array(before))),
      binary: await binaryResponse.json(),
      header: rewritten.headers.get("x-vector-test"),
      aborted: await pending,
    }
  })
  expect(result.multipart.body).toBe(result.expected)
  expect(result.multipart.contentType).toMatch(/^multipart\/form-data; boundary=/)
  expect(result.binary.body).toBe(Buffer.from([0, 1, 254, 255]).toString("base64"))
  expect(result.binary.contentType).toBe("application/octet-stream")
  expect(result.header).toBe("kept")
  expect(result.aborted).toBe("AbortError")
})
