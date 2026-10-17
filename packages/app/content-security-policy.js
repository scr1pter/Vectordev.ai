import { createHash } from "node:crypto"

/** @param {string} html */
export function withInlineScriptHashes(html) {
  const hashes = [
    ...new Set(
      [...html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
        // HTML normalizes CRLF and lone CR before the browser checks inline-script hashes.
        (match) => `'sha256-${createHash("sha256").update(match[1].replace(/\r\n?/g, "\n")).digest("base64")}'`,
      ),
    ),
  ]
  if (!hashes.length) return html
  return html.replace("script-src 'self'", `script-src 'self' ${hashes.join(" ")}`)
}
