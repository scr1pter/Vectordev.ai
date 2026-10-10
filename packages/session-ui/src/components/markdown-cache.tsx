import { checksum } from "@vectordevai/core/util/encode"
import DOMPurify from "dompurify"
import { project } from "./markdown-stream"

export type MarkdownCacheEntry = {
  raw: string
  hash: string
  html: string
}

const max = 200
const cache = new Map<string, MarkdownCacheEntry>()
const networkTags = [
  "audio",
  "base",
  "embed",
  "frame",
  "iframe",
  "img",
  "input",
  "link",
  "meta",
  "object",
  "picture",
  "source",
  "track",
  "video",
]
const networkAttributes = new Set([
  "action",
  "background",
  "data",
  "formaction",
  "manifest",
  "ping",
  "poster",
  "src",
  "srcdoc",
  "srcset",
  "style",
  "xlink:href",
])
const networkTagPattern = new RegExp(`<\\s*\\/?\\s*(?:${networkTags.join("|")})\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, "gi")
const openingTagPattern = /<\s*([a-z][\w:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi
const networkAttributePattern = new RegExp(
  `\\s+(?:${[...networkAttributes].map((name) => name.replace(":", "\\s*:\\s*")).join("|")})\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`,
  "gi",
)
const hrefAttributePattern = /\s+(?:href|xlink\s*:\s*href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi
const config = {
  USE_PROFILES: { html: true, mathMl: true },
  SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ["style", ...networkTags],
  FORBID_ATTR: [...networkAttributes],
  FORBID_CONTENTS: ["style", "script"],
  ADD_TAGS: ["svg", "path"],
  ADD_ATTR: ["d", "viewBox", "preserveAspectRatio", "xmlns", "target"],
}

if (typeof window !== "undefined" && DOMPurify.isSupported) {
  DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase()
      if (networkAttributes.has(name) || (name === "href" && !(node instanceof HTMLAnchorElement))) {
        node.removeAttribute(attribute.name)
      }
    }

    if (!(node instanceof HTMLAnchorElement)) return
    const href = node.getAttribute("href")
    if (!href) return

    try {
      const url = new URL(href, document.baseURI)
      if (url.protocol !== "http:" && url.protocol !== "https:" && !href.startsWith("#")) {
        node.removeAttribute("href")
        node.removeAttribute("target")
        node.removeAttribute("rel")
        return
      }
    } catch {
      node.removeAttribute("href")
      node.removeAttribute("target")
      node.removeAttribute("rel")
      return
    }

    const rel = node.getAttribute("rel") ?? ""
    const set = new Set(rel.split(/\s+/).filter(Boolean))
    set.add("noopener")
    set.add("noreferrer")
    node.setAttribute("rel", Array.from(set).join(" "))
    if (!href.startsWith("#")) node.setAttribute("target", "_blank")
  })
}

export function sanitizeMarkdown(html: string) {
  if (!DOMPurify.isSupported) return ""
  return DOMPurify.sanitize(neutralizeNetworkMarkup(html), config)
}

export function neutralizeNetworkMarkup(html: string) {
  return html.replace(networkTagPattern, "").replace(openingTagPattern, (tag, name: string) => {
    const withoutNetworkAttributes = tag.replace(networkAttributePattern, "")
    return name.toLowerCase() === "a"
      ? withoutNetworkAttributes
      : withoutNetworkAttributes.replace(hrefAttributePattern, "")
  })
}

export function getCachedMarkdown(key: string) {
  return cache.get(key)
}

export function touchCachedMarkdown(key: string, value: MarkdownCacheEntry) {
  cache.delete(key)
  cache.set(key, value)

  if (cache.size <= max) return

  const first = cache.keys().next().value
  if (!first) return
  cache.delete(first)
}

export async function preloadMarkdown(
  text: string,
  cacheKey: string,
  parser: { parse(text: string): string | Promise<string> },
) {
  await Promise.all(
    project(undefined, text, false).blocks.map(async (block, index) => {
      if (block.mode === "code") return
      const key = `${cacheKey}:${index}:${block.mode}`
      const cached = getCachedMarkdown(key)
      if (cached?.raw === block.raw) {
        touchCachedMarkdown(key, cached)
        return
      }
      const hash = checksum(block.raw)
      if (!hash) return
      touchCachedMarkdown(key, {
        raw: block.raw,
        hash,
        html: sanitizeMarkdown(await Promise.resolve(parser.parse(block.src))),
      })
    }),
  )
}
