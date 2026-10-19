export * as BrainDrift from "./drift"

import { createHash } from "node:crypto"
import { BrainExtract } from "./extract"
import { BrainLexical } from "./lexical"

// Whether the code a document is linked to still says what it said when it was linked. A link keeps the hash of its
// file and of its line: a line found elsewhere moved and is still fresh, a definition that is still there but reads
// differently drifted, and one that is gone is missing. For a constant the value is checked too, with a small evaluator
// that accepts plain arithmetic and nothing else, so "spec says 50 MB; code says 64 MB" is something Vector can say.

/** Tokens of an expression the evaluator reads; anything longer is not a constant worth checking. */
export const TOKENS = 64

/** Values that differ by more than this share of the larger one disagree. */
export const TOLERANCE = 0.01

/**
 * A numeric literal expression's value: numbers (`64`, `1_024`, `0.5`, `1e6`), `+ - * / ( )` and nothing else, at most
 * `TOKENS` tokens. Anything else (a name, a call, a string) is `undefined`, which means the value is not checked.
 */
export function evaluate(expression: string): number | undefined {
  const tokens = expression.match(/\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?|\.\d+|[-+*/()]|\S/gi) ?? []
  if (tokens.length === 0 || tokens.length > TOKENS) return undefined
  if (tokens.some((token) => !/^(?:\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?|\.\d+|[-+*/()])$/i.test(token))) return undefined
  const state = { at: 0 }
  const peek = () => tokens[state.at]
  const take = () => tokens[state.at++]
  const primary = (): number | undefined => {
    const token = take()
    if (token === undefined) return undefined
    if (token === "-") {
      const inner = primary()
      return inner === undefined ? undefined : -inner
    }
    if (token === "+") return primary()
    if (token === "(") {
      const inner = sum()
      return take() === ")" ? inner : undefined
    }
    const number = Number(token.replaceAll("_", ""))
    return Number.isFinite(number) ? number : undefined
  }
  const product = (): number | undefined => {
    let left = primary()
    while (left !== undefined && (peek() === "*" || peek() === "/")) {
      const operator = take()
      const right = primary()
      if (right === undefined || (operator === "/" && right === 0)) return undefined
      left = operator === "*" ? left * right : left / right
    }
    return left
  }
  const sum = (): number | undefined => {
    let left = product()
    while (left !== undefined && (peek() === "+" || peek() === "-")) {
      const operator = take()
      const right = product()
      if (right === undefined) return undefined
      left = operator === "+" ? left + right : left - right
    }
    return left
  }
  const result = sum()
  return state.at === tokens.length && result !== undefined && Number.isFinite(result) ? result : undefined
}

/**
 * The unit a constant is in, from its name (`MAX_UPLOAD_BYTES`, `uploadLimitMb`, `TIMEOUT_MS`, `ttlSeconds`) or a
 * trailing comment (`// 64 MB`, `# seconds`), as a unit `normalize` knows. Without one there is nothing to compare.
 */
export function unit(identifier: string, comment?: string) {
  const words = BrainLexical.splitIdentifier(identifier).map((word) => word.toLowerCase())
  const last = words.at(-1)
  const named = (() => {
    if (words.includes("kb") || words.includes("kib")) return "KB"
    if (words.includes("mb") || words.includes("mib")) return "MB"
    if (words.includes("gb") || words.includes("gib")) return "GB"
    if (words.some((word) => word === "ms" || word === "millis" || word === "milliseconds")) return "ms"
    // `min` alone is as often a minimum (PASSWORD_MIN, RETRY_DELAY_MIN) as minutes, so only a comment can say minutes.
    if (words.some((word) => word === "minutes" || word === "minute" || word === "mins")) return "min"
    if (words.some((word) => word === "hours" || word === "hour" || word === "hrs")) return "h"
    if (words.some((word) => word === "days" || word === "day")) return "d"
    if (
      words.some((word) => word === "sec" || word === "secs" || word === "seconds" || word === "second") ||
      last === "s"
    )
      return "s"
    if (words.some((word) => word === "bytes" || word === "byte" || word === "size") || last === "b") return "B"
    return undefined
  })()
  if (named) return named
  // A comment's unit is the one next to the value, the comment's first word: `30 // seconds`, `30 // in seconds`, never
  // one further on (`5 // then wait 30 seconds`).
  const said = comment
    ?.trim()
    .match(/^(?:in\s+)?(ms|milliseconds?|secs?|seconds?|s|mins?|minutes?|h|hours?|days?|KiB|MiB|GiB|KB|MB|GB|bytes?|B)\b/)?.[1]
  if (!said) return undefined
  return SAID.find(([pattern]) => pattern.test(said))?.[1] ?? said
}

// A unit as a comment writes it, in the short form the name rules give.
const SAID: readonly (readonly [RegExp, string])[] = [
  [/^(?:ms|milliseconds?)$/, "ms"],
  [/^(?:s|secs?|seconds?)$/, "s"],
  [/^(?:mins?|minutes?)$/, "min"],
  [/^(?:h|hours?)$/, "h"],
  [/^days?$/, "d"],
  [/^(?:B|bytes?)$/, "B"],
  [/^(?:KB|KiB)$/, "KB"],
  [/^(?:MB|MiB)$/, "MB"],
  [/^(?:GB|GiB)$/, "GB"],
]

/** A value in its base unit (bytes, seconds, a rate), or `undefined` for a unit with no base to compare in. */
export function normalize(value: number, unit: string) {
  const normalized = BrainExtract.normalize(value, unit)
  if (normalized.base === "count" || normalized.base === "%") return undefined
  return { value: normalized.value, base: normalized.base }
}

/** Whether two values in the same base unit disagree. */
export function differs(a: number, b: number) {
  const scale = Math.max(Math.abs(a), Math.abs(b))
  return scale > 0 && Math.abs(a - b) / scale > TOLERANCE
}

/** A base value in the unit a document gave (`67108864` bytes in "MB" is "64 MB"). */
export function format(base: number, unit: string) {
  const per = BrainExtract.normalize(1, unit).value
  const value = base / per
  const shown = Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)))
  return `${shown} ${unit}`
}

export function hash(text: string) {
  return createHash("sha256").update(text).digest("hex")
}

/** A line's hash as a link keeps it: trimmed, so indenting it again changes nothing. */
export function lineHash(line: string) {
  return hash(line.trim())
}

/** Characters of a line a link can point at: a longer one (minified or generated code) is never looked at. */
export const LINE = 4_096

/**
 * Where a link's line is in a file's new text, and whether it still says the same: `fresh` at the line its hash is
 * found on (the nearest one, for a line found twice), `drifted` where the name is still defined (or, for a use, still
 * used) on a changed line, `missing` once it is gone.
 */
export function recheck(
  anchor: { readonly line?: number; readonly lineHash?: string; readonly symbol?: string; readonly method: string },
  content: string,
  matches: (line: string) => boolean,
): { readonly status: "fresh" | "drifted" | "missing"; readonly line?: number } {
  const lines = content.split("\n")
  const before = anchor.line ?? 1
  const nearest = (indexes: readonly number[]) =>
    indexes.toSorted((a, b) => Math.abs(a + 1 - before) - Math.abs(b + 1 - before))[0]
  if (anchor.lineHash) {
    const same = nearest(lines.flatMap((line, index) => (lineHash(line) === anchor.lineHash ? [index] : [])))
    if (same !== undefined) return { status: "fresh", line: same + 1 }
  }
  // A link to a file and nothing in it holds while the file is there.
  if (anchor.method === "path" || !anchor.symbol) return { status: "fresh" }
  const still = nearest(lines.flatMap((line, index) => (line.length <= LINE && matches(line) ? [index] : [])))
  if (still === undefined) return { status: "missing" }
  // A name only used still means what it did wherever it is used; a definition that reads differently may not.
  return { status: anchor.method === "use" ? "fresh" : "drifted", line: still + 1 }
}
