export * as ResearchPaywall from "./paywall"

// Whether a page keeps its text for subscribers. A 401, 402 or 403, a page whose structured data says it is not free
// to read (`isAccessibleForFree: false`, the field publishers set for search engines), or the markers of a metered
// or registration wall. Vector keeps the public excerpt of such a page only and does not get around the wall; the
// user can open the page themselves with their own sign-in.

export const MESSAGE =
  "Paywalled: Vector kept the public excerpt only. Open the page yourself to read the rest with your own sign-in."

// The public excerpt kept from a paywalled page, in characters.
export const EXCERPT_CHARS = 2_000

export type Reason = "status" | "structured-data" | "meter"

export function status(code: number) {
  return code === 401 || code === 402 || code === 403
}

// Class and id names that the common paywall and metering services put on their walls.
const METER =
  /\b(?:class|id)\s*=\s*["'][^"']*\b(?:paywall|paywalled|metered-?content|meter-?wall|subscriber-only|subscribers-only|premium-content|regwall|registration-wall|piano-(?:paywall|offer)|tp-modal|tp-container-inner|article-locked|locked-content)\b/i
const TIER =
  /<meta[^>]+(?:property|name)\s*=\s*["']article:content_tier["'][^>]+content\s*=\s*["'](?:locked|metered)["']/i

/** Why a served page is paywalled, or undefined when nothing says it is. `structured` is its parsed JSON-LD. */
export function marked(input: { readonly html: string; readonly structured: readonly unknown[] }): Reason | undefined {
  if (input.structured.some(closed)) return "structured-data"
  if (METER.test(input.html) || TIER.test(input.html)) return "meter"
  return undefined
}

/** The part of a paywalled page Vector keeps. */
export function excerpt(text: string) {
  if (text.length <= EXCERPT_CHARS) return text
  const cut = text.slice(0, EXCERPT_CHARS)
  const end = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "))
  return end > EXCERPT_CHARS / 2 ? cut.slice(0, end + 1).trimEnd() : cut
}

// Whether a JSON-LD value, or anything in it, says the page is not free: `"isAccessibleForFree": false` or "False".
// The walk is bounded, since a page wrote it.
function closed(value: unknown): boolean {
  const stack: { readonly value: unknown; readonly depth: number }[] = [{ value, depth: 0 }]
  const state = { seen: 0 }
  while (stack.length > 0 && state.seen < 5_000) {
    const item = stack.pop()!
    state.seen++
    if (item.depth > 16 || item.value === null || typeof item.value !== "object") continue
    const record = item.value as Record<string, unknown>
    const free = record["isAccessibleForFree"]
    if (free === false || (typeof free === "string" && free.trim().toLowerCase() === "false")) return true
    for (const child of Object.values(record)) stack.push({ value: child, depth: item.depth + 1 })
  }
  return false
}
