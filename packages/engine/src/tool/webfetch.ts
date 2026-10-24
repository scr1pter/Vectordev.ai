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
import { Egress } from "@vectordevai/core/local-mode/egress"
import { EgressGuard } from "@vectordevai/core/local-mode/guard"
import { EgressHttpClient } from "@vectordevai/core/local-mode/http-client"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { SessionMemory } from "../session/memory"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import type { SessionV1 } from "@vectordevai/core/v1/session"

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

type Metadata = {
  truncated?: boolean
  outputPath?: string
  /** A hop reached the user's own computer or network. */
  private?: boolean
}

export const WebFetchTool = Tool.define(
  "webfetch",
  Effect.gen(function* () {
    // Every hop is decided and logged as webfetch while Vector Local is on (Web access, the site lists), and sent through
    // the pinned fetch WebFetchRequest provides.
    const http = EgressHttpClient.make(yield* HttpClient.HttpClient)
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
          webAccess("webfetch", params.url)
          // The address the model chose is checked once; a redirect's next address is the server's, not the model's.
          const strict = { first: yield* newAddress(params.url, ctx) }
          // Whether a hop reached the user's own computer or network: the page is then theirs, and research counts it
          // as private context, as it does a page research_read read there.
          const reached = { private: false }
          const marked = (): Metadata => (reached.private ? { private: true } : {})

          const { response, body } = yield* Effect.gen(function* () {
            const response = yield* WebFetchRequest.execute(http, request, {
              // "Always allow" covers the site asked about, never every site.
              authorize: (url) => {
                const after = strict.first
                strict.first = false
                return ctx.ask({
                  permission: "webfetch",
                  patterns: [after ? `${PermissionPolicy.AFTER_WEB}${url}` : url],
                  always: after ? [] : siteAlways(url),
                  metadata: {
                    url,
                    format: params.format,
                    timeout: params.timeout,
                    ...(after ? { reason: PermissionPolicy.AFTER_WEB_REASON } : {}),
                  },
                })
              },
              // A dev server, an intranet page or a cloud metadata address is reached only with its own approval,
              // since a model reading a hostile page could otherwise be steered into the user's network.
              authorizePrivate: (url) =>
                ctx
                  .ask({
                    permission: "private_network",
                    patterns: [new URL(url).origin],
                    always: [new URL(url).origin],
                    metadata: { url },
                  })
                  .pipe(Effect.tap(() => Effect.sync(() => (reached.private = true)))),
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
            EgressHttpClient.labelled("webfetch"),
          )

          const contentType = response.headers["content-type"] || ""
          const mime = contentType.split(";")[0]?.trim().toLowerCase() || ""
          const title = `${params.url} (${contentType})`

          if (isImageAttachment(mime)) {
            const base64Content = body.toString("base64")
            return {
              title,
              output: "Image fetched successfully",
              metadata: marked(),
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
            metadata: {
              ...marked(),
              truncated: page.truncated,
              ...(page.truncated && { outputPath: page.outputPath }),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

/**
 * Whether the agent's own choice of `address` asks again under Vector Local's rule for after the web (section 4.4):
 * once the conversation took in anything from outside, an address on a host it has not reached asks, as does one that
 * did not appear in an earlier web result or link. An address the person typed or pasted never asks again for this.
 * The ask's pattern starts with PermissionPolicy.AFTER_WEB, so no saved approval, rule or auto-accept answers it. With
 * Vector Local off it never applies.
 *
 * It reads the whole conversation (Tool.Context.history), so a compaction that folded a page away does not end it.
 * Outside content is whatever holds memory for review (SessionMemory.taint): a page, a search, an MCP tool, a remote
 * skill or a subagent's report, foreground or background, since a subagent may have read the page and relays what
 * it said. Only what the web itself returned counts as giving an address, never a subagent's report or an MCP tool's.
 *
 * A subagent works from a brief its launching agent wrote, which carries whatever that agent read: it counts as having
 * read the web from its first step, and nothing in its brief counts as typed by the person.
 *
 * An address with a user name or password in it asks unless the person typed or pasted it whole. The browser tool
 * applies this rule to the addresses it opens only: a page it reaches by a click, typing or a form asks by origin
 * alone (browser_interact). Where such a navigation may go is the desktop's to decide, by Web access rather than by
 * this rule (Vector Local in the desktop, phase L7, not built yet).
 */
export const newAddress = Effect.fn("WebFetchTool.newAddress")(function* (
  address: string,
  ctx: Pick<Tool.Context, "messages" | "parentID" | "history">,
) {
  if (!Egress.policy().enabled || !URL.canParse(address)) return false
  return unvouched(address, ctx.history ? yield* ctx.history() : ctx.messages, ctx.parentID !== undefined)
})

// Whether nothing vouches for `address` in a conversation that took in outside content: the person did not type or
// paste it, or the web did not both give it and serve a page from its host.
function unvouched(address: string, messages: readonly SessionV1.WithParts[], launched: boolean) {
  if (!launched && SessionMemory.taint(messages) === undefined) return false
  const url = new URL(address)
  // A user name or password in an address is something the agent put there, which a page can steer it into, so only
  // the person typing the whole address vouches for it.
  const credentials = url.username !== "" || url.password !== ""
  const forms = credentials
    ? [address.trim(), url.href]
    : [address.trim(), url.href, `${url.host}${url.pathname}${url.search}`]
  const names = (text: string) => forms.some((form) => text.includes(form))
  if (!launched && messages.some((message) => message.info.role === "user" && names(SessionMemory.said(message))))
    return false
  if (credentials) return true
  const tools = messages.flatMap((message) => message.parts.flatMap((part) => (part.type === "tool" ? [part] : [])))
  const reached = tools.some(
    (part) =>
      (part.tool === "webfetch" || part.tool === "browser") &&
      part.state.status === "completed" &&
      typeof part.state.input.url === "string" &&
      URL.canParse(part.state.input.url) &&
      new URL(part.state.input.url).host === url.host,
  )
  // Only what the web gave counts as a result: an address the agent wrote itself, in a command's output say, does not.
  const listed = tools.some(
    (part) => WEB_RESULTS.has(part.tool) && part.state.status === "completed" && names(part.state.output),
  )
  return !(reached && listed)
}

const WEB_RESULTS = new Set([
  "webfetch",
  "websearch",
  "browser",
  "research_search",
  "research_read",
  "research_browser",
])

// Each web reader's purpose under Vector Local, and the tool the network log names for it.
const WEB_ACCESS = {
  webfetch: { purpose: "web-page", tool: "webfetch" },
  "agent-browser": { purpose: "browser", tool: "browser" },
  "research-browser": { purpose: "research-browser", tool: "research_browser" },
} as const

/**
 * Refuses a web read that Web access does not allow while Vector Local is on (None reaches only this computer, Your
 * network only your network and the sites your company lists), before anything is asked or sent. The refusal is logged
 * and the person is told. The request itself is decided again, hop by hop, as it is sent.
 */
export function webAccess(source: "webfetch" | "agent-browser" | "research-browser", address: string) {
  const policy = Egress.policy()
  if (!policy.enabled) return
  const purpose = WEB_ACCESS[source]
  const verdict = LocalPolicy.decide(policy, { purpose: purpose.purpose, url: address, source })
  if (verdict.decision === "allow") return
  Egress.record({ source, url: address, tool: purpose.tool, notify: true }, verdict)
  throw new EgressGuard.EgressBlocked(
    URL.canParse(address) ? new URL(address).hostname : address,
    "fetch",
    verdict.rule,
    verdict.reason,
  )
}

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
