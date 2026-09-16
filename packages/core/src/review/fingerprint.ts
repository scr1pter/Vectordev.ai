// Finding identity. The fingerprint is the finding's id and is used for exact dedupe only: matching a finding
// to an earlier one across pushes is by location first (select.ts), because models reword titles freely.

import type { Category } from "./types"

// Words that say nothing about which defect a title describes. Keeping "not" and "no" out of the tokens makes
// "Token is not validated" and "Token stored before validation" closer, which is what matching wants.
const STOPWORDS = new Set([
  "a",
  "about",
  "after",
  "all",
  "also",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "between",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "during",
  "each",
  "even",
  "every",
  "for",
  "from",
  "had",
  "has",
  "have",
  "here",
  "how",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "may",
  "might",
  "more",
  "must",
  "no",
  "nor",
  "not",
  "of",
  "on",
  "only",
  "or",
  "other",
  "over",
  "same",
  "should",
  "so",
  "some",
  "still",
  "such",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "too",
  "under",
  "until",
  "very",
  "via",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "why",
  "will",
  "with",
  "would",
])

const TITLE_TOKENS = 8

// Lowercase, alphanumeric tokens, stopwords dropped, unique tokens sorted, first 8.
export function normalizeTitle(title: string): string[] {
  const tokens = title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return [...new Set(tokens.filter((token) => !STOPWORDS.has(token)))].sort().slice(0, TITLE_TOKENS)
}

// Each line trimmed and its whitespace collapsed; blank lines dropped.
export function normalizeCode(code: string): string {
  return code
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("\n")
}

const encoder = new TextEncoder()

// FNV-1a over the UTF-8 bytes, 64-bit, as 16 hex characters. The 64-bit product is computed on two 32-bit
// halves so it stays fast and exact without BigInt: the prime is 2^40 + 0x1b3.
export function fnv1a64(text: string): string {
  let hi = 0xcbf29ce4
  let lo = 0x84222325
  for (const byte of encoder.encode(text)) {
    lo = (lo ^ byte) >>> 0
    const low = lo * 0x1b3
    const carry = Math.floor(low / 0x1_0000_0000)
    hi = (Math.imul(hi, 0x1b3) + (lo << 8) + carry) >>> 0
    lo = low >>> 0
  }
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0")
}

// The id: 12 hex characters over the path, the category, the normalized title tokens and the normalized
// anchored code. Line numbers are not part of it, so a finding keeps its id when lines above it shift.
export function fingerprint(path: string, category: Category, title: readonly string[], code: string): string {
  return fnv1a64([path, category, title.join(" "), code].join("\n")).slice(0, 12)
}

// Token Jaccard. Takes raw titles or already-normalized token lists (such as a finding marker's `t=` words).
export function titleSimilarity(a: string | readonly string[], b: string | readonly string[]): number {
  const left = new Set(typeof a === "string" ? normalizeTitle(a) : a)
  const right = new Set(typeof b === "string" ? normalizeTitle(b) : b)
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared++
  return shared / (left.size + right.size - shared)
}
