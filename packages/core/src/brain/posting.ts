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
 * document passages recalled in `sessionIDs`. `known` says which of the host names a post shares with how the owner
 * works the repository itself holds, as whole words: those are not private, since the post goes to that repository.
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
  const asked = shared(input.parts, all)
  const known = asked.length ? yield* input.known(asked) : new Set<string>()
  return check({ ...input, memory: all, known })
})

/**
 * The tokens a post shares with memory that the repository may hold: host names of how the owner works. A private
 * fact's tokens are never asked about, and neither is an e-mail address or a number: those stay private wherever else
 * they appear.
 */
export function shared(parts: readonly string[], memory: Memory) {
  const remembered = memoryTokens(memory)
  return [
    ...new Set(
      parts.flatMap((part) =>
        [part, BrainPrivate.rendered(part)].flatMap((text) =>
          BrainPrivate.tokens(text).flatMap((token) =>
            overlaps(token, remembered) && exempt(token, remembered) ? [token.value] : [],
          ),
        ),
      ),
    ),
  ]
}

/** The check itself, once the repository has said which shared tokens it holds. */
export function check(input: Input & { readonly memory: Memory; readonly known: ReadonlySet<string> }): Result {
  const hosts = [...GITHUB_HOSTS, ...(input.hosts ?? [])].map((host) => host.toLowerCase())
  const filtered = !input.typed && input.untrusted ? input.parts.map((part) => links(part, hosts)) : input.parts.map((text) => ({ text, links: 0 }))
  // Each sentence is read twice: as written, which still holds what a tag, a comment or a link's address carries, and
  // as GitHub shows it, where markup between the words no longer splits them. Sentences are cut where the shown text
  // ends one, so a full stop inside a comment does not cut it.
  const spans = filtered.flatMap((part, index) => {
    const shown = BrainPrivate.rendered(part.text)
    return sentences(shown).map((span) => ({
      text: part.text.slice(span.start, span.end),
      shown: shown.slice(span.start, span.end),
      part: index,
    }))
  })
  const remembered = memoryTokens(input.memory)
  const lines = [...input.memory.habits, ...input.memory.facts].map(BrainPrivate.words)
  const runs = new Map(
    [SHORT, SHORT + 1, RUN].map((size) => [
      size,
      new Set(lines.flatMap((words) => (size === RUN ? grams(words, RUN) : words.length === size ? [words.join(" ")] : []))),
    ]),
  )
  // The same runs with the spaces taken out, so a post that joins its words with something unseen, or splits them
  // with markup, still spells them: "Runㅤthe" and "R<i></i>un the" both read as "runthe".
  const spelled = heads(
    lines.flatMap((words) => [...grams(words, RUN), ...(words.length >= SHORT && words.length < RUN ? [words.join(" ")] : [])]),
  )
  const byRun = [(span: (typeof spans)[number]) => span.text, (span: (typeof spans)[number]) => span.shown].flatMap((read) => {
    const stream = spans.flatMap((span, index) => BrainPrivate.words(read(span)).map((word) => ({ word, index })))
    return [
      ...[...runs].flatMap(([size, known]) =>
        known.size === 0
          ? []
          : stream.flatMap((_, start) => {
              const window = stream.slice(start, start + size)
              return window.length === size && known.has(window.map((item) => item.word).join(" "))
                ? window.map((item) => item.index)
                : []
            }),
      ),
      ...letters(stream, spelled),
    ]
  })
  const byToken = spans.flatMap((span, index) =>
    [span.text, span.shown].some((text) =>
      BrainPrivate.tokens(text).some(
        (token) =>
          overlaps(token, remembered) &&
          !(exempt(token, remembered) && input.known.has(token.value)) &&
          !hosted(token, hosts),
      ),
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

// Runs spelled without spaces count only from this many letters: shorter, they turn up inside unrelated words.
const LETTERS = 20
// Letters a spelled run is looked up by.
const HEAD = 8

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

// Only a host name from how the owner works stops being private when the repository holds it (6.4a: "a host name
// outside the repository"). A private fact's tokens, e-mail addresses and numbers stay private wherever else they are.
function exempt(token: BrainPrivate.Token, remembered: ReturnType<typeof memoryTokens>) {
  return token.kind === "host" && !remembered.facts.has(token.value)
}

// GitHub's own hosts and the repository's are where its pull requests live, so naming them leaks nothing.
function hosted(token: BrainPrivate.Token, hosts: readonly string[]) {
  return token.kind === "host" && allowed(token.value, hosts)
}

// Only a plain host name can be on the list: one with an escape, a bracket or another script in it is someone else's.
function allowed(host: string, hosts: readonly string[]) {
  const name = host.toLowerCase()
  return /^[a-z0-9.-]+$/.test(name) && hosts.some((item) => name === item || name.endsWith(`.${item}`))
}

function grams(words: readonly string[], size: number) {
  return words.flatMap((_, start) => (start + size <= words.length ? [words.slice(start, start + size).join(" ")] : []))
}

// Spelled runs by their first letters, so a post is walked once rather than once for each run.
function heads(runs: readonly string[]) {
  return [...new Set(runs.map((run) => run.replaceAll(" ", "")))]
    .filter((run) => run.length >= LETTERS)
    .reduce((map, run) => map.set(run.slice(0, HEAD), [...(map.get(run.slice(0, HEAD)) ?? []), run]), new Map<string, string[]>())
}

// The sentences a spelled run covers, wherever its letters start and end.
function letters(stream: readonly { word: string; index: number }[], spelled: ReadonlyMap<string, readonly string[]>) {
  if (spelled.size === 0) return []
  const text = stream.map((item) => item.word).join("")
  const owner = stream.flatMap((item) => Array.from({ length: item.word.length }, () => item.index))
  return Array.from({ length: Math.max(0, text.length - HEAD + 1) }, (_, at) => at).flatMap((at) =>
    (spelled.get(text.slice(at, at + HEAD)) ?? []).flatMap((run) => (text.startsWith(run, at) ? owner.slice(at, at + run.length) : [])),
  )
}

// A sentence ends at a line break, or at ., ! or ? before a space. The spans cover the whole text, so the kept ones
// join back into it.
function sentences(text: string) {
  const cuts = [0, ...[...text.matchAll(/[.!?]+(?=\s)|\n/g)].map((match) => match.index + match[0].length), text.length]
  return cuts.slice(1).flatMap((end, index) => (end > cuts[index]! ? [{ start: cuts[index]!, end }] : []))
}

function tidy(text: string) {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/**
 * The host an address points at, as a browser reads it: after a web scheme and any slashes either way round, after
 * another scheme and two slashes, after two slashes alone, or a `www.` name. Undefined for a relative address, an
 * anchor, or a scheme with no host such as `mailto:`.
 */
export function hostOf(url: string) {
  const value = BrainPrivate.entities(url.trim()).replace(/[\t\n\r]/g, "")
  const authority =
    /^(?:https?|ftps?|wss?):[\\/]*([^\\/?#\s]*)/i.exec(value)?.[1] ??
    /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]*)/i.exec(value)?.[1] ??
    /^[\\/]{2}([^\\/?#\s]*)/.exec(value)?.[1] ??
    /^(www\.[^\\/?#\s]+)/i.exec(value)?.[1]
  if (authority === undefined) return undefined
  return authority
    .slice(authority.lastIndexOf("@") + 1)
    .replace(/:\d*$/, "")
    .replace(/\.+$/, "")
    .toLowerCase()
}

// A fork's pull request text carries no link or image off GitHub: GitHub's image proxy fetches any image URL, so an
// image could carry text out without anyone seeing it. First the shapes a reader would miss least: an image goes and a
// link keeps its words. Then every address left, whatever Markdown or HTML is around it, is taken out when it points
// anywhere else: each URL attribute's value, and each scheme with slashes, pair of slashes or `www.` name in the text
// as a browser reads it, with entities, backslash escapes and tabs decoded.
function links(text: string, hosts: readonly string[]) {
  const counted = { links: 0 }
  const off = (url: string) => {
    const host = hostOf(url)
    // A relative link or an anchor stays on the page it is on.
    if (host === undefined || allowed(host, hosts)) return false
    counted.links++
    return true
  }
  const shaped = text
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
    // A URL attribute anywhere, srcset's list included: a value with any address off GitHub is emptied.
    .replace(
      /(\b(?:src|srcset|href|poster|background|action|formaction|data|cite|longdesc|lowsrc|dynsrc|xlink:href)\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi,
      (match, name: string, value: string) => {
        const urls = BrainPrivate.entities(value.replace(/^["']|["']$/g, ""))
          .split(",")
          .map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
        return urls.filter(off).length ? `${name}""` : match
      },
    )
  return { text: addresses(shaped, off), links: counted.links }
}

// Every address in the text as a browser reads it, mapped back to the characters it came from, and replaced when `off`
// says it points somewhere it may not.
function addresses(text: string, off: (url: string) => boolean) {
  const decoded = [...text.matchAll(/&#x[0-9a-f]{1,6};?|&#\d{1,7};?|&[a-z]+;|\\[!-/:-@[-`{-~]|\t|[\s\S]/gi)].map((match) => ({
    text: match[0] === "\t" ? "" : match[0].startsWith("\\") && match[0].length === 2 ? match[0][1]! : match[0].startsWith("&") ? BrainPrivate.entities(match[0]) : match[0],
    start: match.index,
    end: match.index + match[0].length,
  }))
  const offsets = decoded.flatMap((piece) => Array.from({ length: piece.text.length }, () => piece))
  const view = decoded.map((piece) => piece.text).join("")
  const found = [
    ...view.matchAll(
      /(?:\b[a-z][a-z0-9+.-]*:[\\/]{2}|\b(?:https?|ftps?|wss?):[\\/]*(?=[\p{L}\p{N}%[])|(?<![\p{L}\p{N}:\\/._-])[\\/]{2}(?=[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+|\[)|(?<![\p{L}\p{N}.@_-])www\.)[^\s<>"'`)\]]*/giu,
    ),
  ].flatMap((match) => {
    const first = offsets[match.index]
    const last = offsets[match.index + match[0].length - 1]
    return first && last && off(match[0]) ? [{ start: first.start, end: last.end }] : []
  })
  return found.toReversed().reduce((out, range) => `${out.slice(0, range.start)}(link removed)${out.slice(range.end)}`, text)
}
