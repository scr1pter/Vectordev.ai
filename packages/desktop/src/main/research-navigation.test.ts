import { describe, expect, test } from "bun:test"
import { ResearchProvenance } from "@vectordevai/core/research/provenance"
import { ResearchSearch } from "@vectordevai/core/research/search"
import {
  ACTED_MS,
  BACK,
  CREDENTIALS,
  DATA_LIKE,
  NOT_LINK,
  NOT_SEARCH,
  PAGE_STARTED,
  POST,
  PRIVATE,
  SCHEME,
  addLinks,
  decideResearchNavigation,
  type Input,
} from "./research-navigation"

// The research browsers' navigation rule as a decision table (section 5.6a). It is pure, so it runs here without
// Electron; research-browser.test.ts checks that the slot sessions run it on every frame request.

const NOW = 1_000_000
const RESULT = "https://journal.example/study"
const TYPED = "https://typed.example/notes"
const PAGE = "https://journal.example/study"

const provenance = ResearchProvenance.add(
  ResearchProvenance.add(ResearchProvenance.empty(), [RESULT], "search"),
  [TYPED],
  "typed",
)

const decide = (input: Partial<Input> & Pick<Input, "url">) =>
  decideResearchNavigation({
    method: "GET",
    frame: "main",
    kind: "page",
    provenance,
    links: new Set(),
    forms: new Set(),
    current: PAGE,
    now: NOW,
    ...input,
  })

describe("research browser navigation rule", () => {
  test("a search loads only the results page Vector built for it, which robots.txt does not decide", () => {
    for (const engine of ResearchSearch.ENGINES)
      expect(decide({ url: ResearchSearch.page(engine, { query: "heat pumps" }), kind: "search" })).toEqual({
        allow: true,
        via: "search",
        robots: false,
      })
    // Any other address is refused as a search, a result's included: those are opened, not searched.
    for (const url of [
      RESULT,
      "https://www.google.com/url?q=https://evil.example/",
      "http://www.google.com/search?q=x",
    ])
      expect(decide({ url, kind: "search" })).toEqual({ allow: false, reason: NOT_SEARCH })
    expect(decide({ url: "https://user:pw@www.google.com/search?q=x", kind: "search" })).toEqual({
      allow: false,
      reason: CREDENTIALS,
    })
    // The results page's own navigations on its origin (Google's page reloads itself by script) are the search's, and
    // robots.txt does not decide them; a page that is not a search's keeps robots.txt, and no search page reaches
    // another site on its own.
    const results = ResearchSearch.page("google", { query: "heat pumps" })
    const reload = `${results}&sei=abc`
    expect(decide({ url: reload, current: results, searching: true })).toEqual({
      allow: true,
      via: "same-origin",
      robots: false,
    })
    expect(decide({ url: reload, current: results })).toEqual({ allow: true, via: "same-origin", robots: true })
    expect(decide({ url: RESULT, current: results, searching: true })).toEqual({ allow: false, reason: PAGE_STARTED })
    // A results page is not something the agent may open: it is in no run's provenance.
    expect(decide({ url: ResearchSearch.page("google", { query: "heat pumps" }), kind: "open" })).toMatchObject({
      allow: false,
    })
  })

  test("robots.txt is skipped only for the engine's own pages a search leads to, not for its whole host", () => {
    const results = ResearchSearch.page("google", { query: "heat pumps" })
    // A search's redirect to Google's check or consent wall, or to another results page, is the search's.
    for (const url of [
      "https://www.google.com/sorry/index?continue=https://www.google.com/search",
      "https://ipv4.google.com/sorry/index?continue=https://www.google.com/search",
      "https://consent.google.com/ml?continue=https://www.google.com/search",
      `${results}&sei=abc`,
    ])
      expect(decide({ url, kind: "redirect", searching: true })).toEqual({
        allow: true,
        via: "redirect",
        robots: false,
      })
    // Anywhere else on the engine's host, by a redirect or by the page's own navigation, robots.txt decides.
    for (const url of ["https://www.google.com/preferences?hl=en", "https://www.google.com/url?q=https://a.example/"]) {
      expect(decide({ url, kind: "redirect", searching: true })).toEqual({ allow: true, via: "redirect", robots: true })
      expect(decide({ url, current: results, searching: true })).toEqual({
        allow: true,
        via: "same-origin",
        robots: true,
      })
    }
    // Not a search's: the check page is a redirect like any other.
    expect(decide({ url: "https://www.google.com/sorry/index", kind: "redirect" })).toEqual({
      allow: true,
      via: "redirect",
      robots: true,
    })
  })

  test("the agent opens only addresses in the run's provenance", () => {
    expect(decide({ url: RESULT, kind: "open" })).toEqual({ allow: true, via: "provenance", robots: true })
    // robots.txt does not apply to an address the user typed, as research_read reads one.
    expect(decide({ url: TYPED, kind: "open" })).toEqual({ allow: true, via: "provenance", robots: false })
    expect(decide({ url: "https://elsewhere.example/", kind: "open" })).toEqual({
      allow: false,
      reason: ResearchProvenance.REFUSAL,
    })
    // An added tracking parameter is a new spelling, which may carry text, so it is not the recorded address.
    expect(decide({ url: `${RESULT}?ref=acme-q3`, kind: "open" })).toMatchObject({ allow: false })
  })

  test("a link Vector read on the page joins provenance as via S#, when the agent acted", () => {
    const link = "https://other.example/paper"
    const read = new Set([link])
    expect(decide({ url: link, links: read, actedAt: NOW - 500 })).toEqual({
      allow: true,
      via: "link",
      join: link,
      robots: true,
    })
    // The element the agent clicked, by its href.
    expect(decide({ url: link, clicked: link, actedAt: NOW - 10 })).toEqual({
      allow: true,
      via: "link",
      join: link,
      robots: true,
    })
    // A GET form target read on the page, with the fields its form built.
    expect(
      decide({
        url: "https://search.example/find?q=heat+pumps&lang=en",
        forms: new Set(["https://search.example/find"]),
        actedAt: NOW - 10,
      }),
    ).toEqual({ allow: true, via: "form", join: "https://search.example/find?lang=en&q=heat+pumps", robots: true })
    // Once joined, the address is provenance, and the agent may open it again.
    expect(decide({ url: link, kind: "open", provenance: addLinks(provenance, [link], "link") })).toEqual({
      allow: true,
      via: "provenance",
      robots: true,
    })
  })

  test("a link swapped at click time is decided as a redirect hop, without joining provenance", () => {
    expect(
      decide({ url: "https://swapped.example/landing", clicked: "https://other.example/paper", actedAt: NOW - 50 }),
    ).toEqual({ allow: true, via: "redirect", robots: true })
    // A redirect hop is decided again: a web address read with GET, robots.txt off the typed host.
    expect(decide({ url: "https://cdn.example/next", kind: "redirect" })).toEqual({
      allow: true,
      via: "redirect",
      robots: true,
    })
    expect(decide({ url: "https://typed.example/notes/2", kind: "redirect", typedHost: "typed.example" })).toEqual({
      allow: true,
      via: "redirect",
      robots: false,
    })
    expect(decide({ url: "data:text/html,hi", kind: "redirect" })).toEqual({ allow: false, reason: SCHEME })
  })

  test("a page-started cross-site navigation is refused, and a same-origin one is allowed", () => {
    expect(decide({ url: "https://tracker.example/?leak=1" })).toEqual({ allow: false, reason: PAGE_STARTED })
    // Even to a link on the page or an address in provenance: a page cannot walk the browser across sites by itself.
    expect(decide({ url: RESULT, current: "https://blog.example/post" })).toEqual({
      allow: false,
      reason: PAGE_STARTED,
    })
    const link = "https://other.example/paper"
    expect(decide({ url: link, links: new Set([link]), actedAt: NOW - ACTED_MS - 1 })).toEqual({
      allow: false,
      reason: PAGE_STARTED,
    })
    expect(decide({ url: "https://journal.example/study/figures" })).toEqual({
      allow: true,
      via: "same-origin",
      robots: true,
    })
    expect(decide({ url: "https://journal.example/next", actedAt: NOW })).toEqual({
      allow: true,
      via: "same-origin",
      robots: true,
    })
    // The agent acted, but the address was nowhere on the page.
    expect(decide({ url: "https://unknown.example/", actedAt: NOW - 100 })).toEqual({ allow: false, reason: NOT_LINK })
  })

  test("a data-like link is not followed even when the agent clicked it", () => {
    const encoded = "https://other.example/c/QWNtZVEzQ2h1cm5Ob3Rlc0Zvcg9xSGVsbG8gV29ybGQ="
    expect(decide({ url: encoded, clicked: encoded, actedAt: NOW })).toEqual({ allow: false, reason: DATA_LIKE })
    const long = `https://other.example/p?${"q=heat+pumps+".repeat(8)}`
    expect(decide({ url: long, clicked: long, actedAt: NOW })).toEqual({ allow: false, reason: DATA_LIKE })
  })

  test("a request that is not GET or HEAD is refused in any frame", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"])
      for (const frame of ["main", "sub"] as const)
        expect({ method, frame, decision: decide({ url: RESULT, method, frame, kind: "page", actedAt: NOW }) }).toEqual(
          { method, frame, decision: { allow: false, reason: POST } },
        )
    expect(decide({ url: RESULT, method: "HEAD", kind: "open" })).toMatchObject({ allow: true })
  })

  test("every non-web scheme is refused in the main frame, and about:blank only as the first page", () => {
    for (const url of [
      "data:text/html,<h1>hi</h1>",
      "blob:https://journal.example/7c1a",
      "javascript:alert(1)",
      "filesystem:https://journal.example/temporary/x",
      "file:///etc/passwd",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "oc://renderer/index.html",
      "vscode://file/x",
      "mailto:someone@example.com",
      "ftp://files.example/report.pdf",
      "ws://journal.example/socket",
      "about:srcdoc",
      "about:blank",
    ])
      for (const kind of ["open", "page", "back", "redirect"] as const)
        expect({ url, kind, decision: decide({ url, kind, actedAt: NOW }) }).toEqual({
          url,
          kind,
          decision: { allow: false, reason: SCHEME },
        })
    expect(decide({ url: "about:blank", initial: true })).toEqual({ allow: true, via: "initial", robots: false })
  })

  test("a subframe loads web pages, about:blank and about:srcdoc without provenance, and no other scheme", () => {
    for (const url of ["https://ads.example/frame", "about:blank", "about:srcdoc"])
      expect(decide({ url, frame: "sub" })).toEqual({ allow: true, via: "subframe", robots: false })
    for (const url of ["data:text/html,hi", "blob:https://journal.example/7c1a", "javascript:void(0)", "file:///x"])
      expect(decide({ url, frame: "sub" })).toEqual({ allow: false, reason: SCHEME })
  })

  test("an address that names this computer or the user's network is refused in any frame", () => {
    const local = addLinks(
      ResearchProvenance.empty(),
      ["http://10.0.0.5/wiki", "http://localhost:4096/session"],
      "typed",
    )
    for (const url of [
      "http://127.0.0.1:4096/session",
      "http://localhost:4096/",
      "http://[::1]:8080/",
      "http://10.0.0.5/wiki",
      "http://192.168.1.20/",
      "http://169.254.169.254/latest/meta-data/",
      "http://0.0.0.0/",
      "http://jira.acme.internal/browse/X-1",
      "http://printer.local/",
      "http://intranet/",
    ])
      for (const frame of ["main", "sub"] as const)
        expect({ url, frame, decision: decide({ url, frame, kind: "open", provenance: local }) }).toEqual({
          url,
          frame,
          decision: { allow: false, reason: PRIVATE },
        })
  })

  test("an address with a user name or password is refused", () => {
    expect(decide({ url: "https://user:secret@journal.example/", kind: "redirect" })).toEqual({
      allow: false,
      reason: CREDENTIALS,
    })
  })

  test("going back is decided like any navigation: an earlier visit does not approve it", () => {
    expect(decide({ url: RESULT, kind: "back" })).toEqual({ allow: true, via: "provenance", robots: true })
    const link = "https://other.example/paper"
    expect(decide({ url: link, kind: "back", links: new Set([link]) })).toEqual({
      allow: true,
      via: "link",
      robots: true,
    })
    // A page reached by the page's own same-origin navigation, and never a source or a link.
    expect(decide({ url: "https://journal.example/consent", kind: "back" })).toEqual({ allow: false, reason: BACK })
  })

  test("page links are compared without their fragment, which a request never carries", () => {
    const set = addLinks(ResearchProvenance.empty(), ["https://journal.example/a?utm_source=x#methods"], "link")
    expect(decide({ url: "https://journal.example/a?utm_source=x", kind: "open", provenance: set })).toMatchObject({
      allow: true,
    })
  })
})
