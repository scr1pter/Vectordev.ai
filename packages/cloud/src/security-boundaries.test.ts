import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { CloudAuthorizationError, authorizeCloudRequest, requireCloudCredentials } from "./authorization"
import {
  publicationPathError,
  siteResponseHeaders,
  tenantPromotionPath,
  tenantSitePath,
  tenantSitesPrefix,
} from "./shared"

const cleanup: (() => unknown)[] = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

describe("cloud bearer claims", () => {
  const env = {
    VECTOR_CLOUD_CREDENTIALS: JSON.stringify([
      { token: "tenant-a-project-a-token", tenant: "tenant-a", projects: ["project-a"] },
      { token: "tenant-b-project-b-token", tenant: "tenant-b", projects: ["project-b"] },
    ]),
  }

  test("binds a bearer credential to its tenant and project", () => {
    const request = new Request("https://cloud.example/api/deployments", {
      headers: { authorization: "Bearer tenant-a-project-a-token" },
    })
    expect(authorizeCloudRequest(request, "Project A", env)).toEqual({ tenant: "tenant-a", project: "project-a" })
    expect(() => authorizeCloudRequest(request, "project-b", env)).toThrow(CloudAuthorizationError)
  })

  test("rejects missing claims, weak defaults, and duplicate credentials", () => {
    expect(() => requireCloudCredentials({ VECTOR_CLOUD_TOKEN: "explicit-long-token" })).toThrow("VECTOR_CLOUD_TENANT")
    expect(() =>
      requireCloudCredentials({
        VECTOR_CLOUD_TOKEN: "local-dev-token",
        VECTOR_CLOUD_TENANT: "tenant-a",
        VECTOR_CLOUD_PROJECT: "project-a",
      }),
    ).toThrow("explicit")
    expect(() =>
      requireCloudCredentials({
        VECTOR_CLOUD_CREDENTIALS: JSON.stringify([
          { token: "same-credential-value", tenant: "tenant-a", projects: ["project-a"] },
          { token: "same-credential-value", tenant: "tenant-b", projects: ["project-b"] },
        ]),
      }),
    ).toThrow("unique")
  })
})

describe("cloud publication boundaries", () => {
  test.each([".env", ".env.production", "config/.env.local", ".git/config", ".github/workflow.yml", ".npmrc"])(
    "always rejects private path %s",
    (path) => expect(publicationPathError(path, true)).toBeDefined(),
  )

  test.each(["app.ts", "src/view.tsx", "styles.scss", "app.js.map"])("requires opt-in for source path %s", (path) => {
    expect(publicationPathError(path)).toContain("allowSourceFiles")
    expect(publicationPathError(path, true)).toBeUndefined()
  })

  test("keeps tenant site and promotion keys disjoint", () => {
    expect(tenantSitesPrefix("tenant-a", "project-a")).toBe("tenants/tenant-a/projects/project-a/sites/")
    expect(tenantSitePath("tenant-a", "project-a", "site-123", "index.html")).not.toBe(
      tenantSitePath("tenant-b", "project-a", "site-123", "index.html"),
    )
    expect(tenantPromotionPath("tenant-a", "project-a", "site-123", 42)).toBe(
      "tenants/tenant-a/projects/project-a/promotions/42-site-123.json",
    )
  })

  test("serves public sites in an opaque-origin CSP sandbox", () => {
    const headers = siteResponseHeaders("text/html; charset=utf-8")
    expect(headers["content-security-policy"]).toContain("sandbox allow-scripts")
    expect(headers["content-security-policy"]).not.toContain("allow-same-origin")
    expect(headers["content-security-policy"]).toContain("worker-src 'none'")
    expect(headers["x-content-type-options"]).toBe("nosniff")
  })
})

test("production APIs reject cross-project administration and private publication before storage", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
process.env.VECTOR_CLOUD_CREDENTIALS = JSON.stringify([
  { token: "tenant-a-project-a-token", tenant: "tenant-a", projects: ["project-a"] }
])
const publish = (await import(${JSON.stringify(new URL("../api/publish.ts", import.meta.url).href)})).default
const deployments = (await import(${JSON.stringify(new URL("../api/deployments.ts", import.meta.url).href)})).default
const promote = (await import(${JSON.stringify(new URL("../api/promote.ts", import.meta.url).href)})).default
const site = (await import(${JSON.stringify(new URL("../api/site.ts", import.meta.url).href)})).default
const headers = { authorization: "Bearer tenant-a-project-a-token", "content-type": "application/json" }
const results = []
results.push((await publish(new Request("https://cloud.example/api/publish", {
  method: "POST", headers,
  body: JSON.stringify({ name: "private", files: [{ path: "index.html", content: "ok" }, { path: ".env", content: "secret" }] })
}))).status)
results.push((await publish(new Request("https://cloud.example/api/publish", {
  method: "POST", headers,
  body: JSON.stringify({ name: "cross", project: "project-b", files: [{ path: "index.html", content: "ok" }] })
}))).status)
results.push((await deployments(new Request("https://cloud.example/api/deployments", {
  headers: { authorization: "Bearer wrong-tenant-credential" }
}))).status)
results.push((await promote(new Request("https://cloud.example/api/promote", {
  method: "POST", headers,
  body: JSON.stringify({ project: "project-b", slug: "site-123" })
}))).status)
results.push((await site(new Request("https://cloud.example/api/site?tenant=tenant-a&project=project-a&slug=site-123&path=.env"))).status)
await Bun.write(Bun.stdout, JSON.stringify(results))
`,
    ],
    { stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(10_000) },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
  expect(JSON.parse(stdout)).toEqual([400, 403, 401, 403, 404])
})

test("local cloud enforces Host, credential, tenant, publication, and site isolation", async () => {
  const store = await mkdtemp(join(tmpdir(), "vector-cloud-boundaries-"))
  cleanup.push(() => rm(store, { recursive: true, force: true }))
  const credentials = [
    { token: "tenant-a-project-a-token", tenant: "tenant-a", projects: ["project-a"] },
    { token: "tenant-b-project-b-token", tenant: "tenant-b", projects: ["project-b"] },
  ]
  const child = Bun.spawn([process.execPath, "dev-server.ts"], {
    cwd: resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      PORT: "0",
      VECTOR_CLOUD_STORE: store,
      VECTOR_CLOUD_CREDENTIALS: JSON.stringify(credentials),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  cleanup.push(async () => {
    child.kill()
    await child.exited
  })
  const output = await child.stdout.getReader().read()
  const port = new TextDecoder().decode(output.value).match(/127\.0\.0\.1:(\d+)/)?.[1]
  expect(port).toBeDefined()
  const origin = `http://127.0.0.1:${port}`
  expect((await fetch(`${origin}/health`, { headers: { host: `attacker.example:${port}` } })).status).toBe(421)

  const headers = { authorization: `Bearer ${credentials[0].token}`, "content-type": "application/json" }
  const privateFile = await fetch(`${origin}/api/publish`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "private", files: [{ path: "index.html", content: "ok" }, { path: ".env", content: "secret" }] }),
  })
  expect(privateFile.status).toBe(400)
  const sourceFile = await fetch(`${origin}/api/publish`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "source", files: [{ path: "index.html", content: "ok" }, { path: "app.ts", content: "source" }] }),
  })
  expect(sourceFile.status).toBe(400)

  const published = await fetch(`${origin}/api/publish`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "isolated",
      files: [{ path: "index.html", content: "<html><body>tenant a</body></html>" }],
    }),
  })
  expect(published.status).toBe(200)
  const payload = (await published.json()) as { slug: string; url: string }
  expect(payload.url).toBe(`${origin}/s/tenant-a/project-a/${payload.slug}/`)
  await mkdir(join(store, "tenants", "tenant-a", "projects", "project-a", "sites", payload.slug), { recursive: true })
  await writeFile(join(store, "tenants", "tenant-a", "projects", "project-a", "sites", payload.slug, ".env"), "secret")
  const page = await fetch(payload.url)
  expect(page.headers.get("content-security-policy")).toContain("sandbox allow-scripts")
  expect(page.headers.get("content-security-policy")).not.toContain("allow-same-origin")
  expect((await fetch(`${payload.url}.env`)).status).toBe(404)

  const otherHeaders = { authorization: `Bearer ${credentials[1].token}` }
  const otherList: unknown = await fetch(`${origin}/api/deployments`, { headers: otherHeaders }).then((response) =>
    response.json(),
  )
  expect(otherList && typeof otherList === "object" ? Reflect.get(otherList, "deployments") : undefined).toEqual([])
  const otherDelete = await fetch(`${origin}/api/deployments?slug=${payload.slug}`, {
    method: "DELETE",
    headers: otherHeaders,
  })
  expect(otherDelete.status).toBe(404)
  const crossProject = await fetch(`${origin}/api/promote`, {
    method: "POST",
    headers,
    body: JSON.stringify({ project: "project-b", slug: payload.slug }),
  })
  expect(crossProject.status).toBe(403)
}, 10_000)
