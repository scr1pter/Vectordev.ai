export * as ResearchCanonical from "./canonical"

import { ResearchDomain } from "./domain"

// One spelling per page, so the same page found twice is read once and counted once. The host is lowercased (the URL
// parser does that and drops a default port), the fragment goes, tracking parameters go, and the remaining query is
// sorted. A page's own rel=canonical is followed only when it names a page on the same site, so a page cannot claim
// to be another site's.

// utm_source and the rest of Google Analytics' campaign tags, Facebook's and Google's click IDs, Mailchimp's tags
// and the referral tag.
const TRACKING = /^(?:utm_.*|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_.*|ref)$/i

/** The canonical form of an http or https address, or undefined for anything else. */
export function canonical(input: string) {
  if (!URL.canParse(input)) return undefined
  const url = new URL(input)
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  if (url.username || url.password) return undefined
  url.hash = ""
  url.hostname = url.hostname.replace(/\.$/, "")
  const kept = [...url.searchParams].filter(([key]) => !TRACKING.test(key)).toSorted(compare)
  url.search = kept.length === 0 ? "" : new URLSearchParams(kept).toString()
  return url.toString()
}

/**
 * The canonical form of a page that names `declared` as its canonical address: the declared one when it resolves
 * against the page to the same site, the page's own otherwise.
 */
export function follow(page: string, declared: string | undefined) {
  const own = canonical(page)
  if (!own || !declared || !URL.canParse(declared, own)) return own
  const target = canonical(new URL(declared, own).toString())
  if (!target || ResearchDomain.site(target) !== ResearchDomain.site(own)) return own
  return target
}

function compare(left: readonly [string, string], right: readonly [string, string]) {
  if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1
  if (left[1] === right[1]) return 0
  return left[1] < right[1] ? -1 : 1
}
