export * as ResearchSignals from "./signals"

import type { Research } from "@vectordevai/schema/research"
import { ResearchDomain } from "./domain"
import type { ResearchExtract } from "./extract"

// What Vector noticed about a source, for the chips beside it and the confidence rules. Each signal is something the
// page says or that Vector counted; none of them says a source is right, so there is no "verified" signal.
//
// A source is primary when it is the record itself rather than a report of it: a paper with a DOI, arXiv or PubMed
// identifier, a page on an academic, government or standards site, or a page that publishes its own data.

export type Input = {
  readonly url: string
  readonly meta: Pick<ResearchExtract.Page, "author" | "published" | "updated" | "ids" | "data" | "references">
  /** Lines of its text that read as instructions to an AI assistant. */
  readonly flagged: number
  readonly duplicateOf?: string
  readonly paywalled: boolean
  /** How many other independent sites in the run say the same. */
  readonly corroborated: number
  readonly prefer?: readonly string[]
  readonly avoid?: readonly string[]
  readonly now: number
}

const DAY = 24 * 60 * 60 * 1000

export function signals(input: Input): Research.Signal {
  const kind = ResearchDomain.kind(input.url)
  const host = new URL(input.url).hostname
  const preference = input.avoid?.some((domain) => ResearchDomain.under(host, domain))
    ? "avoided"
    : input.prefer?.some((domain) => ResearchDomain.under(host, domain))
      ? "trusted"
      : undefined
  const ids = input.meta.ids
  const published = input.meta.published
  return {
    kind,
    primary:
      !!(ids.doi || ids.arxiv || ids.pmid) ||
      kind === "academic" ||
      kind === "government" ||
      kind === "standards" ||
      input.meta.data,
    ...(ids.doi ? { doi: ids.doi } : {}),
    ...(ids.arxiv ? { arxiv: ids.arxiv } : {}),
    ...(ids.pmid ? { pmid: ids.pmid } : {}),
    ...(published ? { published } : {}),
    ...(input.meta.updated ? { updated: input.meta.updated } : {}),
    ...(published ? { age_days: Math.max(0, Math.floor((input.now - Date.parse(published)) / DAY)) } : {}),
    ...(input.meta.author ? { author: input.meta.author } : {}),
    data: input.meta.data,
    references: input.meta.references,
    ...(input.duplicateOf ? { duplicate_of: input.duplicateOf } : {}),
    paywalled: input.paywalled,
    addressed_to_ai: input.flagged > 0,
    corroborated: input.corroborated,
    ...(preference ? { preference } : {}),
  }
}

/** The chips a source shows, in Vector's words. */
export function labels(signal: Research.Signal) {
  return [
    signal.primary ? "Primary source" : undefined,
    signal.doi
      ? `DOI ${signal.doi}`
      : signal.arxiv
        ? `arXiv ${signal.arxiv}`
        : signal.pmid
          ? `PMID ${signal.pmid}`
          : undefined,
    signal.published ? `Published ${signal.published}` : undefined,
    signal.author ? `By ${signal.author}` : undefined,
    signal.data ? "Publishes data" : undefined,
    signal.references ? "Lists references" : undefined,
    signal.duplicate_of ? `Copy of ${signal.duplicate_of}` : undefined,
    signal.paywalled ? "Paywalled (excerpt only)" : undefined,
    signal.signed_in ? "Read signed in, in your browser" : undefined,
    signal.addressed_to_ai ? "Contains text addressed to AI assistants" : undefined,
    signal.corroborated > 0
      ? `Also said by ${signal.corroborated} other site${signal.corroborated === 1 ? "" : "s"}`
      : undefined,
    signal.preference === "trusted"
      ? "You trust this site"
      : signal.preference === "avoided"
        ? "You avoid this site"
        : undefined,
  ].filter((label): label is string => label !== undefined)
}
