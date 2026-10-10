import { put } from "@vercel/blob"
import { Buffer } from "node:buffer"
import { CloudAuthorizationError, authorizeCloudRequest } from "../src/authorization"
import {
  MAX_FILES,
  MAX_TOTAL_BYTES,
  injectBadge,
  makeSlug,
  mimeFor,
  publicationPathError,
  tenantSitePath,
} from "../src/shared"

interface PublishFile {
  path: string
  content: string
  encoding?: "utf8" | "base64"
}

interface PublishBody {
  name: string
  files: PublishFile[]
  project?: string
  allowSourceFiles?: boolean
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

function isPublishFile(value: unknown): value is PublishFile {
  if (typeof value !== "object" || value === null) return false
  const path = Reflect.get(value, "path")
  const content = Reflect.get(value, "content")
  const encoding = Reflect.get(value, "encoding")
  if (typeof path !== "string") return false
  if (typeof content !== "string") return false
  if (encoding !== undefined && encoding !== "utf8" && encoding !== "base64") return false
  return true
}

/** Upload with bounded concurrency so 200-file sites don't open 200 sockets. */
async function uploadAll(uploads: (() => Promise<void>)[], concurrency = 8): Promise<void> {
  const queue = [...uploads]
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (true) {
      const next = queue.shift()
      if (!next) return
      await next()
    }
  })
  await Promise.all(workers)
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return json(405, { ok: false, error: "Method not allowed. POST a publish payload." })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json(400, { ok: false, error: "Body must be valid JSON." })
  }

  const { name, files, project, allowSourceFiles } = (body ?? {}) as Partial<PublishBody>
  const claims = (() => {
    try {
      return authorizeCloudRequest(request, typeof project === "string" ? project : undefined)
    } catch (error) {
      if (error instanceof CloudAuthorizationError) return json(error.status, { ok: false, error: error.message })
      throw error
    }
  })()
  if (claims instanceof Response) return claims
  if (typeof name !== "string" || name.trim().length === 0) {
    return json(400, { ok: false, error: "'name' must be a non-empty string." })
  }
  if (!Array.isArray(files) || files.length === 0) {
    return json(400, { ok: false, error: "'files' must be a non-empty array." })
  }
  if (files.length > MAX_FILES) {
    return json(400, { ok: false, error: `Too many files: ${files.length} (max ${MAX_FILES}).` })
  }

  const seen = new Set<string>()
  const decoded: { path: string, data: Buffer }[] = []
  let totalBytes = 0
  for (const file of files) {
    if (!isPublishFile(file)) {
      return json(400, {
        ok: false,
        error: "Each file needs { path: string, content: string, encoding?: 'utf8' | 'base64' }.",
      })
    }
    const pathError = publicationPathError(file.path, allowSourceFiles === true)
    if (pathError) {
      return json(400, {
        ok: false,
        error: `Refusing to publish '${file.path}': ${pathError}.`,
      })
    }
    if (seen.has(file.path)) {
      return json(400, { ok: false, error: `Duplicate path '${file.path}'.` })
    }
    seen.add(file.path)
    const data = file.encoding === "base64"
      ? Buffer.from(file.content, "base64")
      : Buffer.from(file.content, "utf8")
    totalBytes += data.byteLength
    if (totalBytes > MAX_TOTAL_BYTES) {
      return json(413, {
        ok: false,
        error: `Site too large: total decoded size exceeds ${MAX_TOTAL_BYTES / (1024 * 1024)} MB.`,
      })
    }
    decoded.push({ path: file.path, data })
  }

  const index = decoded.find((file) => file.path === "index.html")
  if (!index) {
    return json(400, { ok: false, error: "A root 'index.html' is required." })
  }

  // Ensure the "Deployed with Vector" badge on the entry page.
  index.data = Buffer.from(injectBadge(index.data.toString("utf8")), "utf8")

  const slug = makeSlug(name)

  try {
    await uploadAll(
      decoded.map((file) => async () => {
        await put(tenantSitePath(claims.tenant, claims.project, slug, file.path), file.data, {
          access: "public",
          contentType: mimeFor(file.path),
          addRandomSuffix: false,
        })
      }),
    )
  } catch (error) {
    return json(502, {
      ok: false,
      error: `Blob upload failed: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  const origin = new URL(request.url).origin
  return json(200, {
    ok: true,
    slug,
    tenant: claims.tenant,
    project: claims.project,
    url: `${origin}/s/${claims.tenant}/${claims.project}/${slug}/`,
  })
}
