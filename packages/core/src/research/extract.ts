export * as ResearchExtract from "./extract"

import { DomUtils, parseDocument } from "htmlparser2"
import { Schema } from "effect"
import { ResearchCanonical } from "./canonical"
import { WebFence } from "./fence"

// What research needs from a page's HTML before the brain's reader turns its main content into blocks: which part of
// the page is the content, the page's own description of itself (title, author, dates, canonical address, structured
// data, identifiers), the links a reader of the content can follow, and whether the page is built by script, in which
// case its HTML holds next to nothing to read. Nothing is fetched and no script runs.

type Node = ReturnType<typeof parseDocument>["children"][number]
type Element = Extract<Node, { readonly attribs: Record<string, string> }>

export type Link = { readonly url: string; readonly text: string }

export type Ids = { readonly doi?: string; readonly arxiv?: string; readonly pmid?: string }

export type Page = {
  readonly title?: string
  readonly description?: string
  /** The page's rel=canonical, resolved against it; whether to follow it is canonical.ts's to decide. */
  readonly canonical?: string
  readonly author?: string
  /** YYYY-MM-DD. */
  readonly published?: string
  readonly updated?: string
  readonly siteName?: string
  /** Its JSON-LD blocks, parsed. */
  readonly structured: readonly unknown[]
  /** The HTML of the page's main content: its largest article or main element, or its body. */
  readonly main: string
  /** Links in the main content a reader can see, absolute, http or https only. */
  readonly links: readonly Link[]
  readonly ids: Ids
  /** It has a references or bibliography section. */
  readonly references: boolean
  /** It links to a data file or a data repository, or describes a data set. */
  readonly data: boolean
  /** Its HTML holds almost no text and the page is built by script, so only a browser can read it. */
  readonly scripted: boolean
}

// Below this many characters of visible text, a page with scripts is taken to be built by them.
const SCRIPTED_TEXT = 200
const MAX_LINKS = 300
const MAX_STRUCTURED = 20
const MAX_STRUCTURED_CHARS = 256 * 1024
const MAX_TEXT = 120

const NOT_CONTENT = new Set(["script", "style", "noscript", "template", "head", "svg", "math", "iframe", "object"])
const MOUNT = /^(?:root|app|__next|__nuxt|svelte|main-app|react-root)$/i
const REFERENCES =
  /^(?:\d+\.?\s*)?(?:references|bibliography|works cited|sources|citations|literature cited|notes and references)$/i
const DATA_FILE = /\.(?:csv|tsv|xlsx?|ods|json|jsonl|parquet|zip|nc|h5|hdf5|sav|dta|rds)(?:$|[?#])/i
const DATA_HOST =
  /(?:^|\.)(?:zenodo\.org|figshare\.com|datadryad\.org|dataverse\.harvard\.edu|osf\.io|data\.gov|data\.europa\.eu|kaggle\.com)$/i
const DOI = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export function extract(html: string, url: string): Page {
  const nodes = parse(html)
  const metas = DomUtils.findAll((node) => node.name === "meta", nodes)
  const meta = (...names: string[]) =>
    metas
      .find((node) =>
        names.includes((node.attribs.name ?? node.attribs.property ?? node.attribs.itemprop ?? "").toLowerCase()),
      )
      ?.attribs.content?.trim() || undefined
  const structured = DomUtils.findAll(
    (node) => node.name === "script" && (node.attribs.type ?? "").toLowerCase() === "application/ld+json",
    nodes,
  )
    .slice(0, MAX_STRUCTURED)
    .flatMap((node) => {
      const source = DomUtils.textContent(node)
      if (source.length > MAX_STRUCTURED_CHARS) return []
      const parsed = decodeJson(source)
      if (parsed._tag === "None") return []
      return Array.isArray(parsed.value) ? parsed.value : [parsed.value]
    })
  const graph = structured.flatMap((item) =>
    item && typeof item === "object" && Array.isArray((item as Record<string, unknown>)["@graph"])
      ? ((item as Record<string, unknown>)["@graph"] as unknown[])
      : [item],
  )
  const body = DomUtils.findOne((node) => node.name === "body", nodes, true)
  const content = main(body ? [body] : nodes)
  const visible = oneLine(textOf(body ? [body] : nodes))
  const links = linksOf(content ? [content] : nodes, url)
  const canonicalLink = DomUtils.findAll(
    (node) => node.name === "link" && /(?:^|\s)canonical(?:\s|$)/i.test(node.attribs.rel ?? "") && !!node.attribs.href,
    nodes,
  ).at(0)?.attribs.href
  const headings = DomUtils.findAll((node) => /^h[1-4]$/.test(node.name), nodes).map((node) =>
    oneLine(DomUtils.textContent(node)),
  )
  const titleNode = DomUtils.findOne((node) => node.name === "title", nodes, true)
  const scripts = DomUtils.findAll((node) => node.name === "script", nodes)
  const mount = DomUtils.findOne(
    (node) => MOUNT.test(node.attribs.id ?? "") || "data-reactroot" in node.attribs,
    body ? [body] : nodes,
    true,
  )
  const noscript = DomUtils.findAll((node) => node.name === "noscript", nodes).some((node) =>
    /javascript/i.test(DomUtils.textContent(node)),
  )
  const executable = scripts.filter((node) => !/ld\+json|json|template/i.test(node.attribs.type ?? ""))
  return {
    title: oneLine(titleNode ? DomUtils.textContent(titleNode) : "") || meta("og:title") || headings.at(0) || undefined,
    description: meta("description", "og:description"),
    canonical: canonicalLink && URL.canParse(canonicalLink, url) ? new URL(canonicalLink, url).toString() : undefined,
    author: author(meta("author", "citation_author", "dc.creator", "article:author"), graph),
    published: date(
      meta(
        "article:published_time",
        "citation_publication_date",
        "citation_date",
        "dc.date",
        "date",
        "pubdate",
        "datepublished",
        "og:published_time",
      ) ??
        field(graph, "datePublished") ??
        firstTime(content ? [content] : nodes),
    ),
    updated: date(meta("article:modified_time", "og:updated_time", "datemodified") ?? field(graph, "dateModified")),
    siteName: meta("og:site_name"),
    structured,
    main: content ? DomUtils.getOuterHTML(content) : html,
    links,
    ids: ids(url, meta, graph),
    references:
      headings.some((heading) => REFERENCES.test(heading)) ||
      metas.filter((node) => (node.attribs.name ?? "").toLowerCase() === "citation_reference").length >= 3,
    data:
      links.some((link) => DATA_FILE.test(new URL(link.url).pathname) || DATA_HOST.test(new URL(link.url).hostname)) ||
      graph.some((item) => typeOf(item).includes("dataset")),
    scripted:
      visible.length < SCRIPTED_TEXT &&
      (!!mount ||
        noscript ||
        executable.some((node) => !!node.attribs.src || DomUtils.textContent(node).length > 1_000)),
  }
}

// The parser builds any depth without recursing, but reading a tree does recurse, so it is cut first, as the brain's
// HTML reader cuts it: below DEPTH levels, or past NODES nodes, nothing is kept.
const DEPTH = 256
const NODES = 2_000_000

function parse(html: string) {
  const document = parseDocument(html, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true })
  const stack: { node: Node; depth: number }[] = document.children.map((node) => ({ node, depth: 0 }))
  const state = { nodes: 0 }
  while (stack.length > 0) {
    const item = stack.pop()!
    state.nodes++
    if (!DomUtils.hasChildren(item.node) || item.node.children.length === 0) continue
    if (item.depth >= DEPTH || state.nodes > NODES) {
      item.node.children = []
      continue
    }
    for (const child of item.node.children) stack.push({ node: child, depth: item.depth + 1 })
  }
  return document.children
}

// The content element: the largest article, main or role=main element when it holds at least 40% of the body's text,
// articles first on a tie; otherwise the body itself.
function main(nodes: Node[]) {
  const candidates = [
    ...DomUtils.findAll((node) => node.name === "article", nodes),
    ...DomUtils.findAll((node) => node.name === "main" || (node.attribs.role ?? "").toLowerCase() === "main", nodes),
  ]
  const total = textOf(nodes).length
  const best = candidates
    .map((node) => ({ node, size: textOf([node]).length }))
    .toSorted((left, right) => right.size - left.size)
    .at(0)
  if (best && best.size >= total * 0.4) return best.node
  return nodes.find((node): node is Element => DomUtils.isTag(node))
}

// Text a reader of the page would see: no scripts, styles or hidden elements.
function textOf(nodes: readonly Node[]): string {
  return nodes
    .map((node) => {
      if (DomUtils.isText(node)) return node.data
      if (!DomUtils.isTag(node) || NOT_CONTENT.has(node.name) || hidden(node)) return ""
      return ` ${textOf(node.children)} `
    })
    .join("")
}

function linksOf(nodes: readonly Node[], base: string) {
  const seen = new Set<string>()
  const out: Link[] = []
  const walk = (node: Node) => {
    if (out.length >= MAX_LINKS || !DomUtils.isTag(node) || NOT_CONTENT.has(node.name) || hidden(node)) return
    const href = node.name === "a" ? node.attribs.href?.trim() : undefined
    if (href && URL.canParse(href, base)) {
      const target = new URL(href, base)
      target.hash = ""
      const address = target.toString()
      if ((target.protocol === "http:" || target.protocol === "https:") && !seen.has(address)) {
        seen.add(address)
        out.push({ url: address, text: oneLine(DomUtils.textContent(node)).slice(0, MAX_TEXT) })
      }
    }
    for (const child of node.children) walk(child)
  }
  for (const node of nodes) walk(node)
  return out
}

function hidden(node: Element) {
  return WebFence.invisible({ hidden: "hidden" in node.attribs, style: node.attribs.style })
}

/** The identifiers an address gives on its own: a DOI in a doi.org or /doi/ path, an arXiv or a PubMed ID. */
export function addressIds(url: string) {
  return ids(url, () => undefined, [])
}

function ids(url: string, meta: (...names: string[]) => string | undefined, graph: readonly unknown[]): Ids {
  const address = new URL(url)
  const declared =
    meta("citation_doi", "dc.identifier", "prism.doi", "bepress_citation_doi") ?? field(graph, "identifier")
  const doi = (DOI.exec(declared ?? "") ??
    (/(?:^|\.)doi\.org$/.test(address.hostname) || /\/doi\//.test(address.pathname)
      ? DOI.exec(ResearchCanonical.decoded(address.pathname))
      : null))?.[1]?.replace(/[.,;)]+$/, "")
  const arxiv =
    meta("citation_arxiv_id") ??
    (/(?:^|\.)arxiv\.org$/.test(address.hostname)
      ? /\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?)/.exec(address.pathname)?.[1]
      : undefined)
  const pmid =
    meta("citation_pmid") ??
    (address.hostname === "pubmed.ncbi.nlm.nih.gov" ? /^\/(\d{5,9})\/?$/.exec(address.pathname)?.[1] : undefined)
  return { ...(doi ? { doi } : {}), ...(arxiv ? { arxiv } : {}), ...(pmid ? { pmid } : {}) }
}

function author(declared: string | undefined, graph: readonly unknown[]) {
  const named = (value: unknown): string | undefined => {
    if (typeof value === "string") return value
    if (Array.isArray(value)) return value.map(named).filter(Boolean).join(", ") || undefined
    if (value && typeof value === "object") return named((value as Record<string, unknown>).name)
    return undefined
  }
  const found = [declared, ...graph.map((item) => named(field([item], "author", true)))].find(
    (value) => !!value && !/^https?:\/\//i.test(value),
  )
  return found ? oneLine(found).slice(0, MAX_TEXT) : undefined
}

// The first value of `key` in the structured data, as a string unless `raw` asks for the value as it is.
function field(graph: readonly unknown[], key: string): string | undefined
function field(graph: readonly unknown[], key: string, raw: true): unknown
function field(graph: readonly unknown[], key: string, raw = false): unknown {
  for (const item of graph) {
    if (!item || typeof item !== "object") continue
    const value = (item as Record<string, unknown>)[key]
    if (value === undefined) continue
    if (raw) return value
    if (typeof value === "string") return value
  }
  return undefined
}

function typeOf(item: unknown) {
  if (!item || typeof item !== "object") return []
  const type = (item as Record<string, unknown>)["@type"]
  return (Array.isArray(type) ? type : [type])
    .filter((value) => typeof value === "string")
    .map((value) => value.toLowerCase())
}

function firstTime(nodes: Node[]) {
  return DomUtils.findOne((node) => node.name === "time" && !!node.attribs.datetime, nodes, true)?.attribs.datetime
}

// A date as YYYY-MM-DD, when it reads as one between 1900 and next year.
function date(value: string | undefined) {
  if (!value) return undefined
  const parsed = Date.parse(value.trim())
  if (Number.isNaN(parsed)) return undefined
  const year = new Date(parsed).getUTCFullYear()
  if (year < 1900 || year > new Date().getUTCFullYear() + 1) return undefined
  return new Date(parsed).toISOString().slice(0, 10)
}

function oneLine(text: string) {
  return text.replace(/\s+/g, " ").trim()
}
