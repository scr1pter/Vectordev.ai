import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Parser } from "htmlparser2"
import { Tool } from "./tool"
import { Truncate } from "./truncate"
import { Config } from "@/config/config"
import { WebFetchRequest } from "@vectordevai/core/util/webfetch-request"
import { collectBoundedResponseBody } from "@vectordevai/core/tool/http-body"
import { WebFence } from "@vectordevai/core/research/fence"
import DESCRIPTION from "./webfetch.txt"
import { isImageAttachment } from "@/util/media"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
const DEFAULT_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_TIMEOUT = 120 * 1000 // 2 minutes
// A converted page is read once and rarely needed whole; the rest stays in the saved file for Grep/Read.
const MAX_PAGE_BYTES = 20 * 1024

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({ description: "The URL to fetch content from" }),
  format: Schema.Literals(["text", "markdown", "html"])
    .annotate({
      description: "The format to return the content in (text, markdown, or html). Defaults to markdown.",
      default: "markdown",
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed("markdown" as const))),
  timeout: Schema.optional(Schema.Number).annotate({ description: "Optional timeout in seconds (max 120)" }),
})

export const WebFetchTool = Tool.define(
  "webfetch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const truncate = yield* Truncate.Service
    const config = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
            throw new Error("URL must start with http:// or https://")
          }

          const timeout = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT)

          // Build Accept header based on requested format with q parameters for fallbacks
          let acceptHeader = "*/*"
          switch (params.format) {
            case "markdown":
              acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
              break
            case "text":
              acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
              break
            case "html":
              acceptHeader =
                "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
              break
            default:
              acceptHeader =
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
          }
          const headers = {
            Accept: acceptHeader,
            "Accept-Language": "en-US,en;q=0.9",
          }

          const request = HttpClientRequest.get(params.url).pipe(HttpClientRequest.setHeaders(headers))

          const { response, body } = yield* Effect.gen(function* () {
            const response = yield* WebFetchRequest.execute(http, request, {
              // "Always allow" covers the site asked about, never every site.
              authorize: (url) =>
                ctx.ask({
                  permission: "webfetch",
                  patterns: [url],
                  always: siteAlways(url),
                  metadata: {
                    url,
                    format: params.format,
                    timeout: params.timeout,
                  },
                }),
              // A dev server, an intranet page or a cloud metadata address is reached only with its own approval,
              // since a model reading a hostile page could otherwise be steered into the user's network.
              authorizePrivate: (url) =>
                ctx.ask({
                  permission: "private_network",
                  patterns: [new URL(url).origin],
                  always: [new URL(url).origin],
                  metadata: { url },
                }),
            })
            const body = yield* collectBoundedResponseBody(
              response,
              MAX_RESPONSE_SIZE,
              () => new Error("Response too large (exceeds 5MB limit)"),
            )
            return { response, body }
          }).pipe(
            Effect.scoped,
            Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.die(new Error("Request timed out")) }),
          )

          const contentType = response.headers["content-type"] || ""
          const mime = contentType.split(";")[0]?.trim().toLowerCase() || ""
          const title = `${params.url} (${contentType})`

          if (isImageAttachment(mime)) {
            const base64Content = body.toString("base64")
            return {
              title,
              output: "Image fetched successfully",
              metadata: {},
              attachments: [
                {
                  type: "file" as const,
                  mime,
                  url: `data:${mime};base64,${base64Content}`,
                },
              ],
            }
          }

          const pdf = mime === "application/pdf" || body.subarray(0, 5).toString("latin1") === "%PDF-"
          // A PDF is read within the fetch's own time limit, so a file that makes the reader run long stops there.
          const content = pdf
            ? yield* Effect.promise(() => readPdf(body, AbortSignal.any([ctx.abort, AbortSignal.timeout(timeout)])))
            : new TextDecoder().decode(body)
          const converted = !pdf && params.format !== "html" && contentType.includes("text/html")
          const text = WebFence.clean(
            converted
              ? params.format === "markdown"
                ? yield* Effect.promise(() => convertHTMLToMarkdown(content, params.url))
                : extractTextFromHTML(content)
              : content,
          )
          // A converted page or a PDF is read once and rarely needed whole; anything else keeps the usual limits. A
          // configured tool_output.max_bytes still decides, as it does for shell. The whole page is saved in a fence of
          // its own, escaped and flagged as the preview is, and Grep and Read fence what they show from it again.
          const fence = (preview: string) => WebFence.fenceWebPage({ url: params.url, tool: "webfetch" }, preview)
          const limits =
            converted || pdf ? { maxBytes: (yield* config.get()).tool_output?.max_bytes ?? MAX_PAGE_BYTES } : {}
          const page = yield* truncate.output(text, { ...limits, save: () => fence(text) })
          return {
            output: page.truncated ? fenceTruncated(page.content, text, fence) : fence(page.content),
            title,
            metadata: { truncated: page.truncated, ...(page.truncated && { outputPath: page.outputPath }) },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// The origin of a URL as the permission patterns an "Always allow" saves: the site itself and every page on it.
function siteAlways(url: string) {
  const origin = new URL(url).origin
  return [origin, `${origin}/*`]
}

// Truncate returns the start of the page and then its own note about where the rest was saved. The note is Vector's,
// so it goes after the fence; it starts at the last "truncated" marker whose text before it is the page's own start.
function fenceTruncated(content: string, page: string, fence: (preview: string) => string) {
  const cut = [...content.matchAll(/\n\n\.\.\.\d+ (?:bytes|lines) truncated\.\.\.\n\n/g)]
    .map((match) => match.index)
    .filter((index) => page.startsWith(content.slice(0, index)))
    .at(-1)
  if (cut === undefined) return fence(content)
  return `${fence(content.slice(0, cut))}\n\n${content.slice(cut + 2)}`
}

// A PDF's text through the brain's reader, which runs no script and fetches nothing, under a heading for each page.
// The reader runs on this thread, with the inline limits and a turn for the event loop after every page, and stops
// when `signal` does.
export async function readPdf(bytes: Uint8Array, signal: AbortSignal) {
  const stoppedMessage = "Vector stopped reading this PDF: it took longer than the fetch's time limit."
  if (signal.aborted) return stoppedMessage
  const { BrainDocument } = await import("@vectordevai/core/brain/document/read")
  const { BrainLimits } = await import("@vectordevai/core/brain/document/limits")
  const stopped = new Promise<"stopped">((resolve) =>
    signal.addEventListener("abort", () => resolve("stopped"), { once: true }),
  )
  // pdf.js refuses a Node Buffer, so the reader gets plain bytes.
  const read = await Promise.race([
    BrainDocument.read(
      { name: "page.pdf", bytes: new Uint8Array(bytes), mime: "application/pdf" },
      BrainLimits.LIMITS.inline,
      signal,
    ),
    stopped,
  ])
  if (read === "stopped") return stoppedMessage
  if (read.type === "refused") return `This PDF could not be read: ${read.message}`
  const pages = Map.groupBy(read.blocks, (block) => block.span.page ?? 1)
  const head = [
    `PDF: ${read.title || "Untitled"}, ${read.pages ?? pages.size} page${(read.pages ?? pages.size) === 1 ? "" : "s"}`,
    read.unread.length > 0 ? `Pages with no text Vector can read: ${read.unread.join(", ")}` : undefined,
    read.warnings.includes("truncated") ? "Only the start of this PDF was read." : undefined,
  ].filter((line): line is string => line !== undefined)
  const body = [...pages.entries()].map(
    ([page, blocks]) =>
      `[Page ${page}]\n${blocks.map((block) => read.text.slice(block.span.start, block.span.end)).join("\n\n")}`,
  )
  return [head.join("\n"), ...body].join("\n\n")
}

function extractTextFromHTML(html: string) {
  let text = ""
  let skipDepth = 0

  const parser = new Parser({
    onopentag(name, attributes) {
      if (
        skipDepth > 0 ||
        ["script", "style", "noscript", "iframe", "object", "embed"].includes(name) ||
        WebFence.invisible({ hidden: "hidden" in attributes, style: attributes.style })
      ) {
        skipDepth++
      }
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--
    },
  })

  parser.write(html)
  parser.end()

  return text.trim()
}

// Turndown brings a whole DOM implementation, so it loads on the first page converted to markdown.
async function convertHTMLToMarkdown(html: string, base: string) {
  const { default: TurndownService } = await import("turndown")
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  // Page chrome and markup that has no text worth reading costs tokens on every fetch. Forms and buttons stay: some
  // frameworks wrap the whole page in a form, and accordions put their questions in buttons.
  turndownService.remove([
    "script",
    "style",
    "meta",
    "link",
    "nav",
    "footer",
    "aside",
    "noscript",
    "iframe",
    "input",
    "select",
    "textarea",
  ])
  turndownService.remove((node) => node.nodeName.toLowerCase() === "svg")
  turndownService.addRule("image", {
    filter: "img",
    replacement: (_content, node) => {
      const alt = (node as HTMLElement).getAttribute("alt")?.trim()
      return alt ? `[image: ${alt}]` : ""
    },
  })
  // Links are resolved against the page, so the model can fetch the target; in-page and script links keep only text.
  turndownService.addRule("link", {
    filter: "a",
    replacement: (content, node) => {
      const href = (node as HTMLElement).getAttribute("href")?.trim()
      const target = href && !href.startsWith("#") && URL.canParse(href, base) ? new URL(href, base) : undefined
      return target && (target.protocol === "http:" || target.protocol === "https:")
        ? `[${content}](${target.href})`
        : content
    },
  })
  // Text a person reading the page would not see is left out, so it cannot speak to the agent unseen. Added last, it
  // runs before every other rule, the link and image rules included.
  turndownService.addRule("hidden", {
    filter: (node) => WebFence.invisible({ hidden: node.hasAttribute("hidden"), style: node.getAttribute("style") }),
    replacement: () => "",
  })
  return turndownService.turndown(html)
}
