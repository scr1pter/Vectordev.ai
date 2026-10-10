import { head, list, BlobNotFoundError } from "@vercel/blob"
import {
  hasFileExtension,
  isValidSlug,
  mimeFor,
  publicationPathError,
  siteResponseHeaders,
  tenantPromotionPrefix,
  tenantSitePath,
} from "../src/shared"

const NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Site not found - Vector</title>
</head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#100f13;color:#f5f3ff;font-family:Inter,system-ui,sans-serif;text-align:center">
  <main>
    <div style="width:12px;height:12px;margin:0 auto 16px;border-radius:999px;background:linear-gradient(135deg,#f0a36e,#ec7fae,#9374ec,#6ba6dd)"></div>
    <h1 style="font-size:20px;font-weight:600;margin:0 0 8px">This Vector site doesn't exist</h1>
    <p style="margin:0 0 20px;color:#9b96a8;font-size:14px">It may have been unpublished, or the link is wrong.</p>
    <a href="https://vectordev.ai" style="color:#b7a4f4;font-size:14px;text-decoration:none">vectordev.ai &rarr;</a>
  </main>
</body>
</html>
`

function notFound(): Response {
  return new Response(NOT_FOUND_HTML, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  })
}

async function resolveBlobUrl(tenant: string, project: string, slug: string, path: string): Promise<string | undefined> {
  try {
    const blob = await head(tenantSitePath(tenant, project, slug, path))
    return blob.url
  } catch (error) {
    if (error instanceof BlobNotFoundError) return undefined
    throw error
  }
}

const productionCache = new Map<string, { slug: string; expiresAt: number }>()

async function resolveProductionSlug(tenant: string, project: string): Promise<string | undefined> {
  const key = `${tenant}/${project}`
  const cached = productionCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.slug
  const records = await list({ prefix: tenantPromotionPrefix(tenant, project), limit: 1000 })
  const latest = records.blobs.toSorted(
    (a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime(),
  )[0]
  if (!latest) return undefined
  const payload = await fetch(latest.url).then((response) => response.json()).catch(() => undefined)
  const slug = payload && typeof payload === "object" ? Reflect.get(payload, "slug") : undefined
  if (typeof slug !== "string" || !isValidSlug(slug)) return undefined
  productionCache.set(key, { slug, expiresAt: Date.now() + 15_000 })
  return slug
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 })
  }

  const url = new URL(request.url)
  const tenant = url.searchParams.get("tenant") ?? ""
  const project = url.searchParams.get("project") ?? ""
  const requestedSlug = url.searchParams.get("slug") ?? ""
  const slug = requestedSlug ||
    (isValidSlug(tenant) && isValidSlug(project) ? await resolveProductionSlug(tenant, project) ?? "" : "")
  const rawPath = (url.searchParams.get("path") ?? "").replace(/^\/+|\/+$/g, "")

  if (!isValidSlug(tenant) || !isValidSlug(project) || !isValidSlug(slug)) return notFound()
  const path = rawPath === "" ? "index.html" : rawPath
  if (publicationPathError(path, true)) return notFound()

  let resolvedPath = path
  let blobUrl = await resolveBlobUrl(tenant, project, slug, resolvedPath)

  // SPA-ish fallback: extensionless routes fall back to the site's index.html.
  if (!blobUrl && !hasFileExtension(path)) {
    resolvedPath = "index.html"
    blobUrl = await resolveBlobUrl(tenant, project, slug, resolvedPath)
  }
  if (!blobUrl) return notFound()

  const upstream = await fetch(blobUrl)
  if (!upstream.ok) return notFound()

  return new Response(upstream.body, {
    status: 200,
    headers: siteResponseHeaders(upstream.headers.get("content-type") ?? mimeFor(resolvedPath)),
  })
}
