import { readFile } from "node:fs/promises"
import path from "node:path"
import { verifiedDesignLabCookie } from "../_lib/design-lab.js"
import { queryValue, redirect, type ApiRequest, type ApiResponse } from "../_lib/http.js"

// Serves design-lab/ (bundled into this function by vercel.json) to the owner only.
// vercel.json rewrites /design-lab/<path> here as ?path=<path>.
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (request.method !== "GET" && request.method !== "HEAD") return notFound(response)
  const file = designLabFile(queryValue(request, "path"))
  if (!file) return notFound(response)
  // Without a valid cookie the lab does not exist; a page request is sent to sign in.
  if (!verifiedDesignLabCookie(request)) {
    return file.extension === ".html" ? redirect(response, 302, "/design") : notFound(response)
  }
  const body = await readFile(path.join(designLabRoot(), file.relative)).catch(() => undefined)
  if (!body) return notFound(response)
  response.statusCode = 200
  response.setHeader("content-type", file.type)
  response.setHeader("cache-control", "private, no-store")
  response.setHeader("x-robots-tag", "noindex, nofollow")
  response.setHeader("x-content-type-options", "nosniff")
  response.setHeader("x-frame-options", "DENY")
  response.setHeader("referrer-policy", "same-origin")
  response.end(request.method === "HEAD" ? undefined : body)
}

/** A safe path inside design-lab/ with a servable extension, or undefined. */
export function designLabFile(requested: string | undefined) {
  const raw = (requested ?? "").replace(/^\/+/, "")
  if (raw.includes("\0") || raw.includes("\\")) return undefined
  const relative = path.posix.normalize(raw === "" || raw.endsWith("/") ? `${raw}index.html` : raw)
  if (relative.startsWith("..") || path.posix.isAbsolute(relative) || relative.split("/").some((part) => part.startsWith(".")))
    return undefined
  const extension = path.posix.extname(relative).toLowerCase()
  const type = TYPES[extension]
  if (!type) return undefined
  return { relative, extension, type }
}

function designLabRoot() {
  return path.join(process.cwd(), "design-lab")
}

function notFound(response: ApiResponse) {
  response.statusCode = 404
  response.setHeader("content-type", "text/plain; charset=utf-8")
  response.setHeader("cache-control", "no-store")
  response.end("Not found")
}
