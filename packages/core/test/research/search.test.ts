import { describe, expect, test } from "bun:test"
import { ResearchSearch } from "../../src/research/search"

// Research searches in each research agent's own browser (section 5.7, owner decision 23 Oct 2026): these are the
// pieces both sides share, the results page Vector builds for a query (the desktop's navigation rule allows exactly
// these) and how results are kept, whichever process read them off the page.

describe("ResearchSearch.page", () => {
  test("Google's results page first, as the visible browser's address bar searches, with the period as tbs", () => {
    expect(ResearchSearch.page("google", { query: "heat pump savings" })).toBe(
      "https://www.google.com/search?q=heat+pump+savings",
    )
    expect(ResearchSearch.page("google", { query: "heat pumps", site: "nature.com", recency: "month" })).toBe(
      "https://www.google.com/search?q=heat+pumps+site%3Anature.com&tbs=qdr%3Am",
    )
    expect(ResearchSearch.ENGINES).toEqual(["google", "duckduckgo"])
  })

  test("DuckDuckGo's HTML results page, with the period as df", () => {
    expect(ResearchSearch.page("duckduckgo", { query: "heat pumps & cold", recency: "week" })).toBe(
      "https://html.duckduckgo.com/html/?q=heat+pumps+%26+cold&df=w",
    )
  })

  test("only those pages count as results pages", () => {
    expect(ResearchSearch.engineOf(ResearchSearch.page("google", { query: "x" }))).toBe("google")
    expect(ResearchSearch.engineOf(ResearchSearch.page("duckduckgo", { query: "x" }))).toBe("duckduckgo")
    for (const url of [
      "http://www.google.com/search?q=x",
      "https://www.google.com/url?q=https://evil.example.com",
      "https://www.google.com:8443/search?q=x",
      "https://user:pass@www.google.com/search?q=x",
      "https://google.com/search?q=x",
      "https://duckduckgo.com/html/?q=x",
      "https://html.duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com",
      "https://www.google.com.evil.example/search?q=x",
      "not an address",
    ])
      expect(ResearchSearch.engineOf(url)).toBeUndefined()
  })

  test("the engines' own pages a search may lead to: results pages, Google's check and consent wall, DuckDuckGo's check", () => {
    for (const url of [
      ResearchSearch.page("google", { query: "x" }),
      ResearchSearch.page("duckduckgo", { query: "x" }),
      "https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Dx",
      "https://ipv6.google.com/sorry/index",
      "https://consent.google.com/ml?continue=https://www.google.com/search",
      "https://consent.google.co.uk/",
      "https://duckduckgo.com/anomaly.js",
    ])
      expect(ResearchSearch.enginePage(url)).toBe(true)
    for (const url of [
      "https://www.google.com/preferences",
      "https://www.google.com/sorryish",
      "https://policies.google.com/privacy",
      "http://www.google.com/sorry/index",
      "https://www.google.com:8443/sorry/index",
      "https://sorry.example.com/sorry/index",
      "https://duckduckgo.com/about",
      "not an address",
    ])
      expect(ResearchSearch.enginePage(url)).toBe(false)
  })

  test("search unavailable names only the engines tried", () => {
    expect(ResearchSearch.unavailable([{ engine: "google" }, { engine: "duckduckgo" }])).toStartWith(
      "Search is unavailable right now: Google and DuckDuckGo answered with a check",
    )
    // Vector Local let only DuckDuckGo's page through.
    const one = ResearchSearch.unavailable([{ engine: "duckduckgo" }])
    expect(one).toStartWith("Search is unavailable right now: DuckDuckGo answered with a check")
    expect(one).not.toContain("Google")
    expect(ResearchSearch.unavailable([])).toStartWith(
      "Search is unavailable right now: no results page could be loaded.",
    )
    expect(one).toContain("say in the report that web search was unavailable")
  })

  test("a site filter is a host name, sent as site:", () => {
    expect(ResearchSearch.site("nature.com")).toBe(true)
    expect(ResearchSearch.site("www.nature.com")).toBe(true)
    expect(ResearchSearch.site("nature.com/articles")).toBe(false)
    expect(ResearchSearch.site("heat pumps")).toBe(false)
    expect(ResearchSearch.words({ query: "heat pumps", site: "nature.com" })).toBe("heat pumps site:nature.com")
  })
})

describe("ResearchSearch.clean", () => {
  test("keeps web addresses only, each page once by its canonical form, never the engines' own", () => {
    const results = ResearchSearch.clean([
      { url: "https://nature.com/a?utm_source=x", title: "A study", snippet: "Homes saved energy." },
      { url: "https://nature.com/a", title: "The same study" },
      { url: "ftp://files.example.com/b", title: "Not the web" },
      { url: "javascript:alert(1)", title: "Not a page" },
      { url: "https://www.google.com/search?q=heat+pumps+cost", title: "Searches related to heat pumps" },
      { url: "https://maps.google.com/?q=heat", title: "Maps" },
      { url: "https://webcache.googleusercontent.com/search?q=cache:x", title: "Cached" },
      { url: "https://www.googleadservices.com/pagead/aclk?sa=L", title: "An ad" },
      { url: "https://duckduckgo.com/y.js?ad_domain=example.com", title: "An ad" },
      { url: "https://developers.google.com/maps/heat", title: "Developers" },
      { url: "https://example.org/c", title: "", snippet: "  Spaced\n\nout  " },
    ])
    expect(results).toEqual([
      { url: "https://nature.com/a?utm_source=x", title: "A study", snippet: "Homes saved energy." },
      { url: "https://developers.google.com/maps/heat", title: "Developers", snippet: "" },
      { url: "https://example.org/c", title: "example.org", snippet: "Spaced out" },
    ])
  })

  test("cleans hidden characters, cuts long text and keeps to the limit", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ url: `https://example.org/${index}`, title: `R${index}` }))
    expect(ResearchSearch.clean(many)).toHaveLength(ResearchSearch.DEFAULT_RESULTS)
    expect(ResearchSearch.clean(many, 3)).toHaveLength(3)
    expect(ResearchSearch.clean(many, 0)).toHaveLength(1)
    expect(ResearchSearch.clean(many, 100)).toHaveLength(ResearchSearch.MAX_RESULTS)
    const [hidden] = ResearchSearch.clean([
      { url: "https://example.org/x", title: "Heat​ pumps‮", snippet: "x".repeat(900) },
    ])
    expect(hidden?.title).toBe("Heat pumps")
    expect(hidden?.snippet.length).toBe(500)
    expect(hidden?.snippet.endsWith("…")).toBe(true)
  })

  test("the engines' own hosts on their country domains are theirs, and other hosts are not", () => {
    for (const host of [
      "google.com",
      "www.google.co.uk",
      "www.google.com.au",
      "google.de",
      "consent.google.com",
      "ipv4.google.com",
    ])
      expect(ResearchSearch.own(host)).toBe(true)
    for (const host of ["html.duckduckgo.com", "duckduckgo.com"]) expect(ResearchSearch.own(host)).toBe(true)
    for (const host of ["developers.google.com", "scholar.example.com", "notgoogle.com", "google.example.com"])
      expect(ResearchSearch.own(host)).toBe(false)
  })
})

describe("ResearchSearch.listing", () => {
  test("fences what the sites wrote and marks a page the run already read", () => {
    const text = ResearchSearch.listing(
      "heat pumps",
      [
        { url: "https://nature.com/a", title: "A study", snippet: "Homes saved energy." },
        { url: "https://example.org/b", title: "Another", snippet: "" },
      ],
      new Map([["https://nature.com/a", "S1"]]),
    )
    expect(text).toContain("untrusted_web_page")
    expect(text).toContain("1. A study (already read as S1)")
    expect(text).toContain("2. Another\n   https://example.org/b")
  })
})
