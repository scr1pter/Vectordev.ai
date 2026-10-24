import { ResearchSearch } from "@vectordevai/core/research/search"

// Reading a search engine's results page in a research browser (section 5.7, owner decision 23 Oct 2026). Two halves:
// - `readSearchPage` runs inside the page, in the research browser's isolated world, as browser-page.ts's functions
//   do: self-contained (it is serialized with toString()), reading the DOM only, through the DOM's own prototypes so a
//   page's named elements cannot stand in for a method. It gathers the organic results' links, titles and snippets,
//   leaves out ads, "People also ask" and the page's own furniture, and notes what of a check or consent wall it sees.
//   It clicks, types and submits nothing: a check is never answered.
// - `searchOutcome` runs in desktop main on what it gathered: it decides whether the page was a check, a consent wall,
//   results or a page it cannot read, unwraps the engines' redirect links, and keeps only web addresses that are not
//   the engine's own, cleaned as research keeps every result (ResearchSearch.clean).
// What a results page says is the web's: research shows it fenced, as untrusted web content.

export type SearchItem = { readonly href: string; readonly title: string; readonly snippet: string }

export type SearchPageRead = {
  readonly url: string
  readonly title: string
  readonly items: readonly SearchItem[]
  /** An element of a check for automated traffic, or of a consent wall, is on the page. */
  readonly check?: "captcha" | "consent"
  /** The page says the search found nothing. */
  readonly none: boolean
  /** The start of the page's text, for the words a check page uses. */
  readonly text: string
}

export type SearchOutcome =
  | { readonly kind: "results"; readonly results: readonly ResearchSearch.Result[] }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "unreadable"; readonly reason: string }

/** The organic results on a Google or DuckDuckGo results page, and what of a check or a consent wall it shows. */
export function readSearchPage(win: Window, engine: "google" | "duckduckgo"): SearchPageRead {
  const doc = win.document
  // What the node's prototypes define under `key`, never a property of its own: an accessor read, or a method called.
  const inherited = (owner: object, key: string): PropertyDescriptor =>
    Object.getOwnPropertyDescriptor(owner, key) ?? inherited(Object.getPrototypeOf(owner), key)
  const property = (target: object, key: string) => inherited(Object.getPrototypeOf(target), key).get!.call(target)
  const invoke = (target: object, key: string, ...input: unknown[]) =>
    (inherited(Object.getPrototypeOf(target), key).value as (...input: unknown[]) => unknown).apply(target, input)
  const line = (node: Node | null | undefined) =>
    node ? ((property(node, "textContent") as string | null) ?? "").replace(/\s+/g, " ").trim() : ""
  const all = (root: Element | Document, selector: string) =>
    Array.from(invoke(root, "querySelectorAll", selector) as ArrayLike<Element>)
  const first = (root: Element | Document, selector: string) => all(root, selector)[0]
  const attribute = (element: Element, name: string) => (invoke(element, "getAttribute", name) as string | null) ?? ""
  const closest = (element: Element, selector: string) => invoke(element, "closest", selector) as Element | null
  const matches = (element: Element, selector: string) => invoke(element, "matches", selector) as boolean
  const parent = (element: Element) => property(element, "parentElement") as Element | null
  const body = (first(doc, "body") ?? property(doc, "documentElement")) as Element
  const text = line(body).slice(0, 3_000)
  const CAPTCHA = [
    "#captcha-form",
    "#recaptcha",
    ".g-recaptcha",
    "iframe[src*='recaptcha']",
    "iframe[src*='hcaptcha']",
    ".h-captcha",
    "[data-sitekey]",
    "#challenge-form",
    "#cf-challenge-running",
    ".anomaly-modal",
    "form[action*='anomaly']",
    "form[action*='/sorry/']",
  ].join(", ")
  const CONSENT = [
    "form[action*='consent.google']",
    "form[action*='consent.youtube']",
    "#L2AGLb",
    "#W0wltc",
    "[aria-label='Before you continue to Google Search']",
  ].join(", ")
  const check = first(doc, CAPTCHA) ? "captcha" : first(doc, CONSENT) ? "consent" : undefined
  const title = line(first(doc, "title"))
  const url = win.location.href

  if (engine === "duckduckgo") {
    const items = all(doc, ".result, .web-result")
      .filter((block) => !matches(block, ".result--ad, .result--ads, .result-ad") && !first(block, ".badge--ad"))
      .flatMap((block) => {
        const anchor = first(block, "a.result__a") ?? first(block, "h2 a[href]")
        if (!anchor) return []
        return [
          { href: attribute(anchor, "href"), title: line(anchor), snippet: line(first(block, ".result__snippet")) },
        ]
      })
    return { url, title, items, ...(check ? { check } : {}), none: !!first(doc, ".no-results"), text }
  }

  // Google: each organic result is a link holding its title in an h3, inside the results column. Ads, "People also
  // ask", the side panel and the page's navigation are left out by their containers, and so is any block of the
  // column whose own heading says it is sponsored or a set of questions.
  const column = first(doc, "#rso") ?? first(doc, "#search") ?? first(doc, "#main") ?? body
  const SKIP = [
    "#tads",
    "#tadsb",
    "#bottomads",
    "#taw",
    "[data-text-ad]",
    ".commercial-unit-desktop-top",
    ".commercial-unit-desktop-rhs",
    ".related-question-pair",
    "[data-initq]",
    "[jsname='yEVEwb']",
    "[jsname='N760b']",
    "g-accordion-expander",
    "[aria-label='Ads']",
    "[aria-label='Sponsored']",
    "[aria-label='People also ask']",
    "#rhs",
    "#botstuff",
    "#searchform",
    "[role='navigation']",
    "header",
    "footer",
    "nav",
  ].join(", ")
  const LABELLED = /^(?:people also ask|people also search for|related searches|sponsored|ads?)\b/i
  // The block of the column a result is in: the column's child that holds it.
  const block = (element: Element): Element => {
    const above = parent(element)
    return !above || above === column ? element : block(above)
  }
  const labelled = (element: Element) =>
    all(element, "h2, [role='heading']").some((heading) => LABELLED.test(line(heading)))
  const SNIPPET = ".VwiC3b, [data-sncf], .IsZvec, .lEBKkf, [style*='-webkit-line-clamp']"
  const items = all(column, "a[href] h3, h3 a[href]").flatMap((found) => {
    const heading = matches(found, "h3") ? found : closest(found, "h3")!
    const anchor = matches(found, "a") ? found : closest(found, "a[href]")!
    if (closest(anchor, SKIP) || labelled(block(anchor))) return []
    const container =
      closest(anchor, ".g") ??
      closest(anchor, ".MjjYud") ??
      closest(anchor, "[data-sokoban-container]") ??
      block(anchor)
    const name = line(heading)
    const cited = all(container, "cite").map((cite) => line(cite))
    const marked = first(container, SNIPPET)
    const rest = cited.reduce((value, cite) => value.replace(cite, " "), line(container).replace(name, " "))
    return [{ href: attribute(anchor, "href"), title: name, snippet: (marked ? line(marked) : rest).slice(0, 600) }]
  })
  const none = /did not match any documents|no results found for|no results for/i.test(line(first(doc, "#topstuff")))
  return {
    url,
    title,
    items,
    ...(check ? { check } : {}),
    none: none || /did not match any documents/i.test(text),
    text,
  }
}

// The words of a check page, read only when the page gave no results: a result's snippet may use them too.
const CHECK_WORDS =
  /unusual traffic|automated queries|not a robot|verify you are (?:a )?human|bots use duckduckgo too|complete the following challenge|captcha/i
const CONSENT_WORDS = /before you continue to google/i

/** What a results page was, from what readSearchPage gathered on it, with the results research keeps. */
export function searchOutcome(
  engine: ResearchSearch.Engine,
  read: SearchPageRead,
  limit = ResearchSearch.DEFAULT_RESULTS,
): SearchOutcome {
  const name = ResearchSearch.NAMES[engine]
  const address = URL.canParse(read.url) ? new URL(read.url) : undefined
  const sorry = !!address && /(?:^|\.)google\.[a-z.]+$/.test(address.hostname) && address.pathname.startsWith("/sorry")
  const consent = !!address && /^consent\.(?:google|youtube)\.[a-z.]+$/.test(address.hostname)
  const anomaly = !!address && address.hostname.endsWith("duckduckgo.com") && /anomaly/i.test(address.pathname)
  if (sorry || anomaly || read.check === "captcha")
    return { kind: "blocked", reason: `${name} asked for a check that it is not automated traffic.` }
  if (consent || read.check === "consent") return { kind: "blocked", reason: `${name} showed a consent page.` }
  const results = ResearchSearch.clean(
    read.items.flatMap((item) => {
      const url = target(item.href, read.url)
      return url ? [{ url, title: item.title, snippet: item.snippet }] : []
    }),
    limit,
  )
  if (results.length) return { kind: "results", results }
  if (CHECK_WORDS.test(read.text))
    return { kind: "blocked", reason: `${name} asked for a check that it is not automated traffic.` }
  if (CONSENT_WORDS.test(read.text)) return { kind: "blocked", reason: `${name} showed a consent page.` }
  if (read.none) return { kind: "results", results: [] }
  return { kind: "unreadable", reason: `Vector could not read ${name}'s results page.` }
}

// Where a result's link leads: Google's /url?q= and DuckDuckGo's /l/?uddg= hops unwrapped, and only a web address.
function target(href: string, base: string) {
  if (!href || !URL.canParse(href, URL.canParse(base) ? base : undefined)) return undefined
  const address = new URL(href, URL.canParse(base) ? base : undefined)
  const hop = ResearchSearch.own(address.hostname)
    ? address.pathname === "/url"
      ? (address.searchParams.get("q") ?? address.searchParams.get("url"))
      : address.pathname === "/l/" || address.pathname === "/l"
        ? address.searchParams.get("uddg")
        : undefined
    : undefined
  const url = hop && URL.canParse(hop) ? new URL(hop) : address
  return /^https?:$/.test(url.protocol) ? url.toString() : undefined
}
