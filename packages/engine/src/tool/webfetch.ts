import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Parser } from "htmlparser2"
import { Tool } from "./tool"
import { Truncate } from "./truncate"
import { Config } from "@/config/config"
import { WebFetchRequest } from "@vectordevai/core/util/webfetch-request"
import { collectBoundedResponseBody } from "@vectordevai/core/tool/http-body"
import TurndownService from "turndown"
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

          yield* ctx.ask({
            permission: "webfetch",
            patterns: [params.url],
            always: ["*"],
            metadata: {
              url: params.url,
              format: params.format,
              timeout: params.timeout,
            },
          })

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
            const response = yield* WebFetchRequest.execute(http, request)
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

          const content = new TextDecoder().decode(body)

          if (params.format === "html" || !contentType.includes("text/html"))
            return { output: content, title, metadata: {} }
          const page = yield* truncate.output(
            params.format === "markdown" ? convertHTMLToMarkdown(content, params.url) : extractTextFromHTML(content),
            // A configured tool_output.max_bytes still decides, as it does for shell.
            { maxBytes: (yield* config.get()).tool_output?.max_bytes ?? MAX_PAGE_BYTES },
          )
          return {
            output: page.content,
            title,
            metadata: { truncated: page.truncated, ...(page.truncated && { outputPath: page.outputPath }) },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function extractTextFromHTML(html: string) {
  let text = ""
  let skipDepth = 0

  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) {
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

function convertHTMLToMarkdown(html: string, base: string): string {
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
  return turndownService.turndown(html)
}
