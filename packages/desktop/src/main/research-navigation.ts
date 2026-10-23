import { EgressProxy } from "@vectordevai/core/local-mode/egress-proxy"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { ResearchCanonical } from "@vectordevai/core/research/canonical"
import { ResearchProvenance } from "@vectordevai/core/research/provenance"

// The research browsers' navigation rule (section 5.6a), as one pure function. Electron's navigation events do not
// report the request method and do not fire for loadURL or history navigations, so research-browser.ts runs this in
// two places: in the slot session's webRequest.onBeforeRequest, which sees every main-frame and subframe request, every
// redirect hop and its method, and nothing skips; and in will-frame-navigate and will-redirect, only so the tool can say
// why a navigation stopped (and to stop schemes the network stack never sees, such as data: and blob:).
//
// A main frame may load:
// - an address in the run's provenance (search results, links research read offered, addresses the user typed, and
//   pages a research browser reached through a link), when the agent opened it, went back to it, or just acted;
// - a link Vector itself read on the page at the agent's last read, links or observe, the href of the element the agent
//   just clicked, or a GET form target read there, when the agent acted in the last 2 seconds. It then joins provenance
//   ("via S#"). A page that swaps a link's address at click time has the new address decided as a redirect hop;
// - an address on the current page's own origin, whoever started it: a script, a meta refresh or a timer navigation
//   with no agent action before it may stay there, and nowhere else, so a page cannot walk the browser across sites;
// - every redirect hop again: a web address fetched with GET, decided as research_read decides one (the research proxy
//   refuses a private destination after resolving it, and robots.txt applies off the typed host).
// Subframes load without provenance, like images, but only as web pages or about:blank and about:srcdoc. A request
// in any frame whose method is not GET or HEAD is refused: research browsers only read. A host that names this computer
// or the user's network is refused here already; the research proxy refuses the rest after resolving each name.

/** How long after an agent action a navigation still counts as the agent's. */
export const ACTED_MS = 2_000

export const SCHEME = "Research browsers open web pages only (http and https)."
export const POST = "Research browsers only read; that form would send data."
export const CREDENTIALS = "Research browsers never send a user name or password in an address."
export const PRIVATE = EgressProxy.PRIVATE_REASON
export const NOT_LINK =
  "That address was not a link on the page the research browser read, so the browser stayed on the page."
export const PAGE_STARTED = "The page tried to open another site on its own, so the research browser stayed on it."
export const DATA_LIKE = "That link looks built to carry data, so the research browser did not follow it."
export const BACK =
  "Going back is decided like any navigation, and that page did not come from a search result, a page link or your message."

export type Kind =
  /** The agent's open: Vector's own load of an address. */
  | "open"
  /** The agent's back. */
  | "back"
  /** A navigation the page made: a link, a form, a script, a meta refresh, a timer or a popup. */
  | "page"
  /** A redirect hop of a navigation the rule allowed. */
  | "redirect"

export type Input = {
  readonly url: string
  readonly method: string
  readonly frame: "main" | "sub"
  readonly kind: Kind
  /** The new browser's first empty page, the one time about:blank may load in the main frame. */
  readonly initial?: boolean
  /** The run's addresses, the desktop's copy of the engine's set. */
  readonly provenance: ResearchProvenance.Addresses
  /** Links Vector read on the page at the agent's last read, links or observe, as `exact` spells them. */
  readonly links: ReadonlySet<string>
  /** GET form targets read there, as origin and path. */
  readonly forms: ReadonlySet<string>
  /**
   * The href of the element the agent is clicking, given only for the first main-frame navigation that click starts:
   * the caller drops it once that navigation is decided, so a later command's navigation never sees it.
   */
  readonly clicked?: string
  /** The page's address as the rule last decided it. */
  readonly current?: string
  /** When the agent last opened, clicked, typed or pressed. */
  readonly actedAt?: number
  readonly now: number
  /** For a redirect hop: whether the navigation it continues started at an address the user typed, on this host. */
  readonly typedHost?: string
}

export type Decision =
  | {
      readonly allow: true
      readonly via: "initial" | "subframe" | "provenance" | "link" | "form" | "redirect" | "same-origin"
      /** The address that joins the run's provenance, as a page link ("via S#"). */
      readonly join?: string
      /** Whether robots.txt decides it too: everywhere but an address the user typed, and redirects on its host. */
      readonly robots: boolean
    }
  | { readonly allow: false; readonly reason: string }

export function decideResearchNavigation(input: Input): Decision {
  const scheme = schemeOf(input.url)
  if (input.frame === "sub" && (input.url === "about:blank" || input.url === "about:srcdoc"))
    return { allow: true, via: "subframe", robots: false }
  if (input.frame === "main" && input.url === "about:blank" && input.initial)
    return { allow: true, via: "initial", robots: false }
  if (scheme !== "http:" && scheme !== "https:") return refuse(SCHEME)
  const method = input.method.toUpperCase()
  if (method !== "GET" && method !== "HEAD") return refuse(POST)
  const address = new URL(input.url)
  if (address.username || address.password) return refuse(CREDENTIALS)
  if (LocalPolicy.hostClass(address.hostname) !== "internet") return refuse(PRIVATE)
  if (input.frame === "sub") return { allow: true, via: "subframe", robots: false }
  if (input.kind === "redirect")
    return { allow: true, via: "redirect", robots: !input.typedHost || input.typedHost !== address.hostname }
  const known = ResearchProvenance.check(input.provenance, input.url)
  const robots = !known.ok || known.from !== "typed"
  if (input.kind === "open") return known.ok ? { allow: true, via: "provenance", robots } : refuse(known.message)
  if (input.kind === "back") {
    if (known.ok) return { allow: true, via: "provenance", robots }
    return input.links.has(spelled(input.url)) ? { allow: true, via: "link", robots: true } : refuse(BACK)
  }
  const acted = input.actedAt !== undefined && input.now - input.actedAt <= ACTED_MS
  const same = input.current !== undefined && origin(input.current) === address.origin
  if (!acted) return same ? { allow: true, via: "same-origin", robots: true } : refuse(PAGE_STARTED)
  if (known.ok) return { allow: true, via: "provenance", robots }
  const exact = spelled(input.url)
  if (input.links.has(exact)) return { allow: true, via: "link", join: exact, robots: true }
  if (input.clicked !== undefined && spelled(input.clicked) === exact)
    return ResearchProvenance.dataLike(exact)
      ? refuse(DATA_LIKE)
      : { allow: true, via: "link", join: exact, robots: true }
  // A GET form builds its address from its fields: the page's own and what the agent typed, which passed the outbound
  // check before it was typed. So its query is not judged as a link's would be.
  if (input.forms.has(`${address.origin}${address.pathname}`))
    return { allow: true, via: "form", join: exact, robots: true }
  if (same) return { allow: true, via: "same-origin", robots: true }
  // The element the agent clicked led somewhere else than its href said: the page swapped it, as a server's redirect
  // would. What it can send is what the page already had.
  if (input.clicked !== undefined) return { allow: true, via: "redirect", robots: true }
  return refuse(NOT_LINK)
}

/** A link as the rule compares it: http or https, no fragment, as `exact` spells it; anything else is left as given. */
export function spelled(url: string) {
  if (!URL.canParse(url)) return url
  const address = new URL(url)
  address.hash = ""
  return ResearchCanonical.exact(address.toString()) ?? url
}

/**
 * The run's addresses with these added as page links, each also without its fragment: a request never carries one, and
 * leaving it out only takes text away.
 */
export function addLinks(set: ResearchProvenance.Addresses, urls: readonly string[], from: ResearchProvenance.From) {
  return ResearchProvenance.add(set, [...urls, ...urls.map(spelled)], from)
}

function schemeOf(url: string) {
  if (!URL.canParse(url)) return ""
  return new URL(url).protocol
}

function origin(url: string) {
  if (!URL.canParse(url)) return ""
  return new URL(url).origin
}

function refuse(reason: string): Decision {
  return { allow: false, reason }
}
