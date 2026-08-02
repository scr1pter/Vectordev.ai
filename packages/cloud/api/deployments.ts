import { del, list } from "@vercel/blob"
import { SITES_PREFIX, isValidSlug, uniqueSlugsFromKeys } from "../src/shared"

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

/** Same token gate as the publish function: 500 if unset, 401 on mismatch. */
function authError(request: Request): Response | undefined {
  const expected = process.env["VECTOR_CLOUD_TOKEN"]
  if (!expected) {
    return json(500, {
      ok: false,
      error: "Server misconfigured: VECTOR_CLOUD_TOKEN is not set on this deployment.",
    })
  }
  const auth = request.headers.get("authorization") ?? ""
  if (auth !== `Bearer ${expected}`) {
    return json(401, { ok: false, error: "Unauthorized. Pass 'authorization: Bearer <token>'." })
  }
  return undefined
}

/** GET /api/deployments — list every published site as { slug, url }. */
async function listDeployments(request: Request): Promise<Response> {
  const folders: string[] = []
  let cursor: string | undefined
  try {
    do {
      const page = await list({ prefix: SITES_PREFIX, mode: "folded", cursor })
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
  const deployments = uniqueSlugsFromKeys(folders).map((slug) => ({
    slug,
    url: `${origin}/s/${slug}/`,
  }))
  return json(200, { ok: true, deployments })
}

/** DELETE /api/deployments?slug=<slug> — remove every blob under a site. */
async function deleteDeployment(request: Request): Promise<Response> {
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
      const page = await list({ prefix: `${SITES_PREFIX}${slug}/`, cursor })
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
  const denied = authError(request)
  if (denied) return denied

  if (request.method === "GET") return listDeployments(request)
  if (request.method === "DELETE") return deleteDeployment(request)
  return json(405, { ok: false, error: "Method not allowed. Use GET or DELETE." })
}
