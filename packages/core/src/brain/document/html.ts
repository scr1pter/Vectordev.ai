export * as BrainHtml from "./html"

import { DomUtils, parseDocument } from "htmlparser2"
import { BrainScan } from "../scan"
import type { BrainLimits } from "./limits"
import type { Draft, Read } from "./read"

// HTML is read from its parsed tree straight into blocks. Nothing is loaded: no script runs, no stylesheet, image or
// frame is fetched. Page chrome (navigation, sidebars, footers) and code are dropped; text a reader of the page would not
// see (`hidden`, `display: none`, `visibility: hidden`, a zero font size or opacity) is dropped too, and the block where
// it sat is flagged so the passage around it waits for the user.

type Node = ReturnType<typeof parseDocument>["children"][number]
type Element = Extract<Node, { readonly attribs: Record<string, string> }>

const SKIPPED = new Set([
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "template",
  "noscript",
  "nav",
  "aside",
  "footer",
  "svg",
  "math",
  "canvas",
  "head",
  "button",
  "select",
  "input",
  "textarea",
  "audio",
  "video",
  "map",
  "dialog",
])

const BLOCKS = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "body",
  "html",
  "header",
  "figure",
  "figcaption",
  "address",
  "details",
  "summary",
  "form",
  "fieldset",
  "legend",
  "center",
  "hgroup",
])

const INVISIBLE =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|font-size\s*:\s*0(?:\.0+)?(?:px|pt|em|rem|%)?\s*(?:;|$|!)|opacity\s*:\s*0(?:\.0+)?\s*(?:;|$|!))/i

export function read(html: string, limits: BrainLimits.Limits): Read {
  const parsed = parse(html, limits)
  const title = DomUtils.findOne((node) => node.name === "title", parsed.nodes, true)
  const converted = drafts(parsed.nodes, limits)
  return {
    type: "read",
    format: "html",
    ...(title ? { title: DomUtils.textContent(title) } : {}),
    drafts: converted.drafts,
    links: converted.links,
    warnings: converted.truncated || parsed.truncated ? ["truncated"] : [],
  }
}

/** Blocks from parsed HTML, for a page or for raw HTML inside Markdown. */
export function fragment(html: string, limits: BrainLimits.Limits) {
  const parsed = parse(html, limits)
  const converted = drafts(parsed.nodes, limits)
  return { ...converted, truncated: converted.truncated || parsed.truncated }
}

// The parser builds any depth without recursing, but walking a tree does recurse, so the tree is cut at the depth and
// node caps before anything reads it: below 256 levels, or past 2 million nodes, nothing is kept.
function parse(html: string, limits: BrainLimits.Limits) {
  const document = parseDocument(html, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true })
  const stack: { node: Node; depth: number }[] = document.children.map((node) => ({ node, depth: 0 }))
  const state = { nodes: 0, truncated: false }
  while (stack.length > 0) {
    const item = stack.pop()!
    state.nodes++
    if (!DomUtils.hasChildren(item.node) || item.node.children.length === 0) continue
    if (item.depth >= limits.xml.depth || state.nodes > limits.xml.nodes) {
      item.node.children = []
      state.truncated = true
      continue
    }
    for (const child of item.node.children) stack.push({ node: child, depth: item.depth + 1 })
  }
  return { nodes: document.children, truncated: state.truncated }
}

function drafts(nodes: readonly Node[], limits: BrainLimits.Limits) {
  const out = {
    drafts: [] as Draft[],
    links: [] as string[],
    inline: { text: "", code: [] as string[], hidden: false },
    hidden: false,
    /** Hidden text dropped from inside the block being read. */
    dropped: false,
    nodes: 0,
    truncated: false,
  }
  const flush = () => {
    const text = out.inline.text
      .replace(/[ \t\f\v ]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .trim()
    if (text) {
      out.drafts.push({
        type: "paragraph",
        text,
        code: out.inline.code,
        ...(out.inline.hidden || out.hidden ? { hidden: true } : {}),
      })
      out.hidden = false
    }
    // Hidden text with nothing visible left beside it marks the block that follows.
    else if (out.inline.hidden) out.hidden = true
    out.inline = { text: "", code: [], hidden: false }
  }
  const push = (draft: Draft) => {
    flush()
    out.drafts.push(out.hidden || out.dropped ? { ...draft, hidden: true } : draft)
    out.hidden = false
    out.dropped = false
  }
  const text = (node: Node): string => {
    if (DomUtils.isText(node)) return node.data
    if (!DomUtils.isTag(node) || SKIPPED.has(node.name)) return ""
    if (invisible(node)) {
      if (DomUtils.textContent(node).trim()) out.dropped = true
      return ""
    }
    if (node.name === "br") return "\n"
    return node.children.map(text).join("")
  }
  const walk = (node: Node, depth: number, inside: { readonly article: boolean }) => {
    out.nodes++
    if (depth > limits.xml.depth || out.nodes > limits.xml.nodes) {
      out.truncated = true
      return
    }
    if (DomUtils.isText(node)) {
      out.inline.text += node.data
      return
    }
    // A comment is text no reader of the page sees; one that reads as instructions is flagged where it sat.
    if (DomUtils.isComment(node)) {
      if (BrainScan.instructionLike(node.data, true)) out.inline.hidden = true
      return
    }
    if (!DomUtils.isTag(node)) return
    const name = node.name
    if (SKIPPED.has(name) || (name === "header" && !inside.article)) return
    if (invisible(node)) {
      if (DomUtils.textContent(node).trim()) out.inline.hidden = true
      return
    }
    if (name === "a" && node.attribs.href) out.links.push(node.attribs.href)
    if (/^h[1-6]$/.test(name)) return push({ type: "heading", level: Number(name[1]), text: oneLine(text(node)) })
    if (name === "br") {
      out.inline.text += "\n"
      return
    }
    if (name === "img") {
      out.inline.text += node.attribs.alt ? ` ${node.attribs.alt} ` : ""
      return
    }
    if (name === "code" || name === "kbd" || name === "samp") {
      const code = text(node)
      out.inline.code.push(code.trim())
      out.inline.text += code
      return
    }
    if (name === "pre") {
      const code = DomUtils.findOne((child) => child.name === "code", node.children, false)
      const language = `${node.attribs.class ?? ""} ${code?.attribs.class ?? ""}`.match(
        /(?:language|lang)-([\w+-]+)/,
      )?.[1]
      return push({
        type: "code",
        text: text(node).replace(/^\n/, "").replace(/\s+$/, ""),
        ...(language ? { language } : {}),
      })
    }
    if (name === "blockquote") return push({ type: "quote", text: oneLine(text(node)) })
    if (name === "ul" || name === "ol" || name === "menu") {
      const items = list(node, 0, text)
      return items.length > 0 ? push({ type: "list", ordered: name === "ol", items }) : undefined
    }
    if (name === "table") {
      const rows = DomUtils.findAll((child) => child.name === "tr", node.children).map((row) =>
        row.children.filter(
          (cell): cell is Element => DomUtils.isTag(cell) && (cell.name === "td" || cell.name === "th"),
        ),
      )
      const header = rows[0]?.every((cell) => cell.name === "th") ? rows[0] : undefined
      const cells = (row: readonly Element[]) => row.map((cell) => oneLine(text(cell)))
      return push({
        type: "table",
        header: header ? cells(header) : [],
        rows: rows.slice(header ? 1 : 0).map(cells),
        confidence: 1,
      })
    }
    if (name === "dl") {
      const terms = node.children.filter(
        (child): child is Element => DomUtils.isTag(child) && (child.name === "dt" || child.name === "dd"),
      )
      for (const [index, term] of terms.entries()) {
        const definition = terms[index + 1]
        if (term.name !== "dt") continue
        push({
          type: "paragraph",
          text: `${oneLine(text(term))}${definition?.name === "dd" ? `: ${oneLine(text(definition))}` : ""}`,
        })
      }
      return
    }
    if (name === "li" || name === "dt" || name === "dd" || BLOCKS.has(name) || name === "hr" || name === "tr") flush()
    const article = inside.article || name === "article" || name === "main" || name === "section"
    for (const child of node.children) walk(child, depth + 1, { article })
    if (name === "li" || name === "dt" || name === "dd" || BLOCKS.has(name) || name === "tr") flush()
  }
  for (const node of nodes) walk(node, 0, { article: false })
  flush()
  return {
    drafts: out.drafts,
    links: out.links.filter((link) => /^(?:https?|mailto):/i.test(link)),
    truncated: out.truncated,
    /** Hidden text with no visible block after it to flag. */
    dropped: out.hidden || out.dropped,
  }
}

function list(
  node: Element,
  depth: number,
  text: (node: Node) => string,
): { text: string; depth: number; code: string[] }[] {
  return node.children.flatMap((child) => {
    if (!DomUtils.isTag(child) || child.name !== "li") return []
    if (invisible(child)) {
      // A hidden item reads as nothing; `text` notes the text it drops, so the list is flagged.
      text(child)
      return []
    }
    const nested = child.children.filter(
      (inner): inner is Element => DomUtils.isTag(inner) && (inner.name === "ul" || inner.name === "ol"),
    )
    const children = child.children.filter((inner) => !nested.includes(inner as Element))
    const own = oneLine(children.map(text).join(""))
    const code = DomUtils.findAll(
      (inner) => inner.name === "code" || inner.name === "kbd" || inner.name === "samp",
      children,
    ).map((inner) => oneLine(text(inner)))
    return [...(own ? [{ text: own, depth, code }] : []), ...nested.flatMap((inner) => list(inner, depth + 1, text))]
  })
}

function invisible(node: Element) {
  return "hidden" in node.attribs || INVISIBLE.test(node.attribs.style ?? "")
}

function oneLine(text: string) {
  return text.replace(/\s+/g, " ").trim()
}
