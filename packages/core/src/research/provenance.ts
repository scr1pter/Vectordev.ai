export * as ResearchProvenance from "./provenance"

import { ResearchCanonical } from "./canonical"

// Where research may read: only addresses that came from a search result, a link on a page it read, or the user's own
// typed message. The research agent chooses among these but cannot write an address of its own, so a hostile page
// cannot steer it into putting private text in a URL. Links that look built to carry data (a long query string, or a
// path or query value that reads as encoded data) are not offered at all.
//
// An address is accepted only as it was recorded (host case and the order of the query aside) or in its canonical
// form, which only takes parts away. The canonical form alone is not enough to compare: it drops the fragment and
// tracking parameters such as utm_source and ref, so an agent could add those with private text in them and still
// match. `check` gives the address to read, and the caller reads that one, never the agent's own spelling.

export const REFUSAL = "That address did not come from a search result, a page link or your message."

export type From = "search" | "link" | "typed"

// The longest query string a link may have and still be offered, in characters after the "?".
export const MAX_QUERY = 64
// The shortest path segment or query value that can read as encoded data.
const ENCODED_CHARS = 16
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ADDRESS = /\bhttps?:\/\/[^\s<>"'`]+|\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s<>"'`]*)?/gi

/** One page in a run's set: where it first came from, and each spelling it was recorded with. */
export type Entry = { readonly from: From; readonly urls: ReadonlySet<string> }

/** A run's addresses by canonical form. */
export type Addresses = ReadonlyMap<string, Entry>

export function empty(): Addresses {
  return new Map()
}

/** The set with these addresses added. An address the user typed counts as typed, whichever came first. */
export function add(set: Addresses, urls: readonly string[], from: From): Addresses {
  const next = new Map(set)
  for (const url of urls) {
    const canonical = ResearchCanonical.canonical(url)
    const exact = ResearchCanonical.exact(url)
    if (!canonical || !exact) continue
    const entry = next.get(canonical)
    next.set(canonical, {
      from: entry?.from === "typed" || from === "typed" ? "typed" : (entry?.from ?? from),
      urls: new Set([...(entry?.urls ?? []), exact]),
    })
  }
  return next
}

/**
 * Whether research may read the address: as one of its recorded spellings or as its canonical form. When it may,
 * `url` is the address to read.
 */
export function check(set: Addresses, url: string) {
  const canonical = ResearchCanonical.canonical(url)
  const exact = ResearchCanonical.exact(url)
  const entry = canonical ? set.get(canonical) : undefined
  if (!canonical || !exact || !entry || (exact !== canonical && !entry.urls.has(exact)))
    return { ok: false, message: REFUSAL } as const
  return { ok: true, canonical, from: entry.from, url: exact } as const
}

/** The http and https addresses in the user's own text; "www." names are read as https. */
export function typed(text: string) {
  return [
    ...new Set(
      [...text.matchAll(ADDRESS)]
        .map((match) => match[0].replace(/[.,;:!?)\]}>]+$/, ""))
        .map((address) => (/^https?:\/\//i.test(address) ? address : `https://${address}`))
        .filter((address) => ResearchCanonical.canonical(address) !== undefined),
    ),
  ]
}

/** The links of a page that research offers to read next: http and https only, none that look built to carry data. */
export function offered<Link extends { readonly url: string }>(links: readonly Link[]) {
  return links.filter((link) => !dataLike(link.url))
}

/** Whether an address looks built to carry data: credentials, a long query string, or an encoded path or value. */
export function dataLike(url: string) {
  if (!URL.canParse(url)) return true
  const address = new URL(url)
  if (address.protocol !== "http:" && address.protocol !== "https:") return true
  if (address.username || address.password) return true
  if (address.search.length - 1 > MAX_QUERY) return true
  const tokens = [
    ...address.pathname.split("/").map(ResearchCanonical.decoded),
    ...[...address.searchParams].flatMap(([key, value]) => [key, value]),
  ].flatMap((token) => token.split("."))
  return tokens.some(encoded)
}

// A token that reads as base64 or similar: long, in its alphabet, with both cases and a digit or its padding, no
// words in it, and a spread of characters. Hex IDs, commit hashes and UUIDs are left alone: pages link to them all
// the time, and they carry no text.
function encoded(token: string) {
  if (token.length < ENCODED_CHARS || !/^[A-Za-z0-9+/_=-]+$/.test(token)) return false
  if (UUID.test(token) || /^[0-9a-f]+$/i.test(token)) return false
  if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/[\d+/=]/.test(token)) return false
  if (token.split(/[_\-+/]+/).filter((segment) => /^[a-z]{4,}$/i.test(segment)).length >= 2) return false
  return entropy(token) >= 3.5
}

function entropy(value: string) {
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  return [...counts.values()].reduce((sum, count) => {
    const share = count / value.length
    return sum - share * Math.log2(share)
  }, 0)
}
