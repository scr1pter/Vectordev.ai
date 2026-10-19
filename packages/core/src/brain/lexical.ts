export * as BrainLexical from "./lexical"

// The code-aware tokenizer and BM25 scorer that Vector's local retrieval shares. The desktop repository index ranks
// files with it and the brain ranks memory entries with it, so both read a query the same way: identifiers are split
// into their camelCase and snake_case parts, keywords and prose filler drop out, and no model is involved anywhere.

// Keywords and prose filler are dropped before they reach a term table. BM25 would already discount them through idf,
// but keeping them out keeps tables small and stops "use" or "the" from making two unrelated texts look alike.
export const STOP_TERMS: ReadonlySet<string> = new Set([
  "abstract",
  "about",
  "after",
  "again",
  "also",
  "and",
  "args",
  "async",
  "await",
  "before",
  "bool",
  "boolean",
  "break",
  "case",
  "catch",
  "char",
  "class",
  "code",
  "const",
  "continue",
  "declare",
  "def",
  "default",
  "defer",
  "delete",
  "each",
  "else",
  "elif",
  "end",
  "enum",
  "error",
  "err",
  "export",
  "extends",
  "false",
  "file",
  "final",
  "float",
  "for",
  "from",
  "func",
  "function",
  "have",
  "impl",
  "implements",
  "import",
  "int",
  "interface",
  "into",
  "let",
  "make",
  "match",
  "mod",
  "module",
  "namespace",
  "new",
  "nil",
  "none",
  "not",
  "null",
  "number",
  "package",
  "please",
  "print",
  "private",
  "protected",
  "public",
  "pub",
  "require",
  "return",
  "self",
  "should",
  "static",
  "str",
  "string",
  "struct",
  "super",
  "switch",
  "that",
  "the",
  "this",
  "throw",
  "trait",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "use",
  "using",
  "val",
  "var",
  "void",
  "want",
  "while",
  "with",
  "yield",
])

// Prose words a memory entry or a request is full of that say nothing about what it is about. Only the brain drops
// these; a source file's identifiers rarely are one, so the repository index keeps STOP_TERMS alone.
const PROSE_TERMS: ReadonlySet<string> = new Set([
  "all",
  "always",
  "any",
  "are",
  "because",
  "but",
  "can",
  "could",
  "did",
  "does",
  "done",
  "don",
  "doesn",
  "every",
  "get",
  "got",
  "had",
  "has",
  "here",
  "how",
  "just",
  "like",
  "more",
  "most",
  "much",
  "must",
  "need",
  "never",
  "now",
  "only",
  "our",
  "out",
  "run",
  "same",
  "see",
  "some",
  "than",
  "them",
  "then",
  "there",
  "these",
  "they",
  "thing",
  "those",
  "too",
  "under",
  "very",
  "was",
  "way",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "would",
  "you",
  "your",
])

export const IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_]{1,63}/g

export function splitIdentifier(identifier: string) {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
}

/** The distinct terms of a task description or search, the way the repository index reads one. */
export function queryTerms(query: string) {
  const terms = new Set<string>()
  for (const match of query.toLowerCase().matchAll(IDENTIFIER_PATTERN)) {
    const identifier = match[0]
    if (identifier.length >= 3 && !STOP_TERMS.has(identifier)) terms.add(identifier)
    for (const part of splitIdentifier(identifier)) {
      if (part.length >= 3 && !STOP_TERMS.has(part)) terms.add(part)
    }
  }
  for (const match of query.matchAll(/[A-Za-z_$][\w$]*/g)) {
    for (const part of splitIdentifier(match[0])) {
      const partial = part.toLowerCase()
      if (partial.length >= 3 && !STOP_TERMS.has(partial)) terms.add(partial)
    }
  }
  return [...terms]
}

/**
 * The terms of a memory entry or request, with their counts. Path segments count as words, so
 * `packages/engine/test` matches a request about "engine tests". Prose filler is dropped as well as code keywords.
 */
export function terms(text: string) {
  const counts = new Map<string, number>()
  const add = (term: string) => {
    if (term.length < 3 || term.length > 40 || STOP_TERMS.has(term) || PROSE_TERMS.has(term)) return
    counts.set(stem(term), (counts.get(stem(term)) ?? 0) + 1)
  }
  for (const match of text.matchAll(IDENTIFIER_PATTERN)) {
    const lower = match[0].toLowerCase()
    const parts = splitIdentifier(match[0]).map((part) => part.toLowerCase())
    add(lower)
    for (const part of parts) if (part !== lower) add(part)
  }
  return counts
}

// A light suffix strip, so "tests" meets "test" and "failing" meets "fails". Stemming further would join unrelated
// identifiers, which matter more in code than plurals do.
function stem(term: string) {
  if (term.length > 5 && term.endsWith("ing")) return single(term.slice(0, -3))
  if (term.length > 4 && (term.endsWith("ies") || term.endsWith("ied"))) return `${term.slice(0, -3)}y`
  if (term.length > 4 && term.endsWith("es") && /(?:ss|sh|ch|x)es$/.test(term)) return term.slice(0, -2)
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1)
  if (term.length > 4 && term.endsWith("ed")) return single(term.slice(0, -2))
  return term
}

// "running" and "stopped" are "run" and "stop"; "calling" and "passed" keep their double letter.
function single(term: string) {
  return term.length >= 4 && /([b-df-hj-km-np-tv-z])\1$/.test(term) && !/(?:ll|ss|zz|ff)$/.test(term) ? term.slice(0, -1) : term
}

/** Jaccard similarity of two term sets: 1 for the same words, 0 for none in common. */
export function similarity(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>) {
  if (left.size === 0 || right.size === 0) return 0
  const shared = [...left.keys()].filter((term) => right.has(term)).length
  return shared / (left.size + right.size - shared)
}

/**
 * Whether a quote states all of a memory, the same way round. Evidence is only evidence for what it says, so sharing
 * most of a memory's words is not enough: "fix the failing login tests" says nothing of "failing login tests need TLS
 * off", and "we never deploy staging from main" says the opposite of "deploy staging from main". So every term of the
 * memory has to be in the quote, every value it gives (a number, version, path or flag) as written, and every "not" it
 * says or the quote says about its words in both. A cited file's path counts as said by its quote.
 */
export function states(text: string, quote: string, file = "") {
  const own = [...terms(text).keys()].filter((term) => !STOP_TERMS.has(term) && !PROSE_TERMS.has(term))
  if (own.length === 0) return false
  const cited = terms(`${quote} ${file}`)
  if (!own.every((term) => cited.has(term))) return false
  const mine = turns(text).filter((turn) => turn.word === "not")
  const theirs = turns(quote).filter((turn) => turn.word === "not")
  if (!mine.every((turn) => theirs.some((other) => other.target === turn.target))) return false
  // A "not" in the quote that reaches the memory's words has to be in the memory too: "do not, whatever happens,
  // deploy from main" is no evidence for "deploy from main". One about something else ("never from the root") is not.
  if (
    !theirs.every(
      (turn) => !turn.window.some((term) => own.includes(term)) || mine.some((other) => other.target === turn.target),
    )
  )
    return false
  const given = values(`${quote} ${file}`)
  return values(text).every((value) => given.some((item) => item === value || item.endsWith(`/${value}`)))
}

// Values a text gives exactly: numbers and versions, paths and file names, flags. Words can agree while these differ
// ("port 4096", "port 3000"), and a number never reaches a term table at all.
function values(text: string) {
  return text
    .toLowerCase()
    .split(/[\s,;()[\]{}<>"'`“”‘’]+/)
    .map((word) => word.replace(/^\.\//, "").replace(/[.:!?]+$/, ""))
    .filter((word) => /\d/.test(word) || /[\w-]\/[\w.-]/.test(word) || /^--?[a-z]/.test(word) || /\w\.\w/.test(word))
}

// Words that say how a check runs rather than which check it is.
const RUNNERS: ReadonlySet<string> = new Set(["bun", "bunx", "npm", "npx", "pnpm", "yarn", "deno", "node", "exec", "dlx"])

/** Whether a memory's text names the check a command ran, so a passing `bun test` vouches only for a lesson about it. */
export function named(text: string, command: string) {
  const own = terms(text)
  return [...terms(command).keys()].some((term) => !RUNNERS.has(term) && own.has(term))
}

// Words that turn a sentence around. The term tables drop them as filler, so "Use npm, not pnpm" and "Use pnpm, not
// npm" have the same terms; what each one applies to tells the two apart. Every way of saying "not" counts as one, so
// "never use npm" and "don't use npm" say the same thing.
const NEGATION: ReadonlySet<string> = new Set([
  "not",
  "never",
  "no",
  "nor",
  "neither",
  "don",
  "dont",
  "doesn",
  "didn",
  "isn",
  "aren",
  "wasn",
  "weren",
  "won",
  "wouldn",
  "shouldn",
  "couldn",
  "mustn",
  "cannot",
  "cant",
  "without",
  "avoid",
  "instead",
  "stop",
])
const EMPHASIS: ReadonlySet<string> = new Set(["only", "always"])

/**
 * Each turning word with the word it applies to (the next word that is not filler), and the few words after it that
 * it may reach.
 */
function turns(text: string) {
  // "No, use pnpm" answers what came before; it turns nothing in what follows.
  const words =
    text
      .toLowerCase()
      .replace(/\bno\s*[,.!;:—–]/g, " ")
      .replace(/n['’]t\b/g, " not")
      .match(/[a-z0-9_]+/g) ?? []
  return words.flatMap((word, index) => {
    if (!NEGATION.has(word) && !EMPHASIS.has(word)) return []
    const window = words
      .slice(index + 1, index + 30)
      .filter((later) => later.length >= 3 && !NEGATION.has(later) && !EMPHASIS.has(later) && !STOP_TERMS.has(later) && !PROSE_TERMS.has(later))
      .map(stem)
      .filter((later) => !STOP_TERMS.has(later) && !PROSE_TERMS.has(later))
      .slice(0, 3)
    return [{ word: NEGATION.has(word) ? "not" : word, target: window[0] ?? "", window }]
  })
}

/**
 * Each turning word with the word it applies to, as one string: equal for two wordings that say the same thing, and
 * different for a correction, which merging would otherwise lose.
 */
export function polarity(text: string) {
  return turns(text)
    .map((turn) => `${turn.word}:${turn.target}`)
    .toSorted()
    .join(" ")
}

export type Document = {
  readonly id: string
  readonly terms: ReadonlyMap<string, number>
}

/**
 * Okapi BM25 of each document against the query's terms (k1 1.2, b 0.75), highest first. Documents that share no term
 * with the query are left out, so an unrelated request scores nothing at all.
 */
export function rank(documents: readonly Document[], query: ReadonlyMap<string, number>) {
  if (documents.length === 0 || query.size === 0) return []
  const length = (document: Document) => [...document.terms.values()].reduce((sum, count) => sum + count, 0)
  const average = Math.max(1, documents.reduce((sum, document) => sum + length(document), 0) / documents.length)
  const frequency = new Map<string, number>()
  for (const document of documents)
    for (const term of document.terms.keys()) if (query.has(term)) frequency.set(term, (frequency.get(term) ?? 0) + 1)
  return documents
    .flatMap((document) => {
      const size = length(document)
      const matched = [...query.keys()].filter((term) => document.terms.has(term))
      if (matched.length === 0) return []
      const score = matched.reduce((sum, term) => {
        const count = document.terms.get(term) ?? 0
        const containing = frequency.get(term) ?? 0
        const idf = Math.log(1 + (documents.length - containing + 0.5) / (containing + 0.5))
        return sum + (idf * (count * 2.2)) / (count + 1.2 * (0.25 + (0.75 * size) / average))
      }, 0)
      return [{ id: document.id, score, matched }]
    })
    .toSorted((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}
