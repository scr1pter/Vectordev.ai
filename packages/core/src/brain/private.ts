export * as BrainPrivate from "./private"

import { BrainScan } from "./scan"

// What makes a line of memory private-shaped, for the two places memory meets the outside: the outward screen, which
// decides which of the owner's lines may reach a role whose output leaves the machine (section 6.4a), and the posting
// check, which compares what Vector posts with what it knows about the owner. Both read text the same way, so a line
// written in other letters, entities, percent-encoding or base64 reads as the words it spells.

/** A token that names something particular, by its shape. */
export type Kind = "email" | "host" | "number" | "identifier" | "path"

export type Token = { readonly kind: Kind; readonly value: string }

/** The kinds the posting check compares how-you-work lines by: shapes that point at a person, a place or a record. */
export const SHAPED: readonly Kind[] = ["email", "host", "number"]
/** Every kind: what private facts are compared by. */
export const RARE: readonly Kind[] = ["email", "host", "number", "identifier", "path"]

// Top-level domains common enough that `a.b` ending in one is a host name rather than `Effect.fn` or `package.json`.
const TLD = new Set(
  "com net org io dev ai app co cloud info biz me us uk de fr nl se no fi dk es it pl ch at be ca au nz jp cn in br ru eu tv xyz site tech online internal local lan corp intra home test example localhost".split(
    " ",
  ),
)

// Letters that render like Latin ones: Cyrillic and Greek lookalikes, folded to the Latin letter they imitate. NFKC
// already folds fullwidth and compatibility forms.
const CONFUSABLE: Record<string, string> = {
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x",
  ѕ: "s", і: "i", ї: "i", ј: "j", ԁ: "d", ӏ: "l", ɡ: "g", һ: "h", ԛ: "q", ԝ: "w", ү: "y",
  α: "a", β: "b", ε: "e", η: "n", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ω: "w", ϲ: "c",
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", У: "Y", Ѕ: "S", І: "I",
  Ј: "J", Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y",
  Χ: "X",
}
const CONFUSABLES = new RegExp(`[${Object.keys(CONFUSABLE).join("")}]`, "g")

const NAMED_ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", sol: "/", colon: ":", period: "." }

/**
 * The text as a reader sees it, with what it hides spelled out: HTML entities and percent-encoding decoded, runs of
 * base64 or hex of 24 or more characters decoded and added after it, Unicode folded (NFKC), hidden characters
 * removed and lookalike letters replaced by the Latin ones. Case and punctuation are kept, for `tokens`.
 */
export function reveal(text: string) {
  const entities = text
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_, hex: string) => fromCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d{1,7});?/g, (_, digits: string) => fromCode(Number(digits)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITY[name.toLowerCase()] ?? match)
  const percent = entities.replace(/(?:%[0-9a-f]{2})+/gi, (run) =>
    new TextDecoder().decode(Uint8Array.from(run.slice(1).split("%"), (pair) => Number.parseInt(pair, 16))),
  )
  const decoded = [
    ...[...percent.matchAll(/[A-Za-z0-9+/_-]{24,}={0,2}/g)].map((match) =>
      readable(Buffer.from(match[0].replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8")),
    ),
    ...[...percent.matchAll(/\b(?:[0-9a-f]{2}){12,}\b/gi)].map((match) => readable(Buffer.from(match[0], "hex").toString("utf8"))),
  ].filter(Boolean)
  return BrainScan.stripHidden([percent, ...decoded].join(" ").normalize("NFKC")).replace(
    CONFUSABLES,
    (char) => CONFUSABLE[char] ?? char,
  )
}

/** The words of a text, lowercased, with Markdown, code fences and punctuation gone: what runs of words compare. */
export function words(text: string) {
  return (reveal(text).toLowerCase().replace(/[*_~`\\]/g, "").match(/[\p{L}\p{N}]+/gu) ?? []) as string[]
}

/** The private-shaped tokens in a text, of the kinds asked for, lowercased. */
export function tokens(text: string, kinds: readonly Kind[] = RARE): Token[] {
  const shown = reveal(text)
  const emails = [...shown.matchAll(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu)]
  const urls = [...shown.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^\s/?#)\]>"'`]+)[^\s)\]>"'`]*/gi)]
  // An address is read once, as what it is: the rest of the text is looked at without it, so `pay.acme-internal.com`
  // is a host and not also the name `pay.acme`.
  const rest = [...emails, ...urls].reduce((out, match) => out.replace(match[0], " "), shown)
  const hosts = [...rest.matchAll(/(?<![\w@.-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}]{2,}\b(?![.-]\w)/gu)].filter(
    (match) => TLD.has(match[0].split(".").at(-1)!.toLowerCase()),
  )
  const names = hosts.reduce((out, match) => out.replace(match[0], " "), rest)
  const found: Token[] = [
    ...emails.map((match) => ({ kind: "email" as const, value: match[0] })),
    ...urls.map((match) => ({ kind: "host" as const, value: match[1]!.replace(/^[^@]*@/, "").replace(/:\d+$/, "") })),
    ...hosts.map((match) => ({ kind: "host" as const, value: match[0] })),
    ...[...names.matchAll(/(?<![\w.])\d{5,}(?!\w|\.\d)/g)].map((match) => ({ kind: "number" as const, value: match[0] })),
    ...[...names.matchAll(/(?:[\w.-]+\/)+[\w.-]+/g)].flatMap((match) =>
      /[A-Za-z]/.test(match[0]) ? [{ kind: "path" as const, value: match[0] }] : [],
    ),
    ...[...names.matchAll(/\b[A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)+|\b[\w$]+\b/g)].flatMap((match) =>
      identifier(match[0]) ? [{ kind: "identifier" as const, value: match[0] }] : [],
    ),
  ]
  const unique = new Map(
    found
      .filter((token) => kinds.includes(token.kind))
      .map((token) => {
        const value = token.value.toLowerCase().replace(/[.,;:]+$/, "")
        return [`${token.kind}\0${value}`, { kind: token.kind, value }] as const
      }),
  )
  return [...unique.values()]
}

/**
 * The outward screen (section 6.4a): whether a how-you-work line may reach a role whose output leaves the machine or
 * reaches the web. A decision or lesson passes only with nothing particular in it: no rare token, email, URL or host
 * name, no currency amount and no number of 3 or more digits, since "we drop Acme in Q3" is a decision too. A
 * preference or a rule passes the secret check only.
 */
export function screened(line: { readonly kind: string; readonly text: string; readonly private?: boolean }) {
  if (line.private) return false
  if (BrainScan.credential(line.text) || BrainScan.redact(line.text, {}).redacted) return false
  if (line.kind !== "decision" && line.kind !== "lesson") return true
  const shown = reveal(line.text)
  return (
    tokens(line.text).length === 0 &&
    !/\d{3,}/.test(shown) &&
    !/[$€£¥₹]\s?\d|\d\s?(?:usd|eur|gbp|dollars?|euros?|pounds?)\b|\b(?:usd|eur|gbp)\s?\d/i.test(shown)
  )
}

// camelCase, PascalCase with a second word, snake_case, a dotted or :: name, or letters and digits mixed in three or
// more characters: names, not words.
function identifier(value: string) {
  if (/(?:\.|::)/.test(value)) return /[A-Za-z]/.test(value) && !TLD.has(value.split(".").at(-1)!.toLowerCase())
  if (value.length < 3) return false
  return (
    /[a-z][A-Z]/.test(value) ||
    /^[A-Z][a-z0-9]+[A-Z]/.test(value) ||
    (/_/.test(value) && /[A-Za-z]/.test(value.replaceAll("_", ""))) ||
    (/\d/.test(value) && /[A-Za-z]/.test(value))
  )
}

// Decoded bytes count only when they read as text: most characters printable and at least one word in them.
function readable(text: string) {
  const printable = [...text].filter((char) => /[\p{L}\p{N}\p{P}\p{Zs}]/u.test(char)).length
  return text.length > 0 && printable / [...text].length >= 0.9 && /[\p{L}]{3,}/u.test(text) ? text : ""
}

function fromCode(code: number) {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ""
}
