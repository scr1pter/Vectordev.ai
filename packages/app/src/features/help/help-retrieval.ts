// Selects the documentation the Help assistant is allowed to answer from.
// The corpus is the same GUIDE_SECTIONS the Help panel renders, so the
// assistant can never describe a control the user cannot also read about —
// an ungrounded model invents buttons and menu paths that do not exist.
import { GUIDE_SECTIONS, type GuideSection } from "@/features/onboarding/onboarding"

export type HelpDoc = {
  id: string
  kicker: string
  title: string
  where: string
  body: string
  tip?: string
}

export const helpDocs: HelpDoc[] = GUIDE_SECTIONS.flatMap((section: GuideSection) =>
  section.entries.map((entry) => ({
    id: `${section.kicker}::${entry.title}`,
    kicker: section.kicker,
    title: entry.title,
    where: entry.where,
    body: entry.body,
    tip: entry.tip,
  })),
)

// Words too common in this corpus to discriminate between entries.
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "that", "this", "these", "those",
  "is", "are", "was", "were", "be", "been", "being", "do", "does", "did", "can", "could", "will",
  "would", "should", "how", "what", "where", "when", "why", "who", "to", "of", "in", "on", "at",
  "for", "with", "from", "by", "it", "its", "my", "me", "i", "you", "your", "we", "us", "as",
  "so", "not", "no", "yes", "get", "got", "use", "using", "vector",
])

function tokenize(text: string) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
}

const searchText = (doc: HelpDoc) => ({
  title: doc.title.toLowerCase(),
  where: doc.where.toLowerCase(),
  body: `${doc.body} ${doc.tip ?? ""}`.toLowerCase(),
})

const indexed = helpDocs.map((doc) => ({ doc, text: searchText(doc) }))

// How many entries contain each word. A word in most entries ("project",
// "agent") says little about which entry answers the question; a rare word
// ("dictation") says a lot. Without this, any question containing a common
// verb matches half the corpus and the assistant answers from irrelevant docs.
const documentFrequency = new Map<string, number>()
for (const entry of indexed) {
  for (const word of new Set(tokenize(`${entry.text.title} ${entry.text.where} ${entry.text.body}`))) {
    documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1)
  }
}

function inverseFrequency(term: string) {
  return Math.log(indexed.length / (1 + (documentFrequency.get(term) ?? 0)))
}

// Title and locator matches weigh most: a question about "where is X" is
// answered by the entry named X, not by every entry mentioning it in prose.
function scoreDoc(text: ReturnType<typeof searchText>, terms: string[]) {
  const hits = terms.map((term) => ({
    term,
    weight: text.title.includes(term) ? 6 : text.where.includes(term) ? 3 : text.body.includes(term) ? 1 : 0,
  }))
  return {
    score: hits.reduce((total, hit) => total + hit.weight * Math.max(0, inverseFrequency(hit.term)), 0),
    // A match on the entry's name or its locator line means the question is
    // about that control. A single passing mention in prose does not.
    named: hits.some((hit) => hit.weight >= 3),
    matched: hits.filter((hit) => hit.weight > 0).length,
  }
}

const MIN_SCORE = 1.5

export function findRelevantDocs(query: string, limit = 5): HelpDoc[] {
  const terms = [...new Set(tokenize(query))]
  if (!terms.length) return []
  return indexed
    .map((entry) => ({ doc: entry.doc, ...scoreDoc(entry.text, terms) }))
    .filter((entry) => entry.score >= MIN_SCORE && (entry.named || entry.matched >= 2))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.doc)
}

export function renderDocsContext(docs: HelpDoc[]) {
  return docs
    .map((doc) =>
      [`## ${doc.title} (${doc.kicker})`, `Where: ${doc.where}`, doc.body, doc.tip ? `Tip: ${doc.tip}` : ""]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n")
}

// Context for one question. Returns an empty string when nothing matches so
// the endpoint tells the user the topic is undocumented rather than guessing.
export function helpContextFor(query: string, limit = 5) {
  return renderDocsContext(findRelevantDocs(query, limit))
}
