import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import {
  BADGE_MARKER,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  hasFileExtension,
  injectBadge,
  isValidFilePath,
  isValidSlug,
  makeSlug,
  mimeFor,
  slugify,
} from "./src/shared"

// Local Vector Cloud: the exact publish + serve contract of the Vercel
// functions, backed by the local filesystem instead of Vercel Blob. This makes
// the whole publish → random link → view loop real and testable without any
// cloud account. The desktop app points VECTOR_CLOUD_URL at this server; the
// production swap is only which host the URL names.

const PORT = Number(process.env.PORT ?? process.env.VECTOR_CLOUD_PORT ?? 8787)
const TOKEN = process.env.VECTOR_CLOUD_TOKEN ?? "local-dev-token"
const STORE = resolve(process.env.VECTOR_CLOUD_STORE ?? join(process.cwd(), ".vector-cloud-store"))
const PRODUCTION = join(STORE, ".production")

type PublishFile = { path: string; content: string; encoding?: "utf8" | "base64" }

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

function siteDir(slug: string) {
  // slug is validated (DNS label grammar) before it reaches here, so it cannot
  // escape the store directory.
  return join(STORE, slug)
}

function isPublishFile(value: unknown): value is PublishFile {
  if (!value || typeof value !== "object") return false
  const path = Reflect.get(value, "path")
  const content = Reflect.get(value, "content")
  const encoding = Reflect.get(value, "encoding")
  return typeof path === "string" &&
    typeof content === "string" &&
    (encoding === undefined || encoding === "utf8" || encoding === "base64")
}

async function handlePublish(request: Request, origin: string): Promise<Response> {
  const auth = request.headers.get("authorization")
  if (auth !== `Bearer ${TOKEN}`) return json(401, { ok: false, error: "Invalid or missing token." })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json(400, { ok: false, error: "Body must be JSON." })
  }
  const name = body && typeof body === "object" && typeof Reflect.get(body, "name") === "string"
    ? Reflect.get(body, "name")
    : ""
  const rawFiles = body && typeof body === "object" ? Reflect.get(body, "files") : undefined
  const files = Array.isArray(rawFiles) ? rawFiles : []
  if (!name.trim()) return json(400, { ok: false, error: "A name is required." })
  if (!files.length) return json(400, { ok: false, error: "No files to publish." })
  if (files.length > MAX_FILES) return json(400, { ok: false, error: `Too many files (max ${MAX_FILES}).` })

  let total = 0
  const decoded: { path: string; buffer: Buffer }[] = []
  for (const file of files) {
    if (!isPublishFile(file)) {
      return json(400, { ok: false, error: "Each file needs a string path and content." })
    }
    if (!isValidFilePath(file.path)) return json(400, { ok: false, error: `Invalid file path: ${file.path}` })
    const buffer = Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8")
    total += buffer.byteLength
    if (total > MAX_TOTAL_BYTES) return json(413, { ok: false, error: "Bundle exceeds the 10 MB limit." })
    decoded.push({ path: file.path, buffer })
  }
  if (!decoded.some((file) => file.path === "index.html")) {
    return json(400, { ok: false, error: "An index.html at the root is required." })
  }

  const slug = makeSlug(name)
  const dir = siteDir(slug)
  for (const file of decoded) {
    let buffer = file.buffer
    if (file.path === "index.html" && !file.buffer.toString("utf8").includes(BADGE_MARKER)) {
      buffer = Buffer.from(injectBadge(file.buffer.toString("utf8")), "utf8")
    }
    const target = join(dir, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, buffer)
  }
  return json(200, { ok: true, slug, url: `${origin}/s/${slug}/` })
}

async function handleSite(slug: string, rawPath: string): Promise<Response> {
  const dir = siteDir(slug)
  const requested = rawPath || "index.html"
  const tryFiles = [requested]
  // Extensionless routes fall back to the SPA entry, matching the Vercel fn.
  if (!hasFileExtension(requested)) tryFiles.push("index.html")

  for (const candidate of tryFiles) {
    if (!isValidFilePath(candidate)) continue
    const buffer = await readFile(join(dir, candidate)).catch(() => undefined)
    if (buffer) {
      return new Response(buffer, {
        status: 200,
        headers: { "content-type": mimeFor(candidate), "cache-control": "public, max-age=60" },
      })
    }
  }
  return new Response(
    `<!doctype html><meta charset=utf-8><title>Not found</title><body style="background:#17161a;color:#f5f3ff;font-family:Inter,system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1>This Vector site doesn't exist</h1><p style="color:#b4b1bb">It may have been unpublished. <a style="color:#ad95f5" href="https://vectordev.ai">vectordev.ai</a></p></div>`,
    { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
  )
}

// GET /api/deployments — list every published site (one subdir per slug).
async function handleListDeployments(request: Request, origin: string): Promise<Response> {
  const auth = request.headers.get("authorization")
  if (auth !== `Bearer ${TOKEN}`) return json(401, { ok: false, error: "Invalid or missing token." })

  // The store may not exist yet (nothing published); treat that as empty.
  const entries = await readdir(STORE, { withFileTypes: true }).catch(() => [])
  const deployments = entries
    .filter((entry) => entry.isDirectory() && isValidSlug(entry.name))
    .map((entry) => ({ slug: entry.name, url: `${origin}/s/${entry.name}/` }))
    .sort((a, b) => a.slug.localeCompare(b.slug))
  return json(200, { ok: true, deployments })
}

// DELETE /api/deployments?slug=<slug> — remove a published site's directory.
async function handleDeleteDeployment(request: Request, slug: string): Promise<Response> {
  const auth = request.headers.get("authorization")
  if (auth !== `Bearer ${TOKEN}`) return json(401, { ok: false, error: "Invalid or missing token." })
  if (!isValidSlug(slug)) return json(400, { ok: false, error: "A valid 'slug' is required." })

  const dir = siteDir(slug)
  // Only a directory that actually exists counts as a deployment to delete.
  const exists = await readdir(dir).then(() => true).catch(() => false)
  if (!exists) return json(404, { ok: false, error: `No deployment found for slug '${slug}'.` })

  await rm(dir, { recursive: true, force: true })
  return json(200, { ok: true, slug })
}

async function handlePromote(request: Request, origin: string): Promise<Response> {
  const auth = request.headers.get("authorization")
  if (auth !== `Bearer ${TOKEN}`) return json(401, { ok: false, error: "Invalid or missing token." })
  const body = await request.json().catch(() => undefined)
  const project = body && typeof body === "object" ? Reflect.get(body, "project") : undefined
  const slug = body && typeof body === "object" ? Reflect.get(body, "slug") : undefined
  if (typeof project !== "string" || !project.trim()) {
    return json(400, { ok: false, error: "A project is required." })
  }
  if (typeof slug !== "string" || !isValidSlug(slug)) {
    return json(400, { ok: false, error: "A valid deployment slug is required." })
  }
  const exists = await readFile(join(siteDir(slug), "index.html")).then(() => true).catch(() => false)
  if (!exists) return json(404, { ok: false, error: "The deployment artifact no longer exists." })
  const projectSlug = slugify(project)
  await mkdir(PRODUCTION, { recursive: true })
  await writeFile(join(PRODUCTION, `${projectSlug}.json`), JSON.stringify({ slug, promotedAt: new Date().toISOString() }))
  return json(200, { ok: true, slug, project: projectSlug, url: `${origin}/p/${projectSlug}/` })
}

async function productionSlug(project: string): Promise<string | undefined> {
  const body = await readFile(join(PRODUCTION, `${project}.json`), "utf8").catch(() => undefined)
  if (!body) return undefined
  const parsed: unknown = await Promise.resolve(body)
    .then((value) => JSON.parse(value))
    .catch(() => undefined)
  const slug = parsed && typeof parsed === "object" ? Reflect.get(parsed, "slug") : undefined
  return typeof slug === "string" && isValidSlug(slug) ? slug : undefined
}

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url)
    const origin = url.origin
    if (url.pathname === "/api/publish" && request.method === "POST") return handlePublish(request, origin)
    if (url.pathname === "/api/promote" && request.method === "POST") return handlePromote(request, origin)
    if (url.pathname === "/api/deployments") {
      if (request.method === "GET") return handleListDeployments(request, origin)
      if (request.method === "DELETE") {
        return handleDeleteDeployment(request, url.searchParams.get("slug") ?? "")
      }
      return json(405, { ok: false, error: "Method not allowed. Use GET or DELETE." })
    }
    const match = /^\/s\/([a-z0-9][a-z0-9-]*)(?:\/(.*))?$/.exec(url.pathname)
    if (match && request.method === "GET") return handleSite(match[1], match[2] ?? "")
    const production = /^\/p\/([a-z0-9][a-z0-9-]*)(?:\/(.*))?$/.exec(url.pathname)
    if (production && request.method === "GET") {
      const slug = await productionSlug(production[1])
      if (slug) return handleSite(slug, production[2] ?? "")
    }
    if (url.pathname === "/health") return json(200, { ok: true })
    return json(404, { ok: false, error: "Not found." })
  },
})

// eslint-disable-next-line no-console
console.log(`Vector Cloud (local) on http://localhost:${server.port}  ·  store: ${STORE}`)
