export * as BrainMarkdown from "./markdown"

import { lexer, type Token, type Tokens } from "marked"
import { BrainScan } from "../scan"
import { BrainData } from "./data"
import { BrainHtml } from "./html"
import { refuse, type BrainLimits } from "./limits"
import type { Draft, Read, ReadRefusal } from "./read"

// Markdown and MDX through marked's lexer: headings, paragraphs with their code spans, nested lists, GFM tables, fences
// and quotes. Raw HTML reads through the HTML reader, so hidden HTML inside Markdown is dropped and flagged the same
// way. Front matter is YAML in the core schema; only its title is used.

type Inline = { code: string[]; links: string[]; hidden: boolean; hiding: number }

export function read(source: string, limits: BrainLimits.Limits): Read | ReadRefusal {
  const front = matter(source, limits)
  const tokens = lex(front.body)
  if (!tokens) return refuse("invalid", "This Markdown nests too deeply to read safely.")
  const links: string[] = []
  const drafts = blocks(tokens, limits, links, 0)
  return {
    type: "read",
    format: "markdown",
    ...(front.title ? { title: front.title } : {}),
    drafts: drafts.drafts,
    links,
    warnings: drafts.truncated ? ["truncated"] : [],
  }
}

// Front matter between `---` lines at the very top. gray-matter is not used here: its `---js` engine evaluates the
// front matter as JavaScript, and a document is never code.
function matter(source: string, limits: BrainLimits.Limits) {
  const match = source.match(/^---[ \t]*\r?\n([\s\S]{0,65536}?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/)
  if (!match) return { body: source, title: undefined }
  const parsed = BrainData.yaml(match[1]!, limits)
  const value = parsed.type === "value" ? parsed.value : undefined
  const title =
    typeof value === "object" && value !== null && "title" in value && typeof value.title === "string"
      ? value.title
      : undefined
  return { body: source.slice(match[0].length), title }
}

// marked takes time growing with the square of a list's length, so a long document is lexed in pieces of about 250
// lines, cut only outside code fences where a new block starts (a blank line, a heading or a top-level list item). A
// very long list becomes several lists of the same items.
const CHUNK = 250

function chunks(body: string) {
  const lines = body.split("\n")
  if (lines.length <= CHUNK) return [body]
  const out: string[][] = [[]]
  const state = { fence: "" }
  for (const line of lines) {
    const current = out.at(-1)!
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1]
    if (!state.fence && current.length >= CHUNK && (!line.trim() || /^(?:#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s)/.test(line)))
      out.push([line])
    else current.push(line)
    if (fence && !state.fence) state.fence = fence
    else if (fence && state.fence && fence[0] === state.fence[0] && fence.length >= state.fence.length) state.fence = ""
  }
  return out.map((chunk) => chunk.join("\n"))
}

// Quotes and lists more than 32 levels deep are flattened to 32 before lexing, since the lexer recurses once per level,
// and runs of more than 64 of one delimiter (emphasis, brackets) are cut to 64, since the lexer slows down sharply on
// long ones. A stack overflow the lexer still hits on a pathological line is caught and the file refused.
function lex(body: string) {
  const bounded = body
    .replace(/^((?:[ \t]*>){32})(?:[ \t]*>)+/gm, "$1")
    .replace(/^[ \t]{129,}(?=\S)/gm, (indent) => indent.slice(0, 128))
    .replace(/([*_[\]()~`<>])\1{64,}/g, (run) => run.slice(0, 64))
  try {
    return chunks(bounded).flatMap((chunk) => lexer(chunk, { gfm: true }))
  } catch {
    return undefined
  }
}

function blocks(tokens: readonly Token[], limits: BrainLimits.Limits, links: string[], depth: number) {
  const drafts: Draft[] = []
  const state = { truncated: false, flagged: [] as number[], steering: [] as number[] }
  for (const token of tokens) {
    // Markup the reader removes (a `<system>` tag, a comment) can carry what the text no longer shows, so the
    // instruction check also reads each block's source.
    if (token.type !== "code" && token.type !== "space" && BrainScan.instructionLike(token.raw, true))
      state.steering.push(Math.max(0, drafts.length - (token.type === "html" && /^\s*<!--/.test(token.raw) ? 1 : 0)))
    if (token.type === "heading") {
      const inline = fresh()
      drafts.push(
        mark(
          {
            type: "heading",
            level: (token as Tokens.Heading).depth,
            text: text((token as Tokens.Heading).tokens, inline, links),
          },
          inline,
        ),
      )
      continue
    }
    if (token.type === "paragraph") {
      const inline = fresh()
      const content = text((token as Tokens.Paragraph).tokens, inline, links)
      // MDX module lines are code, not prose.
      if (/^(?:import|export)\s[^\n]*(?:from\s|=)/.test(content)) continue
      drafts.push(mark({ type: "paragraph", text: content, code: inline.code }, inline))
      continue
    }
    if (token.type === "text") {
      const inline = fresh()
      drafts.push(
        mark(
          { type: "paragraph", text: text((token as Tokens.Text).tokens ?? [token], inline, links), code: inline.code },
          inline,
        ),
      )
      continue
    }
    if (token.type === "code") {
      const code = token as Tokens.Code
      drafts.push({ type: "code", text: code.text, ...(code.lang ? { language: code.lang.split(/\s/)[0]! } : {}) })
      continue
    }
    if (token.type === "blockquote") {
      const inner = blocks((token as Tokens.Blockquote).tokens, limits, links, depth + 1)
      const hidden = inner.drafts.some((draft) => draft.hidden)
      const quoted = inner.drafts.map(plain).filter(Boolean).join("\n")
      if (quoted) drafts.push({ type: "quote", text: quoted, ...(hidden ? { hidden: true } : {}) })
      continue
    }
    if (token.type === "list") {
      const items = list(token as Tokens.List, 0, links)
      drafts.push({
        type: "list",
        ordered: (token as Tokens.List).ordered,
        items: items.items,
        ...(items.hidden ? { hidden: true } : {}),
      })
      drafts.push(...items.code)
      continue
    }
    if (token.type === "table") {
      const table = token as Tokens.Table
      const inline = fresh()
      const cells = (row: readonly Tokens.TableCell[]) => row.map((cell) => text(cell.tokens, inline, links))
      const header = cells(table.header)
      const rows = table.rows.map(cells)
      drafts.push(mark({ type: "table", header, rows, confidence: 1 }, inline))
      continue
    }
    if (token.type === "html" && depth < 2) {
      const html = (token as Tokens.HTML).text
      if (/^\s*<!--[\s\S]*-->\s*$/.test(html)) continue
      const converted = BrainHtml.fragment(html, limits)
      links.push(...converted.links)
      if (converted.truncated) state.truncated = true
      drafts.push(...converted.drafts)
      // Hidden HTML with nothing visible beside it flags the block before it, or the next one at the very start.
      if (converted.dropped) state.flagged.push(Math.max(0, drafts.length - 1))
    }
  }
  return {
    drafts: drafts.map((draft, index) => ({
      ...draft,
      ...(state.flagged.includes(index) ? { hidden: true } : {}),
      ...(state.steering.includes(index) ? { instruction: true } : {}),
    })),
    truncated: state.truncated,
  }
}

function list(token: Tokens.List, level: number, links: string[]) {
  const out = { items: [] as { text: string; depth: number; code: string[] }[], code: [] as Draft[], hidden: false }
  for (const item of token.items) {
    const inline = fresh()
    const own = item.tokens.filter((child) => child.type !== "list" && child.type !== "code")
    const content = own
      .map((child) => text("tokens" in child && child.tokens ? child.tokens : [child], inline, links))
      .join(" ")
      .trim()
    if (inline.hidden) out.hidden = true
    if (content) out.items.push({ text: content, depth: level, code: inline.code })
    for (const child of item.tokens) {
      if (child.type === "code") {
        const code = child as Tokens.Code
        out.code.push({ type: "code", text: code.text, ...(code.lang ? { language: code.lang.split(/\s/)[0]! } : {}) })
      }
      if (child.type !== "list") continue
      const nested = list(child as Tokens.List, level + 1, links)
      out.items.push(...nested.items)
      out.code.push(...nested.code)
      if (nested.hidden) out.hidden = true
    }
  }
  return out
}

function fresh(): Inline {
  return { code: [], links: [], hidden: false, hiding: 0 }
}

function mark(draft: Draft, inline: Inline): Draft {
  return inline.hidden ? { ...draft, hidden: true } : draft
}

const INVISIBLE =
  /\bhidden\b|display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|font-size\s*:\s*0(?![.\d]*[1-9])|opacity\s*:\s*0(?![.\d]*[1-9])/i

// Inline tokens as plain text. Inline HTML that hides what follows it (a `<span hidden>` or `style="display:none"`)
// drops the text up to its closing tag and flags the block.
function text(tokens: readonly Token[], inline: Inline, links: string[]): string {
  return spans(tokens, inline, links).replace(/[ \t]{2,}/g, " ")
}

function spans(tokens: readonly Token[], inline: Inline, links: string[]): string {
  return tokens
    .map((token): string => {
      if (token.type === "html") {
        const tag = (token as Tokens.Tag).text
        if (/^<!--/.test(tag)) return ""
        if (/^<\//.test(tag)) {
          if (inline.hiding > 0) inline.hiding--
          return ""
        }
        if (inline.hiding > 0 && !/\/>$/.test(tag)) inline.hiding++
        else if (/^<[a-z]/i.test(tag) && !/\/>$/.test(tag) && INVISIBLE.test(tag)) inline.hiding++
        return /^<br\b/i.test(tag) ? "\n" : ""
      }
      if (inline.hiding > 0) {
        if (plainOf(token).trim()) inline.hidden = true
        return ""
      }
      if (token.type === "codespan") {
        const code = entities((token as Tokens.Codespan).text)
        inline.code.push(code)
        return code
      }
      if (token.type === "link") {
        links.push((token as Tokens.Link).href)
        return text((token as Tokens.Link).tokens, inline, links)
      }
      if (token.type === "image") return (token as Tokens.Image).text
      if (token.type === "br") return "\n"
      if (token.type === "checkbox") return ""
      if (token.type === "escape") return (token as Tokens.Escape).text
      if ("tokens" in token && token.tokens && token.tokens.length > 0) return text(token.tokens, inline, links)
      return entities("text" in token && typeof token.text === "string" ? token.text : "")
    })
    .join("")
}

function plainOf(token: Token): string {
  if ("tokens" in token && token.tokens) return token.tokens.map(plainOf).join("")
  return "text" in token && typeof token.text === "string" ? token.text : ""
}

function plain(draft: Draft) {
  if (draft.type === "list") return draft.items.map((item) => item.text).join("\n")
  if (draft.type === "table") return [draft.header, ...draft.rows].map((row) => row.join(" | ")).join("\n")
  return draft.text
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" }

function entities(text: string) {
  return text.replace(/&(#\d{1,7}|#x[\da-f]{1,6}|[a-z]+\d*);/gi, (match, name: string) => {
    if (ENTITIES[name.toLowerCase()]) return ENTITIES[name.toLowerCase()]!
    const code =
      name.startsWith("#x") || name.startsWith("#X")
        ? Number.parseInt(name.slice(2), 16)
        : name.startsWith("#")
          ? Number(name.slice(1))
          : NaN
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
  })
}
