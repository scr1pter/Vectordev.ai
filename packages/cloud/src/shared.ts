/**
 * Pure helpers shared by the Vector Cloud publish + serve functions.
 *
 * Everything here is side-effect free so it can be unit-tested with bun:test.
 */

/** Maximum number of files accepted in a single publish request. */
export const MAX_FILES = 200

/** Maximum total decoded payload size in bytes (10 MB). */
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024

/** Marker string used to detect an already-injected badge. */
export const BADGE_MARKER = "vector-badge"

/**
 * The "Deployed with Vector" badge, injected before </body> of the root
 * index.html when the marker string is absent.
 */
export const BADGE_HTML = `    <!-- vector-badge -->
    <a href="https://vectordev.ai" target="_blank" rel="noopener" style="position:fixed;right:14px;bottom:14px;z-index:2147483647;display:flex;align-items:center;gap:6px;padding:7px 12px;border-radius:999px;background:rgba(16,15,19,0.92);color:#f5f3ff;font:600 12px/1 Inter,system-ui,sans-serif;text-decoration:none;box-shadow:0 4px 24px rgba(0,0,0,0.35);border:1px solid rgba(147,116,236,0.4)">
      <span style="display:inline-block;width:8px;height:8px;border-radius:999px;background:linear-gradient(135deg,#f0a36e,#ec7fae,#9374ec,#6ba6dd)"></span>
      Deployed with Vector
    </a>
`

/**
 * Slugify a site name into a DNS-label-safe string.
 *
 * The output is intentionally a valid DNS label fragment (lowercase a-z, 0-9,
 * hyphens; no leading/trailing hyphen; capped length) so that when Vector
 * Cloud moves from path-based URLs (/s/<slug>/) to wildcard subdomains
 * (<slug>.vectordev.app), slugs work as-is with zero migration.
 *
 * Returns "site" when nothing usable survives (empty input, all-symbol names).
 */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    // strip combining diacritics left over from NFKD (é -> e)
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    // any run of non-alphanumerics becomes a single hyphen
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    // keep slug + "-xxxxxx" suffix comfortably inside the 63-char DNS label limit
    .slice(0, 40)
    .replace(/-+$/g, "")
  return slug.length > 0 ? slug : "site"
}

/** Alphabet for slug suffixes: lowercase alphanumerics, ambiguous chars removed. */
const SUFFIX_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"

/**
 * Build the final published slug: slugified name + "-" + 6 random chars,
 * e.g. "my-app-x7k2qd". Collision-safe enough for a token-gated alpha
 * (~31^6 = 887 million combinations per name).
 */
export function makeSlug(name: string, random: () => number = Math.random): string {
  let suffix = ""
  for (let i = 0; i < 6; i++) {
    suffix += SUFFIX_ALPHABET[Math.floor(random() * SUFFIX_ALPHABET.length)]
  }
  return `${slugify(name)}-${suffix}`
}

/** True when `slug` looks like a slug this service could have issued. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)
}

/** The blob-storage prefix under which every published site lives. */
export const SITES_PREFIX = "sites/"
export const PROMOTIONS_PREFIX = "promotions/"

export function promotionPrefix(project: string): string {
  return `${PROMOTIONS_PREFIX}${slugify(project)}/`
}

export function promotionPath(project: string, slug: string, timestamp = Date.now()): string {
  if (!isValidSlug(slug)) throw new Error("A valid deployment slug is required.")
  return `${promotionPrefix(project)}${timestamp}-${slug}.json`
}

/**
 * Extract a site slug from a blob key under the `sites/` prefix.
 *
 * Accepts either a folded folder ("sites/my-app-x7k2qd/") or a full blob
 * pathname ("sites/my-app-x7k2qd/assets/app.js") and returns the slug when it
 * is one this service could have issued (see {@link isValidSlug}). Returns
 * undefined for keys outside `sites/` or with an unexpected/invalid slug.
 */
export function slugFromSitesKey(key: string): string | undefined {
  if (!key.startsWith(SITES_PREFIX)) return undefined
  const slug = key.slice(SITES_PREFIX.length).split("/")[0] ?? ""
  return isValidSlug(slug) ? slug : undefined
}

/**
 * Derive the sorted, de-duplicated set of site slugs from a list of blob keys
 * (folded folders or full pathnames). Keys that don't resolve to a valid slug
 * are skipped, so partial/garbage entries can't produce phantom deployments.
 */
export function uniqueSlugsFromKeys(keys: readonly string[]): string[] {
  const slugs = new Set<string>()
  for (const key of keys) {
    const slug = slugFromSitesKey(key)
    if (slug) slugs.add(slug)
  }
  return [...slugs].sort()
}

/**
 * Validate a file path from a publish request.
 *
 * Accepts relative, forward-slash paths ("index.html", "assets/js/app.js").
 * Rejects: empty paths, backslashes, leading "/", any "." or ".." segment,
 * empty segments ("a//b"), and control characters.
 */
export function isValidFilePath(path: string): boolean {
  if (path.length === 0 || path.length > 1024) return false
  if (path.includes("\\")) return false
  if (path.startsWith("/")) return false
  // reject control characters
  if (/[\u0000-\u001f\u007f]/.test(path)) return false
  const segments = path.split("/")
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return false
  }
  return true
}

const MIME_MAP: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  woff: "font/woff",
  woff2: "font/woff2",
  map: "application/json; charset=utf-8",
}

/** Content type for a file path based on its extension (case-insensitive). */
export function mimeFor(path: string): string {
  const dot = path.lastIndexOf(".")
  if (dot === -1 || dot === path.length - 1) return "application/octet-stream"
  const ext = path.slice(dot + 1).toLowerCase()
  return MIME_MAP[ext] ?? "application/octet-stream"
}

/** True when the final path segment has a file extension ("app.js" yes, "about" no). */
export function hasFileExtension(path: string): boolean {
  const lastSegment = path.split("/").pop() ?? ""
  const dot = lastSegment.lastIndexOf(".")
  return dot > 0 && dot < lastSegment.length - 1
}

/**
 * Ensure the "Deployed with Vector" badge is present in an HTML document.
 *
 * - If the document already contains the marker string, it is returned unchanged.
 * - If the document has no </body> tag, it is returned unchanged.
 * - Otherwise the badge is injected immediately before the last </body>.
 */
export function injectBadge(html: string): string {
  if (html.includes(BADGE_MARKER)) return html
  const match = /<\/body\s*>/i.exec(html)
  if (!match) return html
  const index = html.toLowerCase().lastIndexOf("</body")
  if (index === -1) return html
  return `${html.slice(0, index)}${BADGE_HTML}${html.slice(index)}`
}
