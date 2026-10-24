export * as ResearchRobots from "./robots"

import { Clock, Effect } from "effect"

// robots.txt, read the way RFC 9309 says: the group for the `Vector` product token if there is one, else the `*`
// group; within it the longest matching rule wins, and an allow wins a tie. It applies to links Vector found itself
// (search results and page links); an address the user typed or pasted is read because they asked for it. A missing
// file (4xx) allows everything; a server error or no answer disallows everything until the cache expires. Each
// origin's answer is kept for 24 hours.

export const AGENT = "vector"
export const TTL = 24 * 60 * 60 * 1000
// The most of a robots.txt read, as RFC 9309 sets the floor.
export const MAX_BYTES = 500 * 1024

export type Rule = { readonly allow: boolean; readonly pattern: string }

/** Every path allowed, every path disallowed, or the rules of the matching group. */
export type Rules =
  | { readonly type: "all" }
  | { readonly type: "none" }
  | { readonly type: "rules"; readonly rules: readonly Rule[] }

/** What fetching an origin's robots.txt gave: a status and its text, or no answer at all. */
export type Fetched = { readonly status: number; readonly text: string } | { readonly status: "unreachable" }

/** The rules for `agent` in a robots.txt file. */
export function parse(text: string, agent = AGENT): Rules {
  const groups: { agents: string[]; rules: Rule[] }[] = []
  const state: { current?: { agents: string[]; rules: Rule[] }; rules: boolean } = { rules: false }
  for (const raw of text.slice(0, MAX_BYTES).split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, "").trim()
    const colon = line.indexOf(":")
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (key === "user-agent") {
      // A user-agent line after rules starts a new group; consecutive ones share a group.
      if (!state.current || state.rules) {
        state.current = { agents: [], rules: [] }
        groups.push(state.current)
        state.rules = false
      }
      state.current.agents.push(value.toLowerCase())
      continue
    }
    if ((key !== "allow" && key !== "disallow") || !state.current) continue
    state.rules = true
    // An empty Disallow allows everything, which is the same as no rule.
    if (value === "") continue
    state.current.rules.push({ allow: key === "allow", pattern: value })
  }
  const named = groups.filter((group) => group.agents.some((name) => matchesAgent(name, agent)))
  const chosen = named.length > 0 ? named : groups.filter((group) => group.agents.includes("*"))
  const rules = chosen.flatMap((group) => group.rules)
  return rules.length === 0 ? { type: "all" } : { type: "rules", rules }
}

/** Whether the rules let the agent read the address's path. robots.txt itself is always allowed. */
export function allowed(rules: Rules, url: string) {
  if (rules.type !== "rules") return rules.type === "all"
  const address = new URL(url)
  if (address.pathname === "/robots.txt") return true
  const target = normalize(`${address.pathname}${address.search}`)
  const best = rules.rules
    .filter((rule) => matches(normalize(rule.pattern), target))
    .toSorted((left, right) => right.pattern.length - left.pattern.length || Number(right.allow) - Number(left.allow))
    .at(0)
  return best?.allow ?? true
}

/** The rules an answer to a robots.txt fetch gives. */
export function rulesOf(fetched: Fetched): Rules {
  if (fetched.status === "unreachable" || fetched.status >= 500) return { type: "none" }
  if (fetched.status >= 400) return { type: "all" }
  if (fetched.status >= 200 && fetched.status < 300) return parse(fetched.text)
  return { type: "none" }
}

/**
 * A cache of each origin's robots.txt. `load` fetches `<origin>/robots.txt`; it is asked at most once per origin per
 * TTL. `check` says whether Vector may read an address: always for one the user gave (`typed`).
 */
export function cache(load: (robots: string) => Effect.Effect<Fetched>, ttl = TTL) {
  const entries = new Map<string, { readonly rules: Rules; readonly at: number }>()
  const rules = Effect.fn("ResearchRobots.rules")(function* (origin: string) {
    const now = yield* Clock.currentTimeMillis
    const cached = entries.get(origin)
    if (cached && now - cached.at < ttl) return cached.rules
    const fetched = yield* load(`${origin}/robots.txt`)
    const parsed = rulesOf(fetched)
    entries.set(origin, { rules: parsed, at: now })
    return parsed
  })
  return {
    rules,
    check: Effect.fn("ResearchRobots.check")(function* (url: string, options: { readonly typed?: boolean } = {}) {
      if (options.typed) return true
      return allowed(yield* rules(new URL(url).origin), url)
    }),
  }
}

export type Cache = ReturnType<typeof cache>

// "Vector", "vector/1.99" and "VectorBot" are not the same token: a group names Vector by its product token, which
// is matched without case and without any version after a slash.
function matchesAgent(name: string, agent: string) {
  return name.split("/")[0]!.trim() === agent
}

// `*` matches any run of characters and a final `$` anchors the end; everything else is literal. Paths are compared
// with their percent-encoding made uniform, so `/a%2fb` and `/a%2Fb` are one path.
function matches(pattern: string, target: string) {
  const anchored = pattern.endsWith("$")
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*")
  const first = parts[0]!
  if (!target.startsWith(first)) return false
  if (parts.length === 1) return !anchored || target === first
  const last = parts.at(-1)!
  // With "$" the last part sits at the very end, so the parts between have to fit before it.
  const end = anchored ? target.length - last.length : target.length
  if (anchored && (end < first.length || !target.endsWith(last))) return false
  const middle = anchored ? parts.slice(1, -1) : parts.slice(1)
  const reached = middle.reduce((at, part) => {
    if (at < 0) return at
    const found = target.indexOf(part, at)
    return found < 0 || found + part.length > end ? -1 : found + part.length
  }, first.length)
  return reached >= 0
}

function normalize(path: string) {
  return path.replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase())
}
