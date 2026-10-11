import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import {
  CloudAuthorizationError,
  authorizeCloudRequest,
  requireCloudCredentials,
} from "./src/authorization"
import {
  BADGE_MARKER,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  hasFileExtension,
  injectBadge,
  isValidSlug,
  makeSlug,
  mimeFor,
  publicationPathError,
  siteResponseHeaders,
} from "./src/shared"

// Local Vector Cloud: the exact publish + serve contract of the Vercel
// functions, backed by the local filesystem instead of Vercel Blob. This makes
// the whole publish → random link → view loop real and testable without any
// cloud account. The desktop app points VECTOR_CLOUD_URL at this server; the
// production swap is only which host the URL names.

const PORT = Number(process.env.PORT ?? process.env.VECTOR_CLOUD_PORT ?? 8787)
const STORE = resolve(process.env.VECTOR_CLOUD_STORE ?? join(process.cwd(), ".vector-cloud-store"))
if (!Number.isSafeInteger(PORT) || PORT < 0 || PORT > 65_535) throw new Error("VECTOR_CLOUD_PORT must be a valid port")
requireCloudCredentials()

type PublishFile = { path: string; content: string; encoding?: "utf8" | "base64" }

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

function projectDir(tenant: string, project: string) {
  return join(STORE, "tenants", tenant, "projects", project)
}

function siteDir(tenant: string, project: string, slug: string) {
  return join(projectDir(tenant, project), "sites", slug)
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
  const project = body && typeof body === "object" ? Reflect.get(body, "project") : undefined
  const allowSourceFiles = Boolean(body && typeof body === "object" && Reflect.get(body, "allowSourceFiles") === true)
  const claims = authorize(request, typeof project === "string" ? project : undefined)
  if (claims instanceof Response) return claims
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
    const pathError = publicationPathError(file.path, allowSourceFiles)
    if (pathError) return json(400, { ok: false, error: `Refusing to publish '${file.path}': ${pathError}.` })
    const buffer = Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8")
    total += buffer.byteLength
    if (total > MAX_TOTAL_BYTES) return json(413, { ok: false, error: "Bundle exceeds the 10 MB limit." })
    decoded.push({ path: file.path, buffer })
  }
  if (!decoded.some((file) => file.path === "index.html")) {
    return json(400, { ok: false, error: "An index.html at the root is required." })
  }

  const slug = makeSlug(name)
  const dir = siteDir(claims.tenant, claims.project, slug)
  for (const file of decoded) {
    let buffer = file.buffer
    if (file.path === "index.html" && !file.buffer.toString("utf8").includes(BADGE_MARKER)) {
      buffer = Buffer.from(injectBadge(file.buffer.toString("utf8")), "utf8")
    }
    const target = join(dir, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, buffer)
  }
  return json(200, {
    ok: true,
    slug,
    tenant: claims.tenant,
    project: claims.project,
    url: `${origin}/s/${claims.tenant}/${claims.project}/${slug}/`,
  })
}

async function handleSite(tenant: string, project: string, slug: string, rawPath: string): Promise<Response> {
  const dir = siteDir(tenant, project, slug)
  const requested = decodeSitePath(rawPath || "index.html")
  if (!requested) return handleSiteNotFound()
  if (publicationPathError(requested, true)) return handleSiteNotFound()
  const tryFiles = [requested]
  // Extensionless routes fall back to the SPA entry, matching the Vercel fn.
  if (!hasFileExtension(requested)) tryFiles.push("index.html")

  for (const candidate of tryFiles) {
    if (publicationPathError(candidate, true)) continue
    const buffer = await readFile(join(dir, candidate)).catch(() => undefined)
    if (buffer) {
      return new Response(buffer, {
        status: 200,
        headers: siteResponseHeaders(mimeFor(candidate)),
      })
    }
  }
  return handleSiteNotFound()
}

function decodeSitePath(input: string) {
  let decoded = input
  try {
    while (decoded.includes("%")) {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    }
    return decoded
  } catch {
    return
  }
}

function handleSiteNotFound() {
  return new Response(
    `<!doctype html><meta charset=utf-8><title>Not found</title><body style="background:#17161a;color:#f5f3ff;font-family:Inter,system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1>This Vector site doesn't exist</h1><p style="color:#b4b1bb">It may have been unpublished. <a style="color:#ad95f5" href="https://vectordev.ai">vectordev.ai</a></p></div>`,
    { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
  )
}

function localHostPort(host: string | null) {
  const match = /^(?:127\.0\.0\.1|localhost):(\d{1,5})$/.exec(host?.toLowerCase() ?? "")
  if (!match) return undefined
  const port = Number(match[1])
  if (port < 1 || port > 65_535 || (PORT !== 0 && port !== PORT)) return undefined
  return port
}

// GET /api/deployments — list every published site (one subdir per slug).
async function handleListDeployments(request: Request, origin: string): Promise<Response> {
  const claims = authorize(request)
  if (claims instanceof Response) return claims

  // The store may not exist yet (nothing published); treat that as empty.
  const entries = await readdir(join(projectDir(claims.tenant, claims.project), "sites"), { withFileTypes: true }).catch(() => [])
  const deployments = entries
    .filter((entry) => entry.isDirectory() && isValidSlug(entry.name))
    .map((entry) => ({
      slug: entry.name,
      url: `${origin}/s/${claims.tenant}/${claims.project}/${entry.name}/`,
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug))
  return json(200, { ok: true, deployments })
}

// DELETE /api/deployments?slug=<slug> — remove a published site's directory.
async function handleDeleteDeployment(request: Request, slug: string): Promise<Response> {
  const claims = authorize(request)
  if (claims instanceof Response) return claims
  if (!isValidSlug(slug)) return json(400, { ok: false, error: "A valid 'slug' is required." })

  const dir = siteDir(claims.tenant, claims.project, slug)
  // Only a directory that actually exists counts as a deployment to delete.
  const exists = await readdir(dir).then(() => true).catch(() => false)
  if (!exists) return json(404, { ok: false, error: `No deployment found for slug '${slug}'.` })

  await rm(dir, { recursive: true, force: true })
  return json(200, { ok: true, slug })
}

async function handlePromote(request: Request, origin: string): Promise<Response> {
  const body = await request.json().catch(() => undefined)
  const project = body && typeof body === "object" ? Reflect.get(body, "project") : undefined
  const slug = body && typeof body === "object" ? Reflect.get(body, "slug") : undefined
  if (typeof project !== "string" || !project.trim()) {
    return json(400, { ok: false, error: "A project is required." })
  }
  if (typeof slug !== "string" || !isValidSlug(slug)) {
    return json(400, { ok: false, error: "A valid deployment slug is required." })
  }
  const claims = authorize(request, project)
  if (claims instanceof Response) return claims
  const exists = await readFile(join(siteDir(claims.tenant, claims.project, slug), "index.html"))
    .then(() => true)
    .catch(() => false)
  if (!exists) return json(404, { ok: false, error: "The deployment artifact no longer exists." })
  const production = join(projectDir(claims.tenant, claims.project), ".production")
  await mkdir(production, { recursive: true })
  await writeFile(join(production, "current.json"), JSON.stringify({ slug, promotedAt: new Date().toISOString() }))
  return json(200, {
    ok: true,
    slug,
    tenant: claims.tenant,
    project: claims.project,
    url: `${origin}/p/${claims.tenant}/${claims.project}/`,
  })
}

async function productionSlug(tenant: string, project: string): Promise<string | undefined> {
  const body = await readFile(join(projectDir(tenant, project), ".production", "current.json"), "utf8").catch(
    () => undefined,
  )
  if (!body) return undefined
  const parsed: unknown = await Promise.resolve(body)
    .then((value) => JSON.parse(value))
    .catch(() => undefined)
  const slug = parsed && typeof parsed === "object" ? Reflect.get(parsed, "slug") : undefined
  return typeof slug === "string" && isValidSlug(slug) ? slug : undefined
}

function authorize(request: Request, project?: string) {
  try {
    return authorizeCloudRequest(request, project)
  } catch (error) {
    if (error instanceof CloudAuthorizationError) return json(error.status, { ok: false, error: error.message })
    throw error
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(request) {
    const port = localHostPort(request.headers.get("host"))
    if (!port) {
      return json(421, { ok: false, error: "Host is not allowed by the local cloud server." })
    }
    const url = new URL(request.url)
    const origin = `http://127.0.0.1:${port}`
    if (url.pathname === "/api/publish" && request.method === "POST") return handlePublish(request, origin)
    if (url.pathname === "/api/promote" && request.method === "POST") return handlePromote(request, origin)
    if (url.pathname === "/api/deployments") {
      if (request.method === "GET") return handleListDeployments(request, origin)
      if (request.method === "DELETE") {
        return handleDeleteDeployment(request, url.searchParams.get("slug") ?? "")
      }
      return json(405, { ok: false, error: "Method not allowed. Use GET or DELETE." })
    }
    const match = /^\/s\/([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)(?:\/(.*))?$/.exec(
      url.pathname,
    )
    if (match && request.method === "GET") return handleSite(match[1], match[2], match[3], match[4] ?? "")
    const production = /^\/p\/([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)(?:\/(.*))?$/.exec(url.pathname)
    if (production && request.method === "GET") {
      const slug = await productionSlug(production[1], production[2])
      if (slug) return handleSite(production[1], production[2], slug, production[3] ?? "")
    }
    if (url.pathname === "/health") return json(200, { ok: true })
    return json(404, { ok: false, error: "Not found." })
  },
})

// eslint-disable-next-line no-console
console.log(`Vector Cloud (local) on http://127.0.0.1:${server.port}  ·  store: ${STORE}`)
