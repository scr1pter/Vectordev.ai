import { head, put, BlobNotFoundError } from "@vercel/blob"
import { Buffer } from "node:buffer"

import { CloudAuthorizationError, authorizeCloudRequest } from "../src/authorization"
import { isValidSlug, tenantPromotionPath, tenantSitePath } from "../src/shared"

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return json(405, { ok: false, error: "Method not allowed. POST a promotion payload." })
  }
  const body = await request.json().catch(() => undefined)
  const project = body && typeof body === "object" ? Reflect.get(body, "project") : undefined
  const slug = body && typeof body === "object" ? Reflect.get(body, "slug") : undefined
  if (typeof project !== "string" || !project.trim()) {
    return json(400, { ok: false, error: "'project' must be a non-empty string." })
  }
  if (typeof slug !== "string" || !isValidSlug(slug)) {
    return json(400, { ok: false, error: "'slug' must identify a valid deployment." })
  }

  const claims = (() => {
    try {
      return authorizeCloudRequest(request, project)
    } catch (error) {
      if (error instanceof CloudAuthorizationError) return json(error.status, { ok: false, error: error.message })
      throw error
    }
  })()
  if (claims instanceof Response) return claims

  const exists = await head(tenantSitePath(claims.tenant, claims.project, slug, "index.html"))
    .then(() => true)
    .catch((error: unknown) => {
      if (error instanceof BlobNotFoundError) return false
      throw error
    })
  if (!exists) return json(404, { ok: false, error: "The deployment artifact no longer exists." })

  await put(
    tenantPromotionPath(claims.tenant, claims.project, slug),
    Buffer.from(JSON.stringify({ tenant: claims.tenant, project: claims.project, slug, promotedAt: new Date().toISOString() })),
    {
      access: "public",
      contentType: "application/json; charset=utf-8",
      addRandomSuffix: false,
    },
  )
  const origin = new URL(request.url).origin
  return json(200, {
    ok: true,
    slug,
    tenant: claims.tenant,
    project: claims.project,
    url: `${origin}/p/${claims.tenant}/${claims.project}/`,
  })
}
