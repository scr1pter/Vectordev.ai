export * as ResearchProvenance from "./provenance"

import { ResearchCanonical } from "./canonical"

// Where research may read: only addresses that came from a search result, a link on a page it read, or the user's own
// typed message. The research agent chooses among these but cannot write an address of its own, so a hostile page
// cannot steer it into putting private text in a URL. Links that look built to carry data (a long query string, or a
// path or query value that reads as encoded data) are not offered at all.

export const REFUSAL = "That address did not come from a search result, a page link or your message."

export type From = "search" | "link" | "typed"

// The longest query string a link may have and still be offered, in characters after the "?".
export const MAX_QUERY = 64
// The shortest path segment or query value that can read as encoded data.
const ENCODED_CHARS = 16
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ADDRESS = /\bhttps?:\/\/[^\s<>"'`]+|\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s<>"'`]*)?/gi

/** A run's addresses by canonical form, with where each came from. */
export type Addresses = ReadonlyMap<string, From>

export function empty(): Addresses {
  return new Map()
}

/** The set with these addresses added. An address the user typed keeps that origin when a search finds it too. */
export function add(set: Addresses, urls: readonly string[], from: From): Addresses {
  const next = new Map(set)
  for (const url of urls) {
    const canonical = ResearchCanonical.canonical(url)
    if (!canonical || next.get(canonical) === "typed") continue
    next.set(canonical, from)
  }
  return next
}

/** Whether research may read the address, and its canonical form when it may. */
export function check(set: Addresses, url: string) {
  const canonical = ResearchCanonical.canonical(url)
  const from = canonical ? set.get(canonical) : undefined
  if (!canonical || !from) return { ok: false, message: REFUSAL } as const
  return { ok: true, canonical, from } as const
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
    ...address.pathname.split("/").map(decode),
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

// Percent escapes read as the characters they stand for, byte by byte, so "%2B" is "+" and nothing can throw.
function decode(segment: string) {
  return segment.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
}
