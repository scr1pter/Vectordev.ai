export * as ResearchDomain from "./domain"

import type { Research } from "@vectordevai/schema/research"
import { getDomain } from "tldts"

// Which site a source is on, for counting independent sites and for the source's kind. A site is the registrable
// domain (eTLD+1) from the public suffix list, private suffixes included, so two blogs on github.io or blogspot.com
// count as two sites and two pages on bbc.co.uk count as one. An address, or a name the list does not know, is its
// own site.

/** The registrable domain of a host or URL, lowercased, or the host itself when there is none. */
export function site(input: string) {
  const host = hostOf(input)
  return getDomain(host, { allowPrivateDomains: true }) ?? host
}

/** How many different sites the addresses are on. */
export function independent(urls: readonly string[]) {
  return new Set(urls.map(site).filter(Boolean)).size
}

/** Whether a host is the domain or under it ("docs.example.com" is under "example.com"). */
export function under(host: string, domain: string) {
  const name = hostOf(host)
  const parent = hostOf(domain).replace(/^\*\./, "")
  return parent !== "" && (name === parent || name.endsWith(`.${parent}`))
}

// Sites whose kind is known by name. Suffix rules below cover the rest of the academic and government web.
const NAMED: Readonly<Record<string, Research.SiteKind>> = {
  "arxiv.org": "academic",
  "biorxiv.org": "academic",
  "medrxiv.org": "academic",
  "doi.org": "academic",
  "nih.gov": "government",
  "europa.eu": "government",
  "who.int": "government",
  "oecd.org": "government",
  "worldbank.org": "government",
  "un.org": "government",
  "semanticscholar.org": "academic",
  "ssrn.com": "academic",
  "jstor.org": "academic",
  "springer.com": "academic",
  "nature.com": "academic",
  "sciencedirect.com": "academic",
  "wiley.com": "academic",
  "plos.org": "academic",
  "acm.org": "academic",
  "ieee.org": "academic",
  "ietf.org": "standards",
  "rfc-editor.org": "standards",
  "w3.org": "standards",
  "whatwg.org": "standards",
  "iso.org": "standards",
  "unicode.org": "standards",
  "ecma-international.org": "standards",
  "wikipedia.org": "reference",
  "wikidata.org": "reference",
  "britannica.com": "reference",
  "reddit.com": "forum",
  "stackoverflow.com": "forum",
  "stackexchange.com": "forum",
  "quora.com": "forum",
  "ycombinator.com": "forum",
  "discourse.org": "forum",
}

/** What kind of site a host is, from its name alone. */
export function kind(input: string): Research.SiteKind {
  const host = hostOf(input)
  const named = NAMED[site(host)]
  if (named) return named
  if (/\.(?:gov|mil)$/.test(host) || /\.gov\.[a-z]{2}$/.test(host) || /\.gouv\.[a-z]{2}$/.test(host)) return "government"
  if (/\.edu$/.test(host) || /\.(?:edu|ac)\.[a-z]{2}$/.test(host)) return "academic"
  return "other"
}

function hostOf(input: string) {
  const value = input.trim().toLowerCase()
  const host =
    /^[a-z][a-z0-9+.-]*:\/\//.test(value) && URL.canParse(value)
      ? new URL(value).hostname
      : value.replace(/\/.*$/, "").replace(/:\d+$/, "")
  return host.replace(/^\[|\]$/g, "").replace(/\.$/, "")
}
