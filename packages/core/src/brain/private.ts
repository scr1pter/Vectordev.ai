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

/**
 * The kinds the outward screen reads closely, since they often carry a private detail: "we drop Acme in Q3", and a
 * term's meaning as much ("when I say the falcon deal, I mean Globex's $2.4M Q3 renewal").
 */
export const PARTICULAR: readonly string[] = ["decision", "lesson", "failure", "term"]

// Top-level domains common enough that `a.b` ending in one is a host name rather than `Effect.fn` or `package.json`.
const TLD = new Set(
  "com net org io dev ai app co cloud info biz me us uk de fr nl se no fi dk es it pl ch at be ca au nz jp cn in br ru eu tv xyz site tech online internal local lan corp intra home test example localhost".split(
    " ",
  ),
)

// Letters that render like Latin ones, each folded to the Latin letter it imitates: Cyrillic, Greek, Armenian,
// Cherokee, Coptic, Canadian syllabics, Georgian, Hebrew, Arabic, NKo, Tifinagh, and Latin's own small capitals, IPA
// and dotless letters. NFKD has folded fullwidth, mathematical and other compatibility forms by then, and accents go
// with the other marks. Unicode's full confusables table is not shipped with Vector, so a rarer lookalike still reads
// as itself.
const CONFUSABLE = new Map(
  [
    "аa ɑa αa ⍺a ᴀa ʙb Ьb ьb ƅb Ꮟb сc ϲc ᴄc ⲥc ꮯc 𐐽c ԁd ᑯd ᴅd еe ҽe ℮e ꬲe εe ɛe ᥱe ᴇe єe ꬵf ƒf ꜰf",
    "ɡg ցg ƍg ᶃg ɢg һh հh Ꮒh ʜh нh іi ıi ɩi ɪi ιi ꙇi ꭵi Ꭵi јj ϳj ȷj ᴊj кk κk ᴋk ĸk ӏl ǀl ⵏl",
    "ןl וl اl ߊl мm ᴍm ոn пn ռn ɴn ηn оo οo օo σo ᴏo ⲟo ዐo סo هo рp ρp ϱp ⲣp ᴘp",
    "ԛq գq զq гr ᴦr ⲅr ꭇr ꮁr ʀr ѕs ꜱs ƽs ꮪs тt τt ᴛt υu սu ᴜu ʋu ꭎu ꞟu μu νv ѵv ᴠv ꮩv",
    "ԝw ɯw ѡw ᴡw ωw աw ꮃw хx χx ᕁx ᕽx уy үy γy ʏy ყy ꭹy ᴢz ꮓz",
    "АA ΑA ᎪA ᗅA ВB ΒB ᏴB ᗷB СC ϹC ᏟC ⲤC ᎠD ᗪD ЕE ΕE ᎬE ⴹE ᏀG ԌG НH ΗH ᎻH ᕼH ⲎH",
    "ІI ΙI ӀI ЈJ ᎫJ ᒍJ КK ΚK ᏦK ᛕK ⲔK ᏞL ᒪL ⳐL МM ΜM ᎷM ᗰM ⲘM ΝN ⲚN ОO ΟO ՕO ⲞO",
    "РP ΡP ᏢP ᑭP ⲢP ԚQ ᎡR ᏒR ᖇR ЅS ᏚS ՏS ТT ΤT ᎢT ⲦT ՍU ᑌU ᏙV ᐯV ѴV ᎳW ԜW ХX ΧX ⲬX",
    "УY ΥY ҮY ⲨY ΖZ ᏃZ",
  ]
    .join(" ")
    .split(" ")
    .map((pair) => [...pair] as [string, string]),
)
const CONFUSABLES = new RegExp(`[${[...CONFUSABLE.keys()].join("")}]`, "gu")

const NAMED_ENTITY: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  sol: "/",
  bsol: "\\",
  colon: ":",
  period: ".",
  commat: "@",
  num: "#",
  quest: "?",
  equals: "=",
  percnt: "%",
  lpar: "(",
  rpar: ")",
  lsqb: "[",
  rsqb: "]",
  lbrack: "[",
  rbrack: "]",
  excl: "!",
  comma: ",",
  semi: ";",
  tab: "\t",
  newline: "\n",
}

/** Decodes HTML entities, as GitHub does in text, link destinations and attribute values. */
export function entities(text: string) {
  return text
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_, hex: string) => fromCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d{1,7});?/g, (_, digits: string) => fromCode(Number(digits)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITY[name.toLowerCase()] ?? match)
}

/**
 * The text as a reader sees it, with what it hides spelled out: HTML entities and percent-encoding decoded, runs of
 * base64 or hex of 24 or more characters decoded (at every alignment and in every path segment) and added after it,
 * Unicode folded, hidden characters removed and lookalike letters replaced by the Latin ones. Case and punctuation are
 * kept, for `tokens`.
 */
export function reveal(text: string) {
  const percent = entities(text).replace(/(?:%[0-9a-f]{2})+/gi, (run) =>
    new TextDecoder().decode(Uint8Array.from(run.slice(1).split("%"), (pair) => Number.parseInt(pair, 16))),
  )
  // A run inside a URL starts wherever the punctuation before it ends, so `net/a/<base64>` is read from each slash and
  // at each of the four alignments a base64 run can have.
  const runs = [...percent.matchAll(/[A-Za-z0-9+/_-]{24,}={0,2}/g)]
    .flatMap((match) => [match[0], ...match[0].split("/")])
    .filter((run, index, all) => run.length >= 24 && all.indexOf(run) === index)
  const decoded = [
    ...runs.flatMap((run) =>
      [0, 1, 2, 3].map((skip) =>
        readable(Buffer.from(run.slice(skip).replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8")),
      ),
    ),
    ...[...percent.matchAll(/(?<![0-9a-z])(?:0x)?([0-9a-f]{24,})(?![0-9a-z])/gi)].flatMap((match) =>
      [0, 1].map((skip) => readable(Buffer.from(match[1]!.slice(skip), "hex").toString("utf8"))),
    ),
  ].filter(Boolean)
  return fold([percent, ...new Set(decoded)].join(" "))
}

/** The words of a text, lowercased, with Markdown, code fences and punctuation gone: what runs of words compare. */
export function words(text: string) {
  return (reveal(text).toLowerCase().replace(/[*_~`\\]/g, "").match(/[\p{L}\p{N}]+/gu) ?? []) as string[]
}

/**
 * The text as GitHub shows it, at the same length: HTML tags and comments, link and image destinations, reference
 * definitions and footnote marks are blanked with zero-width spaces, which `words` drops. So a tag between letters, a
 * comment between words or a link around each word no longer splits what a reader sees. What they carry is still in
 * the text itself, which the posting check reads too.
 */
export function rendered(text: string) {
  return [
    /<!--[\s\S]*?(?:-->|$)/g,
    /<\/?[a-z][^<>]*>|<[!?][^<>]*>/gi,
    /^[ \t]{0,3}\[[^\]\n]+\]:.*$/gm,
    /\]\((?:[^()\n]|\([^()\n]*\))*\)/g,
    /\]\[[^\]\n]*\]/g,
    /\[\^[^\]\n]*\]/g,
  ].reduce((out, pattern) => out.replace(pattern, (match) => "​".repeat(match.length)), text)
}

/** The private-shaped tokens in a text, of the kinds asked for, lowercased. */
export function tokens(text: string, kinds: readonly Kind[] = RARE): Token[] {
  const shown = reveal(text)
  const emails = [...shown.matchAll(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu)]
  const urls = [...shown.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^\s/?#)\]>"'`]+)[^\s)\]>"'`]*/gi)]
  // An address is read once, as what it is: the rest of the text is looked at without it, so `pay.acme-internal.com`
  // is a host and not also the name `pay.acme`.
  const rest = [...emails, ...urls].reduce((out, match) => out.replace(match[0], " "), shown)
  const hosts = [
    ...[...rest.matchAll(/(?<![\w@.-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}]{2,}\b(?![.-]\w)/gu)]
      .map((match) => match[0])
      .filter((host) => TLD.has(host.split(".").at(-1)!.toLowerCase())),
    // A machine's address names it as much as its host name does.
    ...[...rest.matchAll(/(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?![\w]|\.\d)/g)].map((match) => match[0]),
    ...[...rest.matchAll(/(?<![\w:.])[0-9a-f]*(?::[0-9a-f]*){2,8}(?![\w:.])/gi)].map((match) => match[0]).filter(ipv6),
  ]
  const names = hosts.reduce((out, host) => out.replace(host, " "), rest)
  const found: Token[] = [
    ...emails.map((match) => ({ kind: "email" as const, value: match[0] })),
    ...urls.map((match) => ({ kind: "host" as const, value: match[1]!.replace(/^[^@]*@/, "").replace(/:\d+$/, "") })),
    ...hosts.map((value) => ({ kind: "host" as const, value })),
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
 * reaches the web. A decision, lesson, past failure or term passes only with nothing particular in it: no rare token,
 * email, URL, host name or machine address, no currency amount, no number of 3 or more digits, no quarter, month or
 * year, and no name (a capitalised word inside a sentence), since "we drop Acme in Q3" is a decision too. A preference
 * or a rule passes the secret check only.
 */
export function screened(line: { readonly kind: string; readonly text: string; readonly private?: boolean }) {
  if (line.private) return false
  if (BrainScan.credential(line.text) || BrainScan.redact(line.text, {}).redacted) return false
  if (!PARTICULAR.includes(line.kind)) return true
  const shown = reveal(line.text)
  return (
    tokens(line.text).length === 0 &&
    !/\d{3,}/.test(shown) &&
    !/[$€£¥₹]\s?\d|\d\s?(?:usd|eur|gbp|dollars?|euros?|pounds?)\b|\b(?:usd|eur|gbp)\s?\d/i.test(shown) &&
    !/\bq[1-4]\b|\b(?:january|february|march|april|june|july|august|september|october|november|december)\b/i.test(shown) &&
    !/\b(?:H[12]|FY\s?\d{2,4})\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.?\s+\d/.test(shown) &&
    !named(shown)
  )
}

// IPv6, in full or shortened with one `::`; never a time such as 10:30:45.
function ipv6(value: string) {
  const groups = value.split(":")
  const shortened = (value.match(/::/g) ?? []).length
  return (
    shortened <= 1 &&
    !value.includes(":::") &&
    groups.every((group) => group.length <= 4) &&
    /[0-9a-f]/i.test(value) &&
    (shortened === 1 || groups.length === 8)
  )
}

// Capitalised words that name nothing in particular: the pronoun, and abbreviations engineers write in any repository.
const GENERIC = new Set(
  "I I'm I'd I've I'll OK CI CD PR API JSON YAML TOML SQL HTTP HTTPS URL URI UI UX CLI SDK CSS HTML JS TS JSX TSX IDE OS DB ID TODO FIXME README LGTM AI LLM MCP PDF CSV UTF ASCII REST RPC DNS TLS SSH SSL JWT OAuth E2E".split(
    " ",
  ),
)

// A capitalised word inside a sentence names something: a company, a person, a product or a place.
function named(text: string) {
  return text.split(/(?<=[.!?:;])\s+|\n+/).some((sentence) =>
    sentence
      .replace(/^[\s\p{P}\p{S}\d]+/u, "")
      .split(/\s+/)
      .slice(1)
      .some((word) => {
        const bare = word.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "").replaceAll("’", "'")
        return /^\p{Lu}/u.test(bare) && !GENERIC.has(bare) && !GENERIC.has(bare.replace(/s$/, ""))
      }),
  )
}

// Unicode folded to what it shows: compatibility forms and accents gone (NFKD, then every combining mark dropped),
// characters that show nothing removed (default-ignorable code points, which include the Hangul fillers and variation
// selectors), and lookalike letters replaced by the Latin ones. Cherokee's small letters are its capitals' lookalikes.
function fold(text: string) {
  return BrainScan.stripHidden(text.normalize("NFKD").replace(/[\p{M}\p{Default_Ignorable_Code_Point}]/gu, ""))
    .normalize("NFKC")
    .replace(/[ꭰ-ꮿᏸ-ᏽ]/g, (char) => char.toUpperCase())
    .replace(CONFUSABLES, (char) => CONFUSABLE.get(char) ?? char)
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
