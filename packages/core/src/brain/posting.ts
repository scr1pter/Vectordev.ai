export * as BrainPosting from "./posting"

import { Effect } from "effect"
import { Brain } from "./brain"
import { BrainKnowledge } from "./knowledge"
import { BrainPrivate } from "./private"

// The posting check (section 6.4a): before Vector posts or commits text, the text is compared with what Vector knows
// about the owner, so memory that reached an agent does not end up on GitHub. It compares the whole post as one text
// (a review's body, every line comment and the fallback body), so a sentence split across two comments is still found,
// and reads it the way BrainPrivate does, so entities, percent-encoding, base64, homoglyphs, Markdown and code fences
// hide nothing. Literal overlap only: a paraphrase or a translation gets past it, which is why what goes into outward
// roles is screened first.

/** Consecutive words a post shares with a memory line that make the sentence overlap. */
export const RUN = 6
/** A memory line shorter than RUN but at least this long overlaps when a post says all of it. */
export const SHORT = 4

/** Hosts a fork's pull request text may link to or embed from, besides the repository's own. */
export const GITHUB_HOSTS = ["github.com", "githubusercontent.com"] as const

export type Memory = {
  /** How the owner works: their rules, preferences, decisions, lessons and review notes. */
  readonly habits: readonly string[]
  /** Private facts: MEMORY.md, personal facts, entries learned beside a private document, private passages. */
  readonly facts: readonly string[]
}

export type Input = {
  /** Everything one post sends, in order: a title and body, or a review's body, its line comments and fallback body. */
  readonly parts: readonly string[]
  /** The user typed or edited the text: it is never changed, only asked about. */
  readonly typed: boolean
  /** A pull request from a fork: links and images may point only at GitHub and `hosts`. */
  readonly untrusted?: boolean
  /** The repository's own hosts, besides GitHub's. */
  readonly hosts?: readonly string[]
}

export type Dropped = { readonly part: number; readonly text: string }

export type Result = {
  /**
   * clean: nothing overlaps. changed: Vector's own text lost the sentences that overlap, or a fork's links. ask: the
   * user's own text overlaps and is left as it is, for them to decide.
   */
  readonly status: "clean" | "changed" | "ask"
  readonly parts: readonly string[]
  /** The sentences that overlap: dropped from Vector's text, shown for the user's. Only ever shown to the owner. */
  readonly dropped: readonly Dropped[]
  /** Links and images taken out of a fork's pull request text. */
  readonly links: number
}

/**
 * The whole check against this computer's brain: the owner's memory as `Brain.posting` gives it, with the private
 * document passages recalled in `sessionIDs`. `known` says which of the tokens a post shares with memory the
 * repository itself holds; those are not private, so a reviewer can still write "use `Effect.fn` here".
 */
export const run = Effect.fn("BrainPosting.run")(function* (
  place: Brain.Place,
  input: Input & {
    readonly sessionIDs: readonly string[]
    readonly known: (tokens: readonly string[]) => Effect.Effect<ReadonlySet<string>>
  },
) {
  const brain = yield* Brain.Service
  const knowledge = yield* BrainKnowledge.Service
  const memory = yield* brain.posting(place, { sessionIDs: input.sessionIDs })
  const cards = memory.cards.length ? yield* knowledge.cards(place, memory.cards, { personal: true }) : []
  const sources = cards.length ? (yield* knowledge.sources(place, cards.map((card) => card.id))).documents : []
  const secret = new Set(sources.filter((document) => document.visibility === "private").map((document) => document.id))
  const all = {
    habits: memory.habits,
    facts: [...memory.facts, ...cards.filter((card) => secret.has(card.document)).map((card) => card.text)],
  }
  const known = yield* input.known(shared(input.parts, all))
  return check({ ...input, memory: all, known })
})

/** The tokens a post shares with memory, to ask the repository about. */
export function shared(parts: readonly string[], memory: Memory) {
  const remembered = memoryTokens(memory)
  return [
    ...new Set(
      parts.flatMap((part) =>
        BrainPrivate.tokens(part).flatMap((token) => (overlaps(token, remembered) ? [token.value] : [])),
      ),
    ),
  ]
}

/** The check itself, once the repository has said which shared tokens it holds. */
export function check(input: Input & { readonly memory: Memory; readonly known: ReadonlySet<string> }): Result {
  const hosts = [...GITHUB_HOSTS, ...(input.hosts ?? [])].map((host) => host.toLowerCase())
  const filtered = !input.typed && input.untrusted ? input.parts.map((part) => links(part, hosts)) : input.parts.map((text) => ({ text, links: 0 }))
  const spans = filtered.flatMap((part, index) => sentences(part.text).map((span) => ({ ...span, part: index })))
  const remembered = memoryTokens(input.memory)
  const lines = [...input.memory.habits, ...input.memory.facts].map(BrainPrivate.words)
  const runs = new Map(
    [SHORT, SHORT + 1, RUN].map((size) => [
      size,
      new Set(lines.flatMap((words) => (size === RUN ? grams(words, RUN) : words.length === size ? [words.join(" ")] : []))),
    ]),
  )
  const stream = spans.flatMap((span, index) => BrainPrivate.words(span.text).map((word) => ({ word, index })))
  const byRun = [...runs].flatMap(([size, known]) =>
    known.size === 0
      ? []
      : stream.flatMap((_, start) => {
          const window = stream.slice(start, start + size)
          return window.length === size && known.has(window.map((item) => item.word).join(" "))
            ? window.map((item) => item.index)
            : []
        }),
  )
  const byToken = spans.flatMap((span, index) =>
    BrainPrivate.tokens(span.text).some(
      (token) => overlaps(token, remembered) && !input.known.has(token.value) && !hosted(token, hosts),
    )
      ? [index]
      : [],
  )
  const marked = new Set([...byRun, ...byToken])
  const dropped = spans.flatMap((span, index) =>
    marked.has(index) ? [{ part: span.part, text: span.text.trim() }] : [],
  )
  const removed = filtered.reduce((sum, part) => sum + part.links, 0)
  if (input.typed) return { status: dropped.length ? "ask" : "clean", parts: input.parts, dropped, links: 0 }
  const parts = filtered.map((part, index) =>
    dropped.some((item) => item.part === index)
      ? tidy(spans.flatMap((span, at) => (span.part === index && !marked.has(at) ? [span.text] : [])).join(""))
      : part.text,
  )
  return { status: dropped.length || removed ? "changed" : "clean", parts, dropped, links: removed }
}

// The tokens memory holds, by what they are compared with: a how-you-work line by shapes that point at a person, a
// place or a record, a private fact by every rare token.
function memoryTokens(memory: Memory) {
  return {
    habits: new Set(memory.habits.flatMap((line) => BrainPrivate.tokens(line, BrainPrivate.SHAPED).map((token) => token.value))),
    facts: new Set(memory.facts.flatMap((line) => BrainPrivate.tokens(line).map((token) => token.value))),
  }
}

function overlaps(token: BrainPrivate.Token, remembered: ReturnType<typeof memoryTokens>) {
  return remembered.facts.has(token.value) || (BrainPrivate.SHAPED.includes(token.kind) && remembered.habits.has(token.value))
}

// GitHub's own hosts and the repository's are where its pull requests live, so naming them leaks nothing.
function hosted(token: BrainPrivate.Token, hosts: readonly string[]) {
  return token.kind === "host" && allowed(token.value, hosts)
}

function allowed(host: string, hosts: readonly string[]) {
  const name = host.toLowerCase()
  return hosts.some((item) => name === item || name.endsWith(`.${item}`))
}

function grams(words: readonly string[], size: number) {
  return words.flatMap((_, start) => (start + size <= words.length ? [words.slice(start, start + size).join(" ")] : []))
}

// A sentence ends at a line break, or at ., ! or ? before a space. The slices cover the whole text, so the kept ones
// join back into it.
function sentences(text: string) {
  const cuts = [0, ...[...text.matchAll(/[.!?]+(?=\s)|\n/g)].map((match) => match.index + match[0].length), text.length]
  return cuts.slice(1).flatMap((end, index) => (end > cuts[index]! ? [{ text: text.slice(cuts[index]!, end) }] : []))
}

function tidy(text: string) {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

// A fork's pull request text carries no link or image off GitHub: GitHub's image proxy fetches any image URL, so an
// image could carry text out without anyone seeing it. A link keeps its words; an image, a bare URL and a reference
// definition go.
function links(text: string, hosts: readonly string[]) {
  const counted = { links: 0 }
  const off = (url: string) => {
    const host = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i.exec(url.trim())?.[1]?.replace(/^[^@]*@/, "").replace(/:\d+$/, "")
    // A relative link or an anchor stays on the page it is on.
    if (!host && !/^[a-z][a-z0-9+.-]*:/i.test(url.trim())) return false
    if (host && allowed(host, hosts)) return false
    counted.links++
    return true
  }
  const out = text
    .replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*)?\)/g, (match, _alt: string, url: string) => (off(url) ? "" : match))
    .replace(/\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*)?\)/g, (match, label: string, url: string) => (off(url) ? label : match))
    .replace(/^[ \t]*\[[^\]]+\]:[ \t]*<?(\S+?)>?(?:[ \t].*)?$/gm, (match, url: string) => (off(url) ? "" : match))
    .replace(/<img\b[^>]*>/gi, (match) => {
      const url = /\bsrc\s*=\s*["']?([^"'\s>]+)/i.exec(match)?.[1] ?? ""
      return off(url) ? "" : match
    })
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (match, label: string) => {
      const url = /\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(match)?.[1] ?? ""
      return off(url) ? label : match
    })
    .replace(/(?<![("'<=\w])\b[a-z][a-z0-9+.-]*:\/\/[^\s)>\]"']+/gi, (match) => (off(match) ? "(link removed)" : match))
  return { text: out, links: counted.links }
}
