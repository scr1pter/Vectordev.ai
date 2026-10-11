import { del, list } from "@vercel/blob"
import { CloudAuthorizationError, authorizeCloudRequest } from "../src/authorization"
import { isValidSlug, tenantSitesPrefix, uniqueSlugsFromKeys } from "../src/shared"

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

/** GET /api/deployments — list every published site as { slug, url }. */
async function listDeployments(request: Request, claims: { tenant: string; project: string }): Promise<Response> {
  const prefix = tenantSitesPrefix(claims.tenant, claims.project)
  const folders: string[] = []
  let cursor: string | undefined
  try {
    do {
      const page = await list({ prefix, mode: "folded", cursor })
      folders.push(...page.folders)
      cursor = page.hasMore ? page.cursor : undefined
    } while (cursor)
  } catch (error) {
    return json(502, {
      ok: false,
      error: `Blob list failed: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  const origin = new URL(request.url).origin
  const deployments = uniqueSlugsFromKeys(folders, prefix).map((slug) => ({
    slug,
    url: `${origin}/s/${claims.tenant}/${claims.project}/${slug}/`,
  }))
  return json(200, { ok: true, deployments })
}

/** DELETE /api/deployments?slug=<slug> — remove every blob under a site. */
async function deleteDeployment(request: Request, claims: { tenant: string; project: string }): Promise<Response> {
  const url = new URL(request.url)
  let slug = url.searchParams.get("slug") ?? ""
  if (!slug) {
    // Fall back to a JSON body { slug } for clients that prefer it.
    const body = await request.json().catch(() => undefined)
    const fromBody = (body ?? {}) as { slug?: unknown }
    if (typeof fromBody.slug === "string") slug = fromBody.slug
  }
  if (!isValidSlug(slug)) {
    return json(400, { ok: false, error: "A valid 'slug' is required." })
  }

  const urls: string[] = []
  let cursor: string | undefined
  try {
    do {
      const page = await list({ prefix: `${tenantSitesPrefix(claims.tenant, claims.project)}${slug}/`, cursor })
      urls.push(...page.blobs.map((blob) => blob.url))
      cursor = page.hasMore ? page.cursor : undefined
    } while (cursor)
  } catch (error) {
    return json(502, {
      ok: false,
      error: `Blob list failed: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  if (urls.length === 0) {
    return json(404, { ok: false, error: `No deployment found for slug '${slug}'.` })
  }

  try {
    await del(urls)
  } catch (error) {
    return json(502, {
      ok: false,
      error: `Blob delete failed: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
  return json(200, { ok: true, slug })
}

export default async function handler(request: Request): Promise<Response> {
  const claims = (() => {
    try {
      return authorizeCloudRequest(request)
    } catch (error) {
      if (error instanceof CloudAuthorizationError) return json(error.status, { ok: false, error: error.message })
      throw error
    }
  })()
  if (claims instanceof Response) return claims

  if (request.method === "GET") return listDeployments(request, claims)
  if (request.method === "DELETE") return deleteDeployment(request, claims)
  return json(405, { ok: false, error: "Method not allowed. Use GET or DELETE." })
}
