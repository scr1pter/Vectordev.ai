export * as ResearchSearch from "./search"

import { Schema } from "effect"
import { Egress } from "../local-mode/egress"
import { LocalPolicy } from "../local-mode/policy"
import { ResearchCanonical } from "./canonical"
import { WebFence } from "./fence"

// How research searches the web (section 5.7, owner decision 23 Oct 2026): with Vector's own Chromium, as the user's
// visible browser turns typed words into a Google search. The calling agent's own research browser (the lead's, or
// each researcher's) loads the results page for the query, and the desktop reads the organic results off it (title,
// address, snippet). There is no search service, no search server and no key. When Google answers with a check for
// automated traffic, a consent wall or a page Vector cannot read, the same research browser loads DuckDuckGo's HTML
// results page once instead; Vector never answers, clicks through or works around such a check. Where there is no
// research browser (the CLI, WSL, a remote server, a headless run) research searches nothing, and says so.
//
// A results page is browsing the user asked for, as the visible browser's address-bar search is, so robots.txt, which
// research's own page reads follow, does not decide it. Everything else about research browsers holds: the query
// passes the outbound check first, the page is research-browser traffic under Vector Local, the run's rate limits
// apply, and each result's address joins the run's provenance so it may be read. What the page says is the web's.

export const Recency = Schema.Literals(["day", "week", "month", "year"])
export type Recency = typeof Recency.Type

export const MAX_RESULTS = 20
export const DEFAULT_RESULTS = 8
const TITLE_CHARS = 300
const SNIPPET_CHARS = 500

/** The results pages research loads, in the order it tries them. */
export const ENGINES = ["google", "duckduckgo"] as const
export type Engine = (typeof ENGINES)[number]
export const NAMES: Readonly<Record<Engine, string>> = { google: "Google", duckduckgo: "DuckDuckGo" }

/** Where searches go, as the plan card says it. */
export const WHERE =
  "Google, in each research agent's own browser (DuckDuckGo when Google asks for a check). No search service or key."
/** The run was told to search nothing (`vector run --research --search none`). */
export const NONE =
  "This research searches nothing on the web. It uses this repository's brain, its files and the addresses in your message."
/** No research browser here, so no search. */
export const NEEDS_DESKTOP =
  "Searching the web needs Vector's browser in the desktop app, which this Vector does not have (the CLI, WSL, a remote server or a headless run). Research will use this repository's brain, its files and the addresses in your message."
/** Every results page asked for a check or could not be read. */
export const UNAVAILABLE =
  "Search is unavailable right now: Google and DuckDuckGo answered with a check for automated traffic, a consent page or a page Vector could not read, and Vector never answers or works around those. Continue with this repository's brain, its files, the addresses in the user's message and the pages already found, and say in the report that web search was unavailable."
export const SITE = "The site filter has to be a host name, such as nature.com."
/** Vector Local's Web access lets neither results page through. */
export const LOCAL = "Vector Local's Web access keeps research's searches off Google and DuckDuckGo."

// A host name: labels of letters, digits and hyphens, the last one starting with a letter.
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

export type Result = {
  readonly url: string
  readonly title: string
  readonly snippet: string
  readonly published?: string
}

export type Query = {
  readonly query: string
  readonly site?: string
  readonly recency?: Recency
  readonly limit?: number
}

/** Whether a site filter is a host name, the only kind a search takes. */
export function site(value: string) {
  return HOST.test(value)
}

/** The words a search sends: the query, with its site filter as `site:`, which both results pages read. */
export function words(query: Query) {
  return query.site ? `${query.query} site:${query.site}` : query.query
}

// Each engine's period filter: Google's tbs=qdr:<d|w|m|y>, DuckDuckGo's df=<d|w|m|y>.
const PERIOD: Readonly<Record<Recency, string>> = { day: "d", week: "w", month: "m", year: "y" }

/** The results page for a query on one engine, as research loads it. */
export function page(engine: Engine, query: Query) {
  if (engine === "duckduckgo") {
    const url = new URL("https://html.duckduckgo.com/html/")
    url.searchParams.set("q", words(query))
    if (query.recency) url.searchParams.set("df", PERIOD[query.recency])
    return url.toString()
  }
  const url = new URL("https://www.google.com/search")
  url.searchParams.set("q", words(query))
  if (query.recency) url.searchParams.set("tbs", `qdr:${PERIOD[query.recency]}`)
  return url.toString()
}

/**
 * The engines whose results page Vector Local's Web access lets this search load now, as research-browser traffic,
 * and why the first it kept back was kept back; with Vector Local off, both. Each page kept back is logged, as Vector
 * Local logs what it refuses, and the person is told. The desktop's research proxy decides every request again.
 */
export function reachable(query: Query, tool = "research_search") {
  const policy = Egress.policy()
  const decided = ENGINES.map((engine) => {
    const url = page(engine, query)
    const verdict = policy.enabled
      ? LocalPolicy.decide(policy, { purpose: "research-browser", url, source: "research-browser" })
      : undefined
    if (!verdict || verdict.decision === "allow") return { engine, refused: undefined }
    Egress.record({ source: "research-browser", url, tool, notify: true }, verdict)
    return { engine, refused: verdict.reason }
  })
  return {
    engines: decided.flatMap((item) => (item.refused === undefined ? [item.engine] : [])),
    refused: decided.find((item) => item.refused !== undefined)?.refused,
  }
}

/** The engine whose results page this address is, as `page` builds one; undefined for any other address. */
export function engineOf(url: string): Engine | undefined {
  if (!URL.canParse(url)) return undefined
  const address = new URL(url)
  if (address.protocol !== "https:" || address.port || address.username || address.password) return undefined
  if (address.hostname === "www.google.com" && address.pathname === "/search") return "google"
  if (address.hostname === "html.duckduckgo.com" && (address.pathname === "/html/" || address.pathname === "/html"))
    return "duckduckgo"
  return undefined
}

/**
 * Results as research keeps them, from whatever page or process read them: http and https addresses only, each page
 * once by its canonical form, never a search engine's own pages, the title and snippet cleaned of hidden characters
 * and cut to length, at most `limit`.
 */
export function clean(
  items: readonly {
    readonly url: string
    readonly title?: string
    readonly snippet?: string
    readonly published?: string
  }[],
  limit = DEFAULT_RESULTS,
): readonly Result[] {
  const seen = new Set<string>()
  return items
    .flatMap((item) => {
      const canonical = ResearchCanonical.canonical(item.url)
      if (!canonical || seen.has(canonical)) return []
      const address = new URL(canonical)
      if (!/^https?:$/.test(address.protocol) || own(address.hostname)) return []
      seen.add(canonical)
      const published = date(item.published)
      return [
        {
          url: item.url,
          title: text(item.title, TITLE_CHARS) || address.hostname,
          snippet: text(item.snippet, SNIPPET_CHARS),
          ...(published ? { published } : {}),
        },
      ]
    })
    .slice(0, Math.min(Math.max(1, limit), MAX_RESULTS))
}

/**
 * Whether a host is a search engine's own: Google's search pages on any of its country domains, its sign-in, consent,
 * policy and maps hosts, its cache, static and ad hosts, and DuckDuckGo's. A link there is the engine's, not a result.
 */
export function own(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  if (/^(?:(?:www|accounts|consent|policies|maps)\.)?google\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(host))
    return true
  if (/(?:^|\.)(?:googleusercontent|gstatic|googleadservices|googlesyndication|doubleclick)\.(?:com|net)$/.test(host))
    return true
  return host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")
}

/**
 * A search's results as research shows them to the agent, fenced since the sites wrote them: each title, address,
 * date and snippet, marked "already read as S#" for a page the run read (`read` maps canonical addresses to sources).
 */
export function listing(query: string, results: readonly Result[], read: ReadonlyMap<string, string>) {
  return WebFence.fenceWebPage(
    { title: `Search results: ${query}`, tool: "research_search" },
    results
      .map((item, index) => {
        const known = read.get(ResearchCanonical.canonical(item.url) ?? "")
        return [
          `${index + 1}. ${item.title}${known ? ` (already read as ${known})` : ""}`,
          `   ${item.url}`,
          ...(item.published ? [`   published ${item.published}`] : []),
          ...(item.snippet ? [`   ${item.snippet}`] : []),
        ].join("\n")
      })
      .join("\n"),
  )
}

function text(value: string | null | undefined, max: number) {
  const cleaned = WebFence.clean(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}…` : cleaned
}

function date(value: string | null | undefined) {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString().slice(0, 10)
}
