import { head, put, BlobNotFoundError } from "@vercel/blob"
import { Buffer } from "node:buffer"

import { isValidSlug, promotionPath, slugify } from "../src/shared"

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
  const expected = process.env["VECTOR_CLOUD_TOKEN"]
  if (!expected) return json(500, { ok: false, error: "Server misconfigured: VECTOR_CLOUD_TOKEN is not set." })
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return json(401, { ok: false, error: "Unauthorized." })
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

  const exists = await head(`sites/${slug}/index.html`)
    .then(() => true)
    .catch((error: unknown) => {
      if (error instanceof BlobNotFoundError) return false
      throw error
    })
  if (!exists) return json(404, { ok: false, error: "The deployment artifact no longer exists." })

  const projectSlug = slugify(project)
  await put(
    promotionPath(projectSlug, slug),
    Buffer.from(JSON.stringify({ project: projectSlug, slug, promotedAt: new Date().toISOString() })),
    {
      access: "public",
      contentType: "application/json; charset=utf-8",
      addRandomSuffix: false,
    },
  )
  const origin = new URL(request.url).origin
  return json(200, { ok: true, slug, project: projectSlug, url: `${origin}/p/${projectSlug}/` })
}
