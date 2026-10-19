export * as BrainExtract from "./extract"

import type { BrainLimits } from "./document/limits"
import type { BrainDocument } from "./document/read"
import { BrainLexical } from "./lexical"
import { BrainScan } from "./scan"
import type { BrainSchema } from "./schema"
import { BrainStructure } from "./structure"

// Typed records from a structured document, by fixed rules only: no model reads a document to decide what it says.
// Each rule has a name stored with its records, and ships only once it is precise (≥ 0.85) on its fixtures. A record
// quotes its source exactly and builds its card from that source with no paraphrase. Its id comes from the repository,
// the document's lineage, its kind and its subject, never from where it sits, so a reworded or reordered version of a
// document keeps the ids (and the pins, edits and credit on them) of everything it still says.

export const RULES = [
  "rfc2119",
  "requirement-id",
  "lowercase-modal",
  "user-story",
  "gherkin",
  "requirement-table",
  "constraint",
  "adr",
  "decision-prose",
  "decision-label",
  "openapi-path",
  "http-route",
  "graphql",
  "grpc",
  "env",
  "cli",
  "config-key",
  "function",
  "error-code",
  "procedure-heading",
  "procedure-imperative",
  "glossary-table",
  "glossary-entry",
  "definition-prose",
  "acronym",
  "create-table",
  "named-entity",
  "schema-definition",
  "parameter-table",
  "stated-value",
  "tbd",
  "open-question",
  "heading-question",
] as const
export type Rule = (typeof RULES)[number]

export type Record = {
  /** "r" and 6 base32 characters of the hash of the repository, the lineage and the key. */
  readonly id: string
  /** kind "|" subject, with "#2" and on for a second record of the same subject in one document. */
  readonly key: string
  readonly kind: BrainSchema.RecordKind
  readonly subject: string
  readonly card: string
  readonly quote: string
  readonly quoteHash: string
  readonly fields: Readonly<{ [field: string]: unknown }>
  readonly confidence: number
  readonly rule: Rule
  readonly polarity: string
  readonly passage: string
  readonly section: number
  readonly page?: number
  readonly start: number
  readonly end: number
  readonly hold?: BrainDocument.Hold
}

export const CARD = 180
export const QUOTE = 300
/** Longer sentences say too much at once to be one record. */
export const SENTENCE = 400

type Unit = {
  readonly type: "sentence" | "item" | "heading" | "code"
  readonly text: string
  readonly start: number
  readonly end: number
  readonly section: number
  readonly page?: number
  readonly block: number
  /** Code spans in the unit's text. */
  readonly code: readonly string[]
  readonly language?: string
}

type Candidate = {
  readonly kind: BrainSchema.RecordKind
  readonly rule: Rule
  /** The subject phrase, or a canonical name ("env:DATABASE_URL") when `canonical`. */
  readonly subject: string
  readonly canonical?: boolean
  /** What the subject is measured in, part of the key so "timeout 30 s" and "timeout 3 retries" stay apart. */
  readonly attribute?: string
  readonly fields: { readonly [field: string]: unknown }
  readonly confidence: number
  readonly start: number
  readonly end: number
  readonly card?: string
}

type Context = {
  readonly extracted: BrainDocument.Extracted
  readonly structured: BrainStructure.Structured
  readonly paths: readonly string[]
}

export function extract(
  extracted: BrainDocument.Extracted,
  structured: BrainStructure.Structured,
  input: { readonly repository: string; readonly lineage: string; readonly limits: BrainLimits.Limits },
) {
  const context: Context = { extracted, structured, paths: structured.sections.map((section) => section.path) }
  const units = extracted.blocks.flatMap((block, index) =>
    unitsOf(block, index, structured.owners[index] ?? 0, extracted.text),
  )
  const prose = units.filter((unit) => unit.type !== "code" && usable(unit.text))
  const candidates = [
    ...prose.flatMap((unit) => requirement(unit, context)),
    ...prose.flatMap((unit) => constraint(unit)),
    ...prose.flatMap((unit) => decisionProse(unit)),
    ...prose.flatMap((unit) => statedValue(unit)),
    ...prose.flatMap((unit) => question(unit, context)),
    ...prose.flatMap((unit) => definition(unit, context)),
    ...units.flatMap((unit) => contracts(unit, extracted.format)),
    ...extracted.blocks.flatMap((block, index) => tables(block, index, context)),
    ...extracted.blocks.flatMap((block, index) => procedures(block, index, context, units)),
    ...extracted.blocks.flatMap((block, index) => gherkin(block, index, context)),
    ...extracted.blocks.flatMap((block) => interfaces(block, context)),
    ...adr(context, units),
    ...openapi(context),
    ...entities(context, units),
  ]
  return assemble(candidates, context, input)
}

// --- Units ----------------------------------------------------------------------------------------------------------

function unitsOf(block: BrainDocument.Block, index: number, section: number, text: string): Unit[] {
  const base = { section, block: index, ...(block.span.page === undefined ? {} : { page: block.span.page }) }
  if (block.type === "heading")
    return [{ ...base, type: "heading", text: block.text, start: block.span.start, end: block.span.end, code: [] }]
  if (block.type === "paragraph" || block.type === "quote") {
    const code = block.type === "paragraph" ? block.code : []
    return BrainStructure.sentences(text.slice(block.span.start, block.span.end), block.span.start).map((span) => {
      const sentence = text.slice(span.start, span.end)
      return {
        ...base,
        type: "sentence",
        text: sentence,
        ...span,
        code: code.filter((item) => sentence.includes(item)),
      }
    })
  }
  if (block.type === "list")
    return block.items.map((item) => ({
      ...base,
      type: "item",
      text: item.text,
      start: item.span.start,
      end: item.span.end,
      code: [...item.code, ...spans(item.text)],
    }))
  if (block.type === "code")
    return lines(text, block.span.start, block.span.end).map((line) => ({
      ...base,
      type: "code",
      text: text.slice(line.start, line.end),
      ...line,
      code: [],
      ...(block.language ? { language: block.language } : {}),
    }))
  return []
}

// Inline code in text that lost its Markdown: a word in backticks.
function spans(text: string) {
  return [...text.matchAll(/`([^`\n]{1,120})`/g)].map((match) => match[1]!)
}

function lines(text: string, start: number, end: number) {
  const parts = text.slice(start, end).split("\n")
  const offsets = BrainStructure.starts(
    parts.map((part) => part.length),
    start,
  )
  return parts.flatMap((part, index) =>
    part.trim() ? [{ start: offsets[index]!, end: offsets[index]! + part.length }] : [],
  )
}

function rowSpans(block: Extract<BrainDocument.Block, { type: "table" }>) {
  const header = block.header.length > 0 ? block.header.join(" | ").length + 1 : 0
  const lengths = block.rows.map((row) => row.join(" | ").length)
  return BrainStructure.starts(lengths, block.span.start + header).map((start, index) => ({
    start,
    end: start + lengths[index]!,
  }))
}

// Sentences that make no record: too long to be one claim, an example, or one that gave a secret.
function usable(text: string) {
  return (
    text.length <= SENTENCE &&
    !/\b(?:e\.g\.|for example|for instance)/i.test(text) &&
    !text.includes("[redacted]") &&
    !BrainScan.credential(text)
  )
}

// --- Requirements ---------------------------------------------------------------------------------------------------

const KEYWORD =
  /\b(MUST NOT|SHALL NOT|SHOULD NOT|NOT RECOMMENDED|MUST|SHALL|SHOULD|REQUIRED|RECOMMENDED|MAY|OPTIONAL)\b/
const MODALITY: { readonly [word: string]: "must" | "must-not" | "should" | "should-not" | "may" } = {
  "MUST NOT": "must-not",
  "SHALL NOT": "must-not",
  "SHOULD NOT": "should-not",
  "NOT RECOMMENDED": "should-not",
  MUST: "must",
  SHALL: "must",
  REQUIRED: "must",
  SHOULD: "should",
  RECOMMENDED: "should",
  MAY: "may",
  OPTIONAL: "may",
}
const REQUIREMENT_ID = /\b((?:REQ|FR|NFR|AC|US|SR|BR|UR|SYS|SEC)-\d+(?:\.\d+)*)\b/
const REQUIREMENT_SECTION = /requirement|spec|constraint|policy|polic|rule|acceptance|security|compliance/i
const LOWER = /\b(must not|shall not|may not|cannot|must|shall|never|always|is required to|are required to)\b/
const STORY =
  /^as an? ([^,]{2,60}?),?\s+i (?:want|need|would like)(?: to)? (.{3,200}?)(?:,?\s+so that (.{3,200}?))?[.!]?$/i

function requirement(unit: Unit, context: Context): Candidate[] {
  const text = unit.text
  const story = text.match(STORY)
  if (
    story &&
    unit.type !== "heading" &&
    !/^(?:aside|result|example|reminder|alternative|exception|rule|whole|consequence|side note)$/i.test(
      story[1]!.trim(),
    )
  )
    return [
      {
        kind: "requirement",
        rule: "user-story",
        subject: story[2]!,
        fields: {
          modality: "should",
          subject: story[1]!,
          story: { role: story[1]!, want: story[2]!, benefit: story[3] ?? "" },
        },
        confidence: 0.9,
        start: unit.start,
        end: unit.end,
      },
    ]
  const ref = text.match(REQUIREMENT_ID)?.[1]
  const keyword = unit.type === "heading" ? undefined : allCaps(text) ? undefined : text.match(KEYWORD)
  if (keyword || ref) {
    const modality = keyword ? MODALITY[keyword[1]!]! : (lowerModality(text) ?? "must")
    return [
      {
        kind: "requirement",
        rule: keyword ? "rfc2119" : "requirement-id",
        subject: ref ?? text,
        canonical: !!ref,
        fields: { ...(ref ? { ref } : {}), modality, subject: lead(text, keyword?.index) },
        confidence: 0.9,
        start: unit.start,
        end: unit.end,
      },
    ]
  }
  const scope = `${context.extracted.title} > ${context.paths[unit.section] ?? ""}`
  if (unit.type === "heading" || /\?\s*$/.test(text) || !REQUIREMENT_SECTION.test(scope)) return []
  const lower = text.match(LOWER)
  if (!lower) return []
  return [
    {
      kind: "requirement",
      rule: "lowercase-modal",
      subject: text,
      fields: { modality: lowerModality(text)!, subject: lead(text, lower.index) },
      confidence: 0.6,
      start: unit.start,
      end: unit.end,
    },
  ]
}

function lowerModality(text: string) {
  const match = text.match(LOWER)?.[1]
  if (!match) return undefined
  return /not|never|cannot/.test(match) ? ("must-not" as const) : ("must" as const)
}

// The words before the modal keyword: who or what the requirement binds ("The client").
function lead(text: string, index: number | undefined) {
  return text
    .slice(0, index ?? 0)
    .replace(REQUIREMENT_ID, "")
    .replace(/^[\s:.\-–—]+|[\s:.\-–—]+$/g, "")
    .slice(0, 80)
}

// Shouting is not RFC 2119: an all-capitals sentence (a disclaimer, a banner) says MAY without meaning it.
function allCaps(text: string) {
  const letters = text.replace(/[^A-Za-z]/g, "")
  return letters.length > 0 && letters.replace(/[^a-z]/g, "").length < 0.3 * letters.length
}

const GIVEN = /\bGiven\b[\s\S]{1,300}?\b[Ww]hen\b[\s\S]{1,300}?\b[Tt]hen\b\s+([\s\S]{3,200}?)(?:\s+And\b[\s\S]*)?$/

function gherkin(block: BrainDocument.Block, index: number, context: Context): Candidate[] {
  const text =
    block.type === "list"
      ? block.items.map((item) => item.text).join("\n")
      : block.type === "paragraph"
        ? block.text
        : ""
  const match = text.match(GIVEN)
  if (!match || text.length > SENTENCE * 2) return []
  const span = { start: block.span.start, end: block.span.end }
  return [
    {
      kind: "requirement",
      rule: "gherkin",
      subject: match[1]!,
      fields: { modality: "must", subject: match[1]!.replace(/[.\s]+$/, "") },
      confidence: 0.9,
      ...span,
      card: oneLine(context.extracted.text.slice(span.start, span.end)),
    },
  ]
}

// --- Constraints and stated values ----------------------------------------------------------------------------------

const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`
const UNIT = String.raw`(ms|milliseconds?|μs|secs?|seconds?|s|mins?|minutes?|hrs?|hours?|h|days?|d|weeks?|wks?|months?|KiB|MiB|GiB|TiB|KB|MB|GB|TB|kB|bytes?|B|%|percent|(?:req(?:uest)?s?|calls?|messages?)\s*(?:/|per\s+)(?:s|sec|second|min|minute|h|hour)|rps|qps|rpm|chars?|characters?|items?|entries|records|rows|retries|attempts?|times|connections?|requests?|users?|files?|tokens?|pages?|results?|requests)`
const COMPARATORS: readonly (readonly [RegExp, "<=" | ">=" | "=" | "<" | ">"])[] = [
  [
    /^(?:at most|no more than|not more than|up to|a maximum of|maximum of|max(?:imum)?|limit(?:ed)? (?:to|of|at)|limit|capped at|not exceed(?:ing)?|within|≤|<=)$/i,
    "<=",
  ],
  [/^(?:at least|no less than|not less than|no fewer than|a minimum of|minimum of|min(?:imum)?|≥|>=)$/i, ">="],
  [/^(?:less than|fewer than|under|below|shorter than|smaller than|<)$/i, "<"],
  [/^(?:more than|greater than|over|above|exceeding|exceeds|larger than|bigger than|longer than|>)$/i, ">"],
  [
    /^(?:exactly|timeout of|timeout|times out after|time out after|expires? after|expires? in|ttl of|ttl|every|=)$/i,
    "=",
  ],
]
const CONSTRAINT = new RegExp(
  String.raw`\b(at most|no more than|not more than|up to|a maximum of|maximum of|max(?:imum)?|limit(?:ed)? (?:to|of|at)|capped at|not exceed(?:ing)?|within|at least|no less than|not less than|no fewer than|a minimum of|minimum of|min(?:imum)?|less than|fewer than|under|below|shorter than|smaller than|more than|greater than|over|above|exceeding|exceeds|larger than|bigger than|longer than|exactly|timeout of|timeout|times out after|time out after|expires? after|expires? in|ttl of|ttl|every)\s+(?:of\s+|is\s+|to\s+|a\s+|an\s+)?${NUMBER}\s?-?${UNIT}(?![\w/])|(≤|<=|≥|>=|<|>|=)\s*${NUMBER}\s?${UNIT}(?![\w/])`,
  "gi",
)

const BASES: readonly (readonly [RegExp, number, "s" | "B" | "%" | "rate" | "count"])[] = [
  [/^(?:μs)$/, 0.000001, "s"],
  [/^(?:ms|milliseconds?)$/i, 0.001, "s"],
  [/^(?:s|secs?|seconds?)$/i, 1, "s"],
  [/^(?:mins?|minutes?)$/i, 60, "s"],
  [/^(?:h|hrs?|hours?)$/i, 3_600, "s"],
  [/^(?:d|days?)$/i, 86_400, "s"],
  [/^(?:weeks?|wks?)$/i, 604_800, "s"],
  [/^months?$/i, 2_592_000, "s"],
  [/^(?:B|bytes?)$/, 1, "B"],
  [/^(?:KB|KiB|kB)$/, 1_024, "B"],
  [/^(?:MB|MiB)$/, 1_048_576, "B"],
  [/^(?:GB|GiB)$/, 1_073_741_824, "B"],
  [/^(?:TB|TiB)$/, 1_099_511_627_776, "B"],
  [/^(?:%|percent)$/i, 1, "%"],
  [/(?:\/|per\s+)(?:s|sec|second)$|^(?:rps|qps)$/i, 1, "rate"],
  [/(?:\/|per\s+)(?:min|minute)$|^rpm$/i, 1 / 60, "rate"],
  [/(?:\/|per\s+)(?:h|hour)$/i, 1 / 3_600, "rate"],
]

/** A value in its base unit: seconds, bytes, percent, per second, or a plain count. */
export function normalize(value: number, unit: string) {
  const base = BASES.find(([pattern]) => pattern.test(unit.trim()))
  if (!base) return { value, base: "count" as const }
  return { value: Number((value * base[1]).toPrecision(12)), base: base[2] }
}

function constraint(unit: Unit): Candidate[] {
  if (unit.type === "heading") return []
  return [...unit.text.matchAll(CONSTRAINT)].slice(0, 3).flatMap((match): Candidate[] => {
    const word = (match[1] ?? match[4] ?? "").replace(/\s+/g, " ")
    const value = Number((match[2] ?? match[5] ?? "").replace(/,/g, ""))
    const unitText = match[3] ?? match[6] ?? ""
    const comparator = COMPARATORS.find(([pattern]) => pattern.test(word))?.[1] ?? "="
    if (!Number.isFinite(value) || !unitText) return []
    const normalized = normalize(value, unitText)
    const quantity = quantityOf(unit.text, match.index!)
    return [
      {
        kind: "constraint",
        rule: "constraint",
        subject: `${quantity || unit.text.replace(match[0], "")}`,
        attribute: normalized.base,
        fields: { quantity, value, unit: unitText, normalized: normalized.value, base: normalized.base, comparator },
        confidence: 0.85,
        start: unit.start,
        end: unit.end,
      },
    ]
  })
}

// What a number measures: the words before its comparator, without the modal verb and filler.
function quantityOf(text: string, index: number) {
  return text
    .slice(0, index)
    .replace(REQUIREMENT_ID, " ")
    .replace(KEYWORD, " ")
    .replace(
      /\b(?:must|shall|should|may|will|can|could|is|are|be|been|not|never|always|only|the|a|an|to|of|for|after|in|on|at|and|or|have|has|wait|take|allowed|limited|set)\b/gi,
      " ",
    )
    .replace(/[^\p{L}\p{N}_\-/.]+/gu, " ")
    .trim()
    .split(/\s+/)
    .slice(-6)
    .join(" ")
}

const STATED = new RegExp(
  String.raw`^(.{3,80}?)\s+(?:is|are|was|were|equals|averages|stays at|measures|of)\s+(?:about\s+|around\s+|approximately\s+|roughly\s+|~)?${NUMBER}\s?${UNIT}(?![\w/])`,
  "i",
)

const LIMITED = new RegExp(CONSTRAINT.source, "i")

function statedValue(unit: Unit): Candidate[] {
  if (unit.type === "heading" || LIMITED.test(unit.text) || KEYWORD.test(unit.text) || LOWER.test(unit.text)) return []
  const match = unit.text.match(STATED)
  if (!match) return []
  const value = Number(match[2]!.replace(/,/g, ""))
  const normalized = normalize(value, match[3]!)
  const name = match[1]!.replace(/^(?:the|our|a|an)\s+/i, "").trim()
  return [
    {
      kind: "fact",
      rule: "stated-value",
      subject: name,
      attribute: normalized.base,
      fields: { name, value, unit: match[3]!, normalized: normalized.value, base: normalized.base },
      confidence: 0.6,
      start: unit.start,
      end: unit.end,
    },
  ]
}

// --- Decisions ------------------------------------------------------------------------------------------------------

const DECIDED =
  /\bwe(?:'ve| have)?\s+(?:decided(?: to)?|chose(?: to)?|choose(?: to)?|will use|adopted|went with|picked|selected|opted for|settled on)\s+(.{3,160}?)\s+(?:because|since|due to|as)\s+(.{3,200}?)[.!]?$/i
const LABEL = /^decision\s*:\s*(.{3,200}?)[.!]?$/i

function decisionProse(unit: Unit): Candidate[] {
  if (unit.type === "heading") return []
  const label = unit.text.match(LABEL)
  if (label)
    return [
      {
        kind: "decision",
        rule: "decision-label",
        subject: label[1]!,
        fields: { choice: label[1]!, alternatives: [] },
        confidence: 0.9,
        start: unit.start,
        end: unit.end,
      },
    ]
  const match = unit.text.match(DECIDED)
  if (!match) return []
  return [
    {
      kind: "decision",
      rule: "decision-prose",
      subject: match[1]!,
      fields: { choice: match[1]!, reason: match[2]!, alternatives: [] },
      confidence: 0.65,
      start: unit.start,
      end: unit.end,
    },
  ]
}

// An architecture decision record: a "Decision" section beside "Status" or "Context". One record for the document, its
// subject the record's title, so rewording the decision is a change to it rather than a new one.
function adr(context: Context, units: readonly Unit[]): Candidate[] {
  const sections = context.structured.sections
  const decision = sections.find((section) => /^(?:\d+(?:\.\d+)*\.?\s+)?decision(?: outcome)?$/i.test(section.heading))
  if (!decision) return []
  const siblings = sections.filter((section) => section.parent === decision.parent && section !== decision)
  const named = (pattern: RegExp) =>
    siblings.find((section) => pattern.test(section.heading.replace(/^\d+(?:\.\d+)*\.?\s+/, "")))
  const status = named(/^status$/i)
  const contextSection = named(/^context(?: and problem statement)?$/i)
  if (!status && !contextSection) return []
  const first = (section: BrainStructure.Section | undefined) =>
    units.find((unit) => section && unit.section === section.ordinal && unit.type !== "heading")
  const choice = first(decision)
  if (!choice) return []
  const statusText = (
    first(status)?.text ??
    context.extracted.text.match(/\bstatus\s*:\s*(\w+)/i)?.[1] ??
    ""
  ).toLowerCase()
  const state = ["proposed", "accepted", "superseded", "deprecated", "rejected"].find((word) =>
    statusText.includes(word),
  )
  const options = named(/^(?:considered options|options considered|alternatives(?: considered)?|options)$/i)
  const alternatives = units
    .filter((unit) => options && unit.section === options.ordinal && unit.type === "item")
    .map((unit) => unit.text.slice(0, 160))
  const chosen = choice.text.match(/^chosen option\s*:\s*["“]?([^"”,]+)["”]?/i)?.[1] ?? choice.text
  const title =
    decision.parent === undefined
      ? context.extracted.title
      : (sections[decision.parent]?.heading ?? context.extracted.title)
  return [
    {
      kind: "decision",
      rule: "adr",
      subject: title,
      fields: {
        ...(state ? { status: state } : {}),
        choice: chosen,
        ...(first(contextSection) ? { reason: first(contextSection)!.text } : {}),
        alternatives,
      },
      confidence: 0.9,
      start: choice.start,
      end: choice.end,
    },
  ]
}

// --- Contracts ------------------------------------------------------------------------------------------------------

const ROUTE = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[\w\-./{}:*~%<>‹]*[\w}*>])/g
const ENV = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g
const ENV_USE =
  /(?:process\.env\.|os\.environ\[["']|getenv\(["']|env\.|\$\{|\$)([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)|^\s*(?:export\s+)?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)=(.*)$/gm
const ERROR = /\b(E\d{3,5}|ERR_[A-Z0-9_]{2,})\b/g
const SHELL = /^(?:sh|bash|shell|console|zsh|fish|powershell|ps1?|pwsh|cmd|bat|terminal|shell-session)$/i
const EXTENSIONS =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|ya?ml|toml|txt|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|sh|lock|css|scss|html?|xml|sql|env|pdf|png|jpe?g|svg|gif|docx|xlsx|pptx|csv|ini|cfg|conf|log)$/i
const DOMAINS = /\.(?:com|org|net|io|dev|ai|app|co|edu|gov|uk|de|fr|jp|cn|us|info|biz|sh|so)$/i

function contracts(unit: Unit, format: BrainSchema.Format): Candidate[] {
  const code = unit.type === "code"
  const confidence = code ? 0.85 : 0.75
  const span = { start: unit.start, end: unit.end }
  const out: Candidate[] = []
  // An OpenAPI document's operations are read from its structure, so its headings are not read again here.
  if (!(format === "openapi" && unit.type === "heading"))
    for (const match of unit.text.matchAll(ROUTE)) {
      const path = match[2]!.replace(/‹/g, "<")
      out.push({
        kind: "contract",
        rule: "http-route",
        subject: `endpoint:${match[1]!.toLowerCase()} ${route(path)}`,
        canonical: true,
        fields: { form: "endpoint", name: `${match[1]} ${path}`, method: match[1], path, route: route(path) },
        confidence: code || unit.code.some((item) => item.includes(path)) ? 0.85 : confidence,
        ...span,
      })
    }
  const names = new Set([
    ...unit.code.flatMap((item) => [...item.matchAll(ENV)].map((match) => match[0])),
    ...(code ? [...unit.text.matchAll(ENV_USE)].map((match) => match[1] ?? match[2]!) : []),
  ])
  const prose =
    unit.type !== "code"
      ? [
          ...unit.text.matchAll(
            /\b(?:environment variable|env var(?:iable)?)s?\s+["“]?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)/gi,
          ),
        ].map((match) => match[1]!)
      : []
  for (const name of new Set([...names, ...prose]))
    if (!/^ERR_/.test(name)) {
      const value = code ? unit.text.match(new RegExp(`^\\s*(?:export\\s+)?${name}=(.*)$`))?.[1]?.trim() : undefined
      out.push({
        kind: "contract",
        rule: "env",
        subject: `env:${name}`,
        canonical: true,
        fields: { form: "env", name, ...(value && !value.includes("[redacted]") ? { value } : {}) },
        confidence: names.has(name) ? 0.85 : 0.75,
        ...span,
      })
    }
  const commands = [
    ...(code && (SHELL.test(unit.language ?? "") || /^\s*\$\s/.test(unit.text)) ? [unit.text] : []),
    ...unit.code,
  ]
  for (const line of commands) {
    const parsed = cli(line)
    if (parsed)
      out.push({
        kind: "contract",
        rule: "cli",
        subject: `cli:${parsed.name}`,
        canonical: true,
        fields: { form: "cli", name: parsed.name, params: parsed.flags.map((flag) => ({ name: flag })) },
        confidence: 0.85,
        ...span,
      })
  }
  for (const item of unit.code) {
    const key = item.trim()
    if (
      /^[a-z][\w-]*(?:\.[a-zA-Z][\w-]*)+$/.test(key) &&
      !EXTENSIONS.test(key) &&
      !DOMAINS.test(key) &&
      !/^\d/.test(key)
    )
      out.push({
        kind: "contract",
        rule: "config-key",
        subject: `config:${key}`,
        canonical: true,
        fields: { form: "config", name: key },
        confidence: 0.85,
        ...span,
      })
    const call = key.match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\(\)$/)
    if (call)
      out.push({
        kind: "contract",
        rule: "function",
        subject: `function:${call[1]}`,
        canonical: true,
        fields: { form: "function", name: call[1] },
        confidence: 0.85,
        ...span,
      })
  }
  for (const match of unit.text.matchAll(ERROR))
    out.push({
      kind: "contract",
      rule: "error-code",
      subject: `error:${match[1]}`,
      canonical: true,
      fields: { form: "error", name: match[1] },
      confidence: code || unit.code.some((item) => item.includes(match[1]!)) ? 0.85 : confidence,
      ...span,
    })
  return out
}

const RPC = /\brpc\s+(\w+)\s*\(\s*(?:stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(?:stream\s+)?([\w.]+)\s*\)/g
const GRAPHQL = /\b(?:type|extend\s+type)\s+(Query|Mutation|Subscription)\s*\{([^}]*)\}/g

// Interface definitions in a code block or a sentence: gRPC methods (named by their service when the block declares
// one) and GraphQL root fields.
function interfaces(block: BrainDocument.Block, context: Context): Candidate[] {
  if (block.type !== "code" && block.type !== "paragraph" && block.type !== "list") return []
  const text = context.extracted.text.slice(block.span.start, block.span.end)
  const confidence = block.type === "code" ? 0.85 : 0.75
  const at = (index: number, length: number) => {
    const start = context.extracted.text.lastIndexOf("\n", block.span.start + index) + 1
    const end = context.extracted.text.indexOf("\n", block.span.start + index + length)
    return { start: Math.max(start, block.span.start), end: end < 0 || end > block.span.end ? block.span.end : end }
  }
  const services = [...text.matchAll(/\bservice\s+(\w+)\s*\{/g)].map((match) => ({
    name: match[1]!,
    index: match.index!,
  }))
  const rpcs = [...text.matchAll(RPC)].map((match): Candidate => {
    const service = services.findLast((item) => item.index < match.index!)?.name
    const name = service ? `${service}.${match[1]}` : match[1]!
    return {
      kind: "contract",
      rule: "grpc",
      subject: `rpc:${name}`,
      canonical: true,
      fields: { form: "function", name, params: [{ name: match[2], type: match[2] }], returns: match[3] },
      confidence,
      ...at(match.index!, match[0].length),
    }
  })
  const graphql =
    block.type === "code"
      ? [...text.matchAll(GRAPHQL)].flatMap((match) =>
          [...match[2]!.matchAll(/^\s*(\w+)\s*(\([^)]*\))?\s*:\s*([\w[\]!]+)/gm)].map((field): Candidate => {
            const root = match[1]!
            const index = match.index! + match[0].indexOf(match[2]!) + field.index!
            const params = [...(field[2] ?? "").matchAll(/(\w+)\s*:\s*([\w[\]!]+)/g)].map((param) => ({
              name: param[1],
              type: param[2],
              required: param[2]!.endsWith("!"),
            }))
            return {
              kind: "contract",
              rule: "graphql",
              subject: `graphql:${root.toLowerCase()} ${field[1]}`,
              canonical: true,
              fields: {
                form: "endpoint",
                name: `${root}.${field[1]}`,
                method: root.toLowerCase(),
                params,
                returns: field[3],
              },
              confidence,
              ...at(index, field[0].length),
            }
          }),
        )
      : []
  return [...rpcs, ...graphql]
}

// A command line with at least one flag: the command and its subcommands, and the flags it was given.
function cli(line: string) {
  const text = line
    .trim()
    .replace(/^[$>]\s+/, "")
    .replace(/^sudo\s+/, "")
  if (
    !/^[a-z][\w.-]*\s/.test(text) ||
    !/\s--?[a-zA-Z]/.test(text) ||
    text.length > 200 ||
    /[|;&]|\[redacted\]/.test(text)
  )
    return undefined
  const words = text.split(/\s+/)
  const subcommands = words.slice(1, 4)
  const stop = subcommands.findIndex((word) => !/^[a-z][\w:-]*$/.test(word))
  const name = words.slice(0, 1 + (stop < 0 ? subcommands.length : stop)).join(" ")
  const flags = [
    ...new Set(words.filter((word) => /^--?[a-zA-Z][\w-]*/.test(word)).map((word) => word.replace(/=.*$/, ""))),
  ]
  return { name, flags }
}

/** A route's shape: parameters (`{id}`, `:id`, `<id>`) become `*`, a trailing slash goes. */
export function route(path: string) {
  return (
    path
      .replace(/\{[^}]*\}|:[A-Za-z_]\w*|<[^>]*>/g, "*")
      .replace(/\/+$/, "")
      .replace(/[?#].*$/, "") || "/"
  )
}

const OPERATION = /^(GET|PUT|POST|DELETE|OPTIONS|HEAD|PATCH|TRACE) (\/\S*)$/

// OpenAPI operations from the blocks the data reader wrote: the heading, its summary and its parameter and response
// tables. Structural, so the most certain contracts there are.
function openapi(context: Context): Candidate[] {
  if (context.extracted.format !== "openapi") return []
  const blocks = context.extracted.blocks
  return blocks.flatMap((block, index): Candidate[] => {
    if (block.type !== "heading") return []
    const match = block.text.match(OPERATION)
    if (!match) return []
    const section = context.structured.owners[index]!
    const inside = blocks.filter((_, at) => at > index && context.structured.owners[at] === section)
    const summary = inside.find((other) => other.type === "paragraph")
    const parameters = inside.find(
      (other): other is Extract<BrainDocument.Block, { type: "table" }> =>
        other.type === "table" && other.header[0] === "Name" && other.header[1] === "In",
    )
    const responses = inside.find(
      (other): other is Extract<BrainDocument.Block, { type: "table" }> =>
        other.type === "table" && other.header[0] === "Status",
    )
    const path = match[2]!.replace(/‹/g, "<")
    const end = summary && summary.type === "paragraph" ? summary.span.end : block.span.end
    return [
      {
        kind: "contract",
        rule: "openapi-path",
        subject: `endpoint:${match[1]!.toLowerCase()} ${route(path)}`,
        canonical: true,
        fields: {
          form: "endpoint",
          name: `${match[1]} ${path}`,
          method: match[1],
          path,
          route: route(path),
          params: (parameters?.rows ?? []).map((row) => ({
            name: row[0],
            in: row[1],
            ...(row[2] ? { type: row[2] } : {}),
            required: row[3] === "yes",
          })),
          status: (responses?.rows ?? []).map((row) => Number(row[0])).filter((status) => Number.isInteger(status)),
        },
        confidence: 1,
        start: block.span.start,
        end,
        card: `${block.text}${summary && summary.type === "paragraph" ? `: ${summary.text}` : ""}`,
      },
    ]
  })
}

// --- Tables ---------------------------------------------------------------------------------------------------------

const NAME_COLUMN =
  /^(?:name|key|field|parameter|param|option|setting|variable|property|flag|config(?:uration)?(?: key)?|env(?:ironment variable)?)s?$/i
const VALUE_COLUMNS = /^(?:default(?: value)?|type|description|value|values|example)$/i
const TERM_COLUMN = /^(?:term|acronym|abbreviation|word|concept|keyword)s?$/i
const DEFINITION_COLUMN = /^(?:definition|meaning|description|explanation|stands for|expansion)$/i
const ID_COLUMN = /^(?:id|req(?:uirement)?\.?\s*id|ref|#|no\.?)$/i
const TEXT_COLUMN = /^(?:requirement|description|statement|text|req(?:uirement)? text)$/i
const PRIORITY_COLUMN = /^(?:priority|moscow|level|importance)$/i

function tables(block: BrainDocument.Block, index: number, context: Context): Candidate[] {
  if (block.type !== "table" || block.header.length === 0 || context.extracted.format === "openapi") return []
  const header = block.header.map((cell) => cell.trim())
  const column = (pattern: RegExp, skip = -1) => header.findIndex((cell, at) => at !== skip && pattern.test(cell))
  const spans = rowSpans(block)
  const id = column(ID_COLUMN)
  const text = column(TEXT_COLUMN, id)
  const term = column(TERM_COLUMN)
  const definition = column(DEFINITION_COLUMN, term)
  const name = column(NAME_COLUMN)
  const rows = block.rows.map((row, at) => ({ row, span: spans[at]!, ref: block.refs?.[at] }))
  const usableRow = (row: readonly string[]) => usable(row.join(" | "))
  if (id >= 0 && text >= 0) {
    const priority = column(PRIORITY_COLUMN)
    return rows.flatMap(({ row, span, ref: at }): Candidate[] => {
      const statement = row[text]?.trim() ?? ""
      const identifier = row[id]?.trim() ?? ""
      if (!statement || !usableRow(row)) return []
      const level = (row[priority] ?? "").toLowerCase()
      const keyword = statement.match(KEYWORD)?.[1]
      const modality = keyword
        ? MODALITY[keyword]!
        : /must|high|critical|p0|p1|mandatory/.test(level)
          ? "must"
          : /should|medium|p2/.test(level)
            ? "should"
            : /could|may|low|nice|optional|p3/.test(level)
              ? "may"
              : /won'?t/.test(level)
                ? "must-not"
                : (lowerModality(statement) ?? "must")
      const ref = /^[A-Z]{1,6}-?\d+(?:\.\d+)*$/.test(identifier) ? identifier : undefined
      const fields = {
        ...(ref ? { ref } : {}),
        modality,
        subject: lead(statement, keyword ? statement.indexOf(keyword) : 0),
        ...(at ? { at } : {}),
      }
      return [
        {
          kind: "requirement",
          rule: "requirement-table",
          subject: ref ?? statement,
          canonical: !!ref,
          fields,
          confidence: 0.9,
          ...span,
          card: oneLine(`${identifier} ${statement}`),
        },
      ]
    })
  }
  if (term >= 0 && definition >= 0)
    return rows.flatMap(({ row, span }): Candidate[] => {
      const word = row[term]?.trim() ?? ""
      const meaning = row[definition]?.trim() ?? ""
      if (!word || !meaning || word.length > 60 || !usableRow(row)) return []
      const aliases = [...word.matchAll(/\(([^)]+)\)|\s+\/\s+(\S.*)$/g)].map((match) => (match[1] ?? match[2]!).trim())
      return [
        {
          kind: "term",
          rule: "glossary-table",
          subject: word.replace(/\s*\([^)]*\)|\s+\/\s+.*$/g, ""),
          fields: { term: word.replace(/\s*\([^)]*\)|\s+\/\s+.*$/g, ""), aliases, definition: meaning },
          confidence: 0.9,
          ...span,
          card: oneLine(`${word}: ${meaning}`),
        },
      ]
    })
  if (name >= 0 && header.some((cell, at) => at !== name && VALUE_COLUMNS.test(cell)))
    return rows.flatMap(({ row, span, ref }): Candidate[] => {
      const key = row[name]?.trim() ?? ""
      if (!key || key.length > 80 || !usableRow(row)) return []
      const cell = (pattern: RegExp) => {
        const at = header.findIndex((other, position) => position !== name && pattern.test(other))
        return at >= 0 && row[at]?.trim() ? row[at]!.trim() : undefined
      }
      const fallback = cell(/^default(?: value)?$/i) ?? cell(/^values?$/i)
      const measured = fallback?.match(new RegExp(`^${NUMBER}\\s?${UNIT}$`, "i"))
      const normalized = measured ? normalize(Number(measured[1]!.replace(/,/g, "")), measured[2]!) : undefined
      const fields = {
        name: key,
        ...(cell(/^default(?: value)?$/i) ? { default: cell(/^default(?: value)?$/i) } : {}),
        ...(cell(/^type$/i) ? { type: cell(/^type$/i) } : {}),
        ...(cell(/^values?$/i) ? { value: cell(/^values?$/i) } : {}),
        ...(cell(/^(?:description|example)$/i) ? { description: cell(/^(?:description|example)$/i) } : {}),
        ...(measured && normalized ? { unit: measured[2], normalized: normalized.value, base: normalized.base } : {}),
        ...(ref ? { at: ref } : {}),
      }
      return [
        {
          kind: "fact",
          rule: "parameter-table",
          subject: key,
          fields,
          confidence: 0.85,
          ...span,
          card: oneLine(row.filter(Boolean).join(" | ")),
        },
      ]
    })
  return []
}

// --- Procedures -----------------------------------------------------------------------------------------------------

const PROCEDURE_SECTION =
  /how to|steps|setup|set up|install|deploy|release|runbook|getting started|migrat|rollback|roll back|troubleshoot|upgrade|onboard/i
const IMPERATIVE = new Set(
  "add announce apply approve archive back build call change check choose click clone close commit configure confirm connect copy create delete deploy disable document download drain edit enable ensure enter export fill find generate go grant import install launch log login merge migrate monitor mount move navigate notify open paste pick prepare press publish pull push rebase reboot rebuild record redeploy refresh register reload remove rename replace request reset restart restore revert review revoke roll rotate run save scale schedule select send set setup sign start stop switch tag test type uninstall unzip update upgrade upload use verify visit wait write".split(
    " ",
  ),
)

function procedures(block: BrainDocument.Block, index: number, context: Context, units: readonly Unit[]): Candidate[] {
  if (block.type !== "list" || block.items.length < 2) return []
  const section = context.structured.owners[index] ?? 0
  const path = context.paths[section] ?? ""
  const imperative = block.items.filter((item) =>
    IMPERATIVE.has(
      item.text
        .split(/\s+/)[0]!
        .toLowerCase()
        .replace(/[^a-z]/g, ""),
    ),
  ).length
  const titled = block.ordered && PROCEDURE_SECTION.test(path)
  if (!titled && !(block.items.length >= 3 && imperative >= 3 && imperative >= 0.6 * block.items.length)) return []
  const steps = block.items
    .filter((item) => item.depth === 0)
    .slice(0, 20)
    .map((item) => item.text.slice(0, 160))
  const commands = units
    .filter(
      (unit) =>
        unit.section === section &&
        unit.type === "code" &&
        (SHELL.test(unit.language ?? "") || /^\s*\$\s/.test(unit.text)),
    )
    .map((unit) => unit.text.trim().replace(/^\$\s+/, ""))
    .filter((line) => line && !line.startsWith("#") && !line.includes("[redacted]"))
    .slice(0, 8)
  const heading = context.structured.sections[section]?.heading ?? context.extracted.title
  return [
    {
      kind: "procedure",
      rule: titled ? "procedure-heading" : "procedure-imperative",
      subject: heading,
      fields: { title: heading, steps, commands },
      confidence: titled ? 0.8 : 0.6,
      start: block.span.start,
      end: block.span.end,
      card: `${oneLine(steps[0] ?? "")} (${steps.length} steps)`,
    },
  ]
}

// --- Terms ----------------------------------------------------------------------------------------------------------

const GLOSSARY_SECTION = /glossary|definitions|terminology|\bterms\b|abbreviations|acronyms|vocabulary/i
const ENTRY = /^([^:—–]{1,60}?)\s*(?::|—|–|\s-\s)\s*(\S.{2,})$/
const DEFINES =
  /^(?:(?:[Tt]he|[Aa]n?)\s+)?(?:term\s+)?["“]?([A-Z][\w-]*(?:\s+[A-Za-z][\w-]*){0,4}?)["”]?\s+(?:means|is defined as|refers to|stands for|denotes)\s+(.{3,}?)[.!]?$/
const ACRONYM =
  /\b((?:[A-Z][a-z]+|[A-Z]{2,})(?:[\s-]+(?:[A-Z][a-z]+|[A-Z]{2,}|of|and|for|the|to|in|on|as|a)){1,7})\s+\(([A-Z][A-Za-z]{1,7}?)(s?)\)/g

function definition(unit: Unit, context: Context): Candidate[] {
  if (unit.type === "heading") return []
  const out: Candidate[] = []
  const block = context.extracted.blocks[unit.block]!
  // In a glossary a whole paragraph or item is one entry, so its definition is not cut at its first sentence.
  if (
    GLOSSARY_SECTION.test(context.paths[unit.section] ?? "") &&
    (unit.type === "item" || (block.type === "paragraph" && unit.start === block.span.start))
  ) {
    const whole = unit.type === "item" ? unit.text : block.type === "paragraph" ? block.text : unit.text
    const entry = whole.length <= SENTENCE ? whole.match(ENTRY) : undefined
    if (entry && usable(whole))
      out.push({
        kind: "term",
        rule: "glossary-entry",
        subject: entry[1]!.trim(),
        fields: { term: entry[1]!.trim(), aliases: [], definition: entry[2]!.trim() },
        confidence: 0.8,
        start: unit.start,
        end: unit.type === "item" ? unit.end : block.span.end,
      })
  }
  const defines = unit.text.match(DEFINES)
  if (defines && !STOP_LEAD.test(defines[1]!))
    out.push({
      kind: "term",
      rule: "definition-prose",
      subject: defines[1]!,
      fields: { term: defines[1]!, aliases: [], definition: defines[2]! },
      confidence: 0.7,
      start: unit.start,
      end: unit.end,
    })
  for (const match of unit.text.matchAll(ACRONYM)) {
    const words = match[1]!.split(/[\s-]+/)
    const acronym = match[2]!
    // The expansion is the run of words whose initials spell the acronym, ending right before it.
    const expansion = expand(words, acronym)
    if (expansion)
      out.push({
        kind: "term",
        rule: "acronym",
        subject: acronym,
        fields: { term: acronym, aliases: [expansion], definition: expansion },
        confidence: 0.8,
        start: unit.start,
        end: unit.end,
      })
  }
  return out
}

const STOP_LEAD = /^(?:this|that|it|which|what|there|here|each|every|it's)$/i
const SMALL = new Set(["of", "and", "for", "the", "to", "in", "on", "as", "a"])

function expand(words: readonly string[], acronym: string) {
  const letters = acronym.toUpperCase()
  for (let start = 0; start < words.length; start++) {
    const run = words.slice(start)
    if (SMALL.has(run[0]!.toLowerCase())) continue
    const initials = run
      .filter((word) => !SMALL.has(word.toLowerCase()))
      .map((word) => (/^[A-Z]{2,}$/.test(word) ? word : word[0]!))
      .join("")
      .toUpperCase()
    if (initials === letters) return run.join(" ")
  }
  return undefined
}

// --- Entities -------------------------------------------------------------------------------------------------------

const TYPES: { readonly [word: string]: "service" | "table" | "queue" | "environment" | "component" } = {
  service: "service",
  api: "service",
  worker: "service",
  daemon: "service",
  table: "table",
  database: "table",
  db: "table",
  queue: "queue",
  topic: "queue",
  stream: "queue",
  environment: "environment",
  env: "environment",
  cluster: "environment",
  component: "component",
  module: "component",
  bucket: "component",
  library: "component",
}
const TYPE_WORD = String.raw`([Ss]ervices?|API|[Aa]pi|[Ww]orkers?|[Dd]aemon|[Tt]ables?|[Dd]atabase|DB|db|[Qq]ueues?|[Tt]opics?|[Ss]treams?|[Ee]nvironments?|[Ee]nv|[Cc]lusters?|[Cc]omponents?|[Mm]odules?|[Bb]uckets?|[Ll]ibrary)`
const NAMED = new RegExp(
  String.raw`\b([A-Z][\w-]*(?:\s+[A-Z][\w-]*){0,3}|[a-z]+(?:[A-Z][a-z0-9]+)+|[a-z0-9]+(?:[_-][a-z0-9]+)+)\s+${TYPE_WORD}\b`,
  "g",
)
const ENVIRONMENT =
  /\b(production|staging|development|dev|prod|qa|sandbox|preview|test|testing)\s+(environments?|clusters?|env)\b/gi
const CREATE = /\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([\w.]+)[`"\]]?/gi
const DETERMINER =
  /^(?:the|a|an|this|that|these|those|our|your|their|its|each|every|any|all|some|new|old|main|one|two|when|if|then|use|in|on|at|for|from|with|and|or|by|to)\s+/i

// Services, tables, queues, environments and components the document keeps naming (three times or more), or that
// it creates, or that an API or JSON schema defines. One record per name in the document.
function entities(context: Context, units: readonly Unit[]): Candidate[] {
  const text = context.extracted.text
  // Counting is a pass over the whole text, so each name is counted once, and only the first few hundred names are.
  const counted = new Map<string, number>()
  const mentions = (name: string) => {
    if (!counted.has(name) && counted.size < 500) counted.set(name, text.split(name).length - 1)
    return counted.get(name) ?? 0
  }
  const out = new Map<string, Candidate>()
  const add = (
    name: string,
    type: string,
    rule: Rule,
    unit: { readonly start: number; readonly end: number },
    count: number,
    confidence?: number,
  ) => {
    const key = name.toLowerCase()
    if (out.has(key) || name.includes("@") || name.length < 2 || name.length > 60) return
    out.set(key, {
      kind: "entity",
      rule,
      subject: name,
      fields: { name, type, mentions: count },
      confidence: confidence ?? Math.min(0.85, 0.5 + 0.05 * count),
      start: unit.start,
      end: unit.end,
    })
  }
  for (const unit of units) {
    // Schema definitions name tables in a code block; nothing else in code makes an entity.
    for (const match of unit.text.matchAll(CREATE))
      add(match[1]!, "table", "create-table", unit, Math.max(1, mentions(match[1]!)))
    if (unit.type === "code") continue
    if (
      (context.extracted.format === "openapi" ||
        context.extracted.format === "json" ||
        context.extracted.format === "yaml") &&
      unit.type === "heading"
    ) {
      const schema = unit.text.match(/^Schema (\S+)$/)
      if (schema) add(schema[1]!, "component", "schema-definition", unit, mentions(schema[1]!), 0.85)
      continue
    }
    if (!usable(unit.text)) continue
    const coded = unit.code.flatMap((code) =>
      /^[a-z_][\w.-]*$/.test(code)
        ? [...unit.text.matchAll(new RegExp(String.raw`\b(${code.replace(/[.]/g, "\\.")})\s+${TYPE_WORD}\b`, "g"))]
        : [],
    )
    for (const match of [...unit.text.matchAll(NAMED), ...unit.text.matchAll(ENVIRONMENT), ...coded]) {
      const name = match[1]!.replace(DETERMINER, "").trim()
      const word = match[2]!.toLowerCase().replace(/s$/, "")
      if (
        !name ||
        DETERMINER.test(`${name} `) ||
        /^(?:Mr|Ms|Mrs|Dr)\b/.test(name) ||
        BrainLexical.STOP_TERMS.has(name.toLowerCase())
      )
        continue
      const count = mentions(name)
      if (count >= 3) add(`${name} ${match[2]}`, TYPES[word] ?? "component", "named-entity", unit, count)
    }
  }
  return [...out.values()]
}

// --- Questions ------------------------------------------------------------------------------------------------------

const OPEN = /\b(?:TBD|TBC|TODO|FIXME)\b|\bto be (?:decided|determined|confirmed|defined)\b/
const QUESTION_SECTION = /open questions?|unresolved|outstanding questions?|questions/i
const FAQ = /\bfaq\b|frequently asked/i

function question(unit: Unit, context: Context): Candidate[] {
  const path = context.paths[unit.section] ?? ""
  const make = (rule: Rule): Candidate[] => [
    {
      kind: "question",
      rule,
      subject: unit.text,
      fields: { text: unit.text, status: "open" },
      confidence: 0.8,
      start: unit.start,
      end: unit.end,
    },
  ]
  if (unit.type === "heading")
    return /\?\s*$/.test(unit.text) && !FAQ.test(path) && !FAQ.test(context.extracted.title)
      ? make("heading-question")
      : []
  if (OPEN.test(unit.text)) return make("tbd")
  if (
    /^open question\s*:/i.test(unit.text) ||
    (QUESTION_SECTION.test(path) && !FAQ.test(path) && /\?\s*$/.test(unit.text))
  )
    return make("open-question")
  return []
}

// --- Records --------------------------------------------------------------------------------------------------------

function assemble(
  candidates: readonly Candidate[],
  context: Context,
  input: { readonly repository: string; readonly lineage: string; readonly limits: BrainLimits.Limits },
) {
  const passages = context.structured.passages
  const text = context.extracted.text
  const located = candidates.flatMap((candidate) => {
    const passage = locate(passages, candidate.start)
    return passage ? [{ candidate, passage }] : []
  })
  // At most `perPassage` records from a passage, the most certain first.
  const byPassage = Map.groupBy(located, (item) => item.passage.id)
  const kept = [...byPassage.values()]
    .flatMap((items) =>
      items
        .toSorted((a, b) => b.candidate.confidence - a.candidate.confidence || a.candidate.start - b.candidate.start)
        .slice(0, input.limits.output.perPassage),
    )
    .toSorted(
      (a, b) =>
        a.candidate.start - b.candidate.start || RULES.indexOf(a.candidate.rule) - RULES.indexOf(b.candidate.rule),
    )
  const seen = new Map<string, { count: number; quotes: Set<string> }>()
  const records: Record[] = []
  const warnings = new Set<BrainSchema.DocumentWarning>()
  for (const { candidate, passage } of kept) {
    if (records.length >= input.limits.output.records) {
      warnings.add("truncated")
      break
    }
    const subject = `${candidate.canonical ? candidate.subject : subjectOf(candidate.subject)}${candidate.attribute ? `|${candidate.attribute}` : ""}`
    if (!subject) continue
    const base = `${candidate.kind}|${subject}`
    const quote = quoteOf(text, candidate.start, candidate.end)
    const quoteHash = BrainStructure.normHash(quote)
    const entry = seen.get(base) ?? { count: 0, quotes: new Set<string>() }
    // The same thing said twice is one record; a term or entity is one record however often it is defined.
    if (entry.quotes.has(quoteHash) || (entry.count > 0 && (candidate.kind === "term" || candidate.kind === "entity")))
      continue
    entry.count++
    entry.quotes.add(quoteHash)
    seen.set(base, entry)
    const key = entry.count > 1 ? `${base}#${entry.count}` : base
    records.push({
      id: `r${BrainStructure.base32(BrainStructure.sha256(`${input.repository}\0${input.lineage}\0${key}`)).slice(0, 6)}`,
      key,
      kind: candidate.kind,
      subject,
      card: cardOf(candidate.card ?? text.slice(candidate.start, candidate.end)),
      quote,
      quoteHash,
      fields: candidate.fields,
      confidence: candidate.confidence,
      rule: candidate.rule,
      polarity: BrainLexical.polarity(quote),
      passage: passage.id,
      section: passage.section,
      ...(passage.page === undefined ? {} : { page: passage.page }),
      start: candidate.start,
      end: candidate.start + quote.length,
      ...(passage.hold ? { hold: passage.hold } : {}),
    })
  }
  return { records, warnings: [...warnings] }
}

// The passage holding an offset: passages run in document order, so the last one starting at or before it, unless that
// one ends first (the offset is in a heading), in which case the passage under the heading.
function locate(passages: readonly BrainStructure.Passage[], offset: number) {
  const state = { low: 0, high: passages.length - 1, found: -1 }
  while (state.low <= state.high) {
    const middle = (state.low + state.high) >> 1
    if (passages[middle]!.start <= offset) {
      state.found = middle
      state.low = middle + 1
    } else state.high = middle - 1
  }
  const before = passages[state.found]
  if (before && offset < before.end) return before
  return passages[state.found + 1] ?? before
}

/**
 * A subject phrase as a key: its first six distinct terms, sorted, so filler, word order and plurals do not change it
 * ("The client MUST retry" and "Clients MUST retry" are one subject). A phrase with no terms keys on its words.
 */
export function subjectOf(phrase: string) {
  const terms = [...BrainLexical.terms(phrase).keys()]
    .filter((term) => !FILLER.has(term))
    .slice(0, 6)
    .toSorted()
  return terms.length > 0 ? terms.join(" ") : BrainStructure.normalise(phrase).slice(0, 60)
}

// Words a rewording adds or drops without changing what a sentence is about: pronouns, determiners, modal verbs,
// prepositions and numbers written out (numbers in digits never become terms). They stay out of keys, so they cannot move an id.
const FILLER: ReadonlySet<string> = new Set(
  "their its his her him she they them theirs ours yours mine also each every both either neither other another such shall may might could should can cannot does doing being been one two three four five six seven eight nine ten eleven twelve twenty hundred thousand first second third once twice per via onto upon within across among along toward towards against between during until since while".split(
    " ",
  ),
)

function quoteOf(text: string, start: number, end: number) {
  const quote = text.slice(start, end)
  if (quote.length <= QUOTE) return quote
  const cut = quote.lastIndexOf(" ", QUOTE)
  return quote.slice(0, cut > QUOTE / 2 ? cut : QUOTE)
}

function cardOf(text: string) {
  const line = oneLine(text)
  if (line.length <= CARD) return line
  const cut = line.lastIndexOf(" ", CARD - 1)
  return `${line.slice(0, cut > CARD / 2 ? cut : CARD - 1)}…`
}

function oneLine(text: string) {
  return text.replace(/\s+/g, " ").trim()
}
