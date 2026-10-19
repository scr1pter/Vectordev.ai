export * as BrainConflict from "./conflict"

import { BrainDrift } from "./drift"
import { BrainLexical } from "./lexical"
import type { BrainSchema } from "./schema"

// Where two things Vector holds disagree: a document and another document, a document and a rule, or a document and
// memory. The same subject with a different value, an opposite modality ("must" against "must not"), the opposite way
// round ("deploys run from main" against "deploys do not run from main"), or another method or status for the same
// endpoint. Nothing here decides who is right: each disagreement becomes an item for the user, and the order of
// authority (a rule, then the user, then the newer document) only says which side Vector would suggest.

export type Source = "rule" | "user" | "document" | "repository" | "learned" | "distilled"

export type Type = "value" | "modality" | "polarity" | "endpoint"

/** One statement, as the check compares it. */
export type Claim = {
  readonly id: string
  readonly source: Source
  /** When it was written: a document's date, or an entry's. */
  readonly at: number
  /** A record's key (kind and subject), which a record of another document saying the same thing shares. */
  readonly key?: string
  readonly text: string
  /** Its words, without the value it gives. */
  readonly terms: ReadonlyMap<string, number>
  readonly polarity: string
  readonly value?: { readonly value: number; readonly unit: string; readonly normalized: number; readonly base: string }
  readonly modality?: "must" | "must-not" | "should" | "should-not" | "may"
  readonly endpoint?: { readonly method?: string; readonly route: string; readonly status: readonly number[] }
}

export type Found = {
  readonly type: Type
  readonly a: string
  readonly b: string
  /** The side the order of authority favours. */
  readonly prefer: string
  /** What each side says, in a few words: "50 MB" and "64 MB", "must" and "must-not". */
  readonly said: { readonly a: string; readonly b: string }
}

/** Two subjects are the same when they share this much of their words. */
const SAME = 0.5
/** Modality and polarity need more, since only one word tells them apart. */
const CLOSE = 0.6

const ORDER: Readonly<Record<Source, number>> = {
  rule: 6,
  user: 5,
  document: 4,
  repository: 3,
  learned: 2,
  distilled: 1,
}

const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`
const UNIT = String.raw`(ms|milliseconds?|secs?|seconds?|s|mins?|minutes?|hrs?|hours?|h|days?|d|weeks?|KiB|MiB|GiB|KB|MB|GB|kB|bytes?)`
const VALUE = new RegExp(String.raw`(?<![\w.])${NUMBER}\s?-?${UNIT}(?![\w/])`, "i")
const STATUS = /\b([2-5]\d\d)\b/g
const MODAL: readonly (readonly [RegExp, NonNullable<Claim["modality"]>])[] = [
  [
    /\b(?:must not|shall not|may not|must never|cannot|can't|never|do not|don't|is not allowed|are not allowed|forbidden|prohibited)\b/i,
    "must-not",
  ],
  [/\b(?:should not|shouldn't|not recommended)\b/i, "should-not"],
  [/\b(?:must|shall|always|required|is required to|are required to|has to|have to)\b/i, "must"],
  [/\b(?:should|recommended)\b/i, "should"],
  [/\b(?:may|optional|can)\b/i, "may"],
]

/** A claim from a stored record. */
export function fromRecord(input: {
  readonly id: string
  readonly source: Source
  readonly at: number
  readonly key: string
  readonly kind: BrainSchema.RecordKind
  readonly quote: string
  readonly fields: Readonly<Record<string, unknown>>
}): Claim {
  const fields = input.fields
  const numeric =
    typeof fields.value === "number" &&
    typeof fields.unit === "string" &&
    typeof fields.normalized === "number" &&
    typeof fields.base === "string" &&
    fields.base !== "count"
      ? { value: fields.value, unit: fields.unit, normalized: fields.normalized, base: fields.base }
      : undefined
  const modality =
    typeof fields.modality === "string" && ["must", "must-not", "should", "should-not", "may"].includes(fields.modality)
      ? (fields.modality as Claim["modality"])
      : undefined
  const endpoint =
    fields.form === "endpoint" && typeof fields.route === "string"
      ? {
          ...(typeof fields.method === "string" ? { method: fields.method.toUpperCase() } : {}),
          route: fields.route,
          status: [...new Set([...input.quote.matchAll(STATUS)].map((match) => Number(match[1])))],
        }
      : undefined
  return {
    id: input.id,
    source: input.source,
    at: input.at,
    key: input.key,
    text: input.quote,
    terms: wordsOf(input.quote, endpoint?.method),
    polarity: BrainLexical.polarity(input.quote),
    ...(numeric ? { value: numeric } : {}),
    ...(modality ? { modality } : {}),
    ...(endpoint ? { endpoint } : {}),
  }
}

/** A claim from a memory entry or a rule: its value, modality and way round, read from its words. */
export function fromText(input: {
  readonly id: string
  readonly source: Source
  readonly at: number
  readonly text: string
}): Claim {
  const match = VALUE.exec(input.text)
  const number = match ? Number(match[1]!.replace(/,/g, "")) : undefined
  const normalized = match && number !== undefined ? BrainDrift.normalize(number, match[2]!) : undefined
  const modality = MODAL.find(([pattern]) => pattern.test(input.text))?.[1]
  return {
    id: input.id,
    source: input.source,
    at: input.at,
    text: input.text,
    terms: wordsOf(input.text),
    polarity: BrainLexical.polarity(input.text),
    ...(match && number !== undefined && normalized
      ? { value: { value: number, unit: match[2]!, normalized: normalized.value, base: normalized.base } }
      : {}),
    ...(modality ? { modality } : {}),
  }
}

/** How two claims disagree, if they do. Claims that say the same thing, or speak of different subjects, do not. */
export function compare(a: Claim, b: Claim): Found | undefined {
  if (a.id === b.id) return undefined
  const similarity = BrainLexical.similarity(a.terms, b.terms)
  const keyed = a.key !== undefined && a.key === b.key
  const found = (type: Type, said: { a: string; b: string }): Found => ({
    type,
    a: a.id,
    b: b.id,
    prefer: prefer(a, b),
    said,
  })
  if (a.endpoint && b.endpoint && a.endpoint.route === b.endpoint.route) {
    const methods = a.endpoint.method && b.endpoint.method
    if (methods && a.endpoint.method !== b.endpoint.method && similarity >= SAME)
      return found("endpoint", {
        a: `${a.endpoint.method} ${a.endpoint.route}`,
        b: `${b.endpoint.method} ${b.endpoint.route}`,
      })
    const statuses = a.endpoint.status.length > 0 && b.endpoint.status.length > 0
    if (
      (!methods || a.endpoint.method === b.endpoint.method) &&
      statuses &&
      !a.endpoint.status.some((status) => b.endpoint!.status.includes(status))
    )
      return found("endpoint", { a: a.endpoint.status.join(", "), b: b.endpoint.status.join(", ") })
    return undefined
  }
  if (!keyed && similarity < SAME) return undefined
  if (a.value && b.value && a.value.base === b.value.base && BrainDrift.differs(a.value.normalized, b.value.normalized))
    return found("value", { a: `${a.value.value} ${a.value.unit}`, b: `${b.value.value} ${b.value.unit}` })
  if (!keyed && similarity < CLOSE) return undefined
  const forbids = (claim: Claim) => claim.modality === "must-not" || claim.modality === "should-not"
  if (a.modality && b.modality && forbids(a) !== forbids(b)) return found("modality", { a: a.modality, b: b.modality })
  // Only a "not" tells these apart: the same words, the other way round.
  const negated = (claim: Claim) => claim.polarity.split(" ").some((turn) => turn.startsWith("not:"))
  if (a.polarity !== b.polarity && negated(a) !== negated(b))
    return found("polarity", { a: negated(a) ? "not" : "so", b: negated(b) ? "not" : "so" })
  return undefined
}

/** Which of two sides the order of authority favours: a rule, then the user, then the newer document, and so on. */
export function prefer(a: Claim, b: Claim) {
  const rank = ORDER[a.source] - ORDER[b.source]
  if (rank !== 0) return rank > 0 ? a.id : b.id
  return a.at >= b.at ? a.id : b.id
}

// A statement's words for comparing subjects: without the value it gives, its unit and the method it names, so "at
// most 50 MB" and "at most 64 MB" are the same subject.
function wordsOf(text: string, method?: string) {
  const plain = text
    .replace(new RegExp(VALUE.source, "gi"), " ")
    .replace(/\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g, " ")
    .replace(/\b[2-5]\d\d\b/g, " ")
  const words = BrainLexical.terms(plain)
  if (method) words.delete(method.toLowerCase())
  return words
}
