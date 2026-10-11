import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const cleanup: (() => unknown)[] = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

test("published and promoted local sites are sandboxed and cannot serve private files", async () => {
  const store = await mkdtemp(path.join(tmpdir(), "vector-cloud-isolation-"))
  const tenant = "tenant-test"
  const project = "isolation-test"
  cleanup.push(() => rm(store, { recursive: true, force: true }))
  const child = Bun.spawn([process.execPath, "dev-server.ts"], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      PORT: "0",
      VECTOR_CLOUD_STORE: store,
      VECTOR_CLOUD_TOKEN: "test-publish-token",
      VECTOR_CLOUD_TENANT: tenant,
      VECTOR_CLOUD_PROJECT: project,
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
  const headers = { authorization: "Bearer test-publish-token", "content-type": "application/json" }
  expect((await fetch(`${origin}/health`, { headers: { host: `attacker.example:${port}` } })).status).toBe(421)
  const published = await fetch(`${origin}/api/publish`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Isolation test",
      files: [
        { path: "index.html", content: '<html><body><script type="module" src="./app.js"></script></body></html>' },
        { path: "app.js", content: 'document.body.dataset.loaded = "yes"' },
        { path: ".well-known/security.txt", content: "Contact: mailto:security@example.test" },
      ],
    }),
  })
  expect(published.status).toBe(200)
  const payload: unknown = await published.json()
  const slug = payload && typeof payload === "object" ? Reflect.get(payload, "slug") : undefined
  if (typeof slug !== "string") throw new Error("Publish did not return a deployment slug.")
  await writeFile(path.join(store, "tenants", tenant, "projects", project, "sites", slug, ".env"), "PRIVATE_SENTINEL")

  const page = await fetch(`${origin}/s/${tenant}/${project}/${slug}/`)
  expect(page.status).toBe(200)
  expect(page.headers.get("content-security-policy")).toContain("sandbox allow-scripts")
  expect(page.headers.get("content-security-policy")).not.toContain("allow-same-origin")
  expect(page.headers.get("content-security-policy")).toContain("worker-src 'none'")
  expect(page.headers.get("x-content-type-options")).toBe("nosniff")
  const module = await fetch(`${origin}/s/${tenant}/${project}/${slug}/app.js`, { headers: { origin: "null" } })
  expect(module.headers.get("access-control-allow-origin")).toBe("*")
  expect(module.headers.get("content-type")).toContain("text/javascript")
  expect(await module.text()).toContain('dataset.loaded = "yes"')
  expect((await fetch(`${origin}/s/${tenant}/${project}/${slug}/.well-known/security.txt`)).status).toBe(200)
  expect((await fetch(`${origin}/s/${tenant}/${project}/${slug}/nested/route`)).status).toBe(200)

  for (const file of [".env", ".git/config", "app.js.map", "%252eenv"]) {
    const response = await fetch(`${origin}/s/${tenant}/${project}/${slug}/${file}`)
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain("PRIVATE_SENTINEL")
  }
  const refused = await fetch(`${origin}/api/publish`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Secrets",
      files: [
        { path: "index.html", content: "ok" },
        { path: ".env", content: "private" },
      ],
    }),
  })
  expect(refused.status).toBe(400)
  const promoted = await fetch(`${origin}/api/promote`, {
    method: "POST",
    headers,
    body: JSON.stringify({ project, slug }),
  })
  expect(promoted.status).toBe(200)
  const production = await fetch(`${origin}/p/${tenant}/${project}/`)
  expect(production.status).toBe(200)
  expect(production.headers.get("content-security-policy")).toBe(page.headers.get("content-security-policy"))
}, 10_000)
