// Conservative parallel-intent detector for the composer.
//
// This only ever *suggests* delegating to Parallel Workspaces — it never
// triggers a side effect on its own. Because a false positive means an
// unwanted chip in front of the user (not a wrong action taken), we still
// keep detection deliberately narrow: explicit phrases or an unambiguous
// multi-item list, nothing inferred from vaguer signal.

export type ParallelIntent = {
  missions: string[]
  explicit: boolean
}

const MIN_PROMPT_LENGTH = 20
const MIN_LIST_MISSION_LENGTH = 12

const EXPLICIT_PHRASES = [
  "in parallel",
  "parallel workspaces",
  "delegate",
  "split this",
  "simultaneously",
  "at the same time",
]

const LIST_ITEM_PATTERN = /^\s*(?:\d+[.)]|[-*•])\s+(\S.*)$/

function trimmedNonEmpty(values: string[]) {
  return values.map((value) => value.trim()).filter((value) => value.length > 0)
}

function listItems(prompt: string): string[] {
  const items: string[] = []
  for (const line of prompt.split("\n")) {
    const match = line.match(LIST_ITEM_PATTERN)
    if (match) items.push(match[1].trim())
  }
  return items
}

// Sentence-level split used only for explicit-phrase prompts that have no
// list markup: "; " or " and then " when it yields at least two chunks.
function sentenceSplit(prompt: string): string[] | undefined {
  const bySemicolon = trimmedNonEmpty(prompt.split(/;\s+/))
  if (bySemicolon.length >= 2) return bySemicolon

  const byAndThen = trimmedNonEmpty(prompt.split(/\s+and then\s+/i))
  if (byAndThen.length >= 2) return byAndThen

  return undefined
}

function isQuestion(prompt: string) {
  return prompt.includes("?")
}

function hasExplicitPhrase(prompt: string) {
  const lower = prompt.toLowerCase()
  return EXPLICIT_PHRASES.some((phrase) => lower.includes(phrase))
}

export function detectParallelIntent(prompt: string): ParallelIntent | undefined {
  const trimmed = prompt.trim()
  if (trimmed.length < MIN_PROMPT_LENGTH) return undefined
  if (isQuestion(trimmed)) return undefined

  const explicit = hasExplicitPhrase(trimmed)
  const items = trimmedNonEmpty(listItems(trimmed))

  if (explicit) {
    // A "list" of one item isn't a split — fall through to sentence-level
    // (and finally whole-prompt) so a lone item never counts as multiple.
    if (items.length >= 2) return { missions: items, explicit: true }
    const sentences = sentenceSplit(trimmed)
    if (sentences) return { missions: sentences, explicit: true }
    return { missions: [trimmed], explicit: true }
  }

  if (items.length >= 2 && items.every((item) => item.length >= MIN_LIST_MISSION_LENGTH)) {
    return { missions: items, explicit: false }
  }

  return undefined
}
