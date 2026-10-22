export * as ResearchReader from "./reader"

import type { Research } from "@vectordevai/schema/research"
import { Data, Duration, Effect, Option } from "effect"
import { HttpClientError, HttpClientRequest, type HttpClient } from "effect/unstable/http"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { BrainLimits } from "../brain/document/limits"
import { BrainDocument } from "../brain/document/read"
import { BrainLexical } from "../brain/lexical"
import { collectBoundedResponseBody } from "../tool/http-body"
import { WebFetchRequest } from "../util/webfetch-request"
import { ResearchCanonical } from "./canonical"
import { ResearchDedupe } from "./dedupe"
import { ResearchDomain } from "./domain"
import { ResearchExtract } from "./extract"
import { WebFence } from "./fence"
import { ResearchPaywall } from "./paywall"
import { ResearchProvenance } from "./provenance"
import type { ResearchQuote } from "./quote"
import { ResearchRate } from "./rate"
import { ResearchRobots } from "./robots"

// How research reads one address. The request goes through WebFetchRequest, so every redirect hop is authorised
// again (the caller's `authorize`: provenance, the run's approval and, under Vector Local, the Web access policy) and
// names are resolved once and pinned. Each site is read within the run's rate limits.
//
// The user's own computer and network: research reads there only from an address the user typed, and asks first
// through `authorizePrivate` (refused without it), for that address and for each redirect it makes while it stays on
// the private network. An address Vector found (a search result or a page link), or a redirect from a public page,
// that reaches a private destination is refused without asking: a hostile page must not be able to walk research
// onto the intranet. Cloud metadata services and link-local addresses, where a server's credentials live, are
// refused whoever asks. A page read from a private destination is marked `private`, so its text is private context.
//
// robots.txt applies to addresses Vector found itself, on every hop. One the user typed is read because they asked
// for it, and so is a redirect that stays on its host; a redirect to another host is checked.
//
// What came back is sniffed by its bytes and read by the brain's readers: HTML through extract.ts (the page's main
// content and its own description of itself) and then BrainHtml, a PDF as text only (300 pages at most), text,
// Markdown and data files as they are. Every block is cleaned the way the brain stores documents (hidden characters
// out, secrets redacted, wrapper tags neutralised) and again by the web fence. A page built by script holds next to
// nothing in its HTML, so it is `needs-render`: only the desktop browser can read it. A paywall keeps its public
// excerpt only, and a check that the reader is a person is "blocked by the site". Nothing is bypassed.

export const MAX_BYTES = 5 * 1024 * 1024
export const MAX_PAGES = 300
// The most text kept from one source, in characters (about 500k tokens).
export const MAX_CHARS = 2_000_000
export const TIMEOUT = Duration.seconds(30)
// Chunks are about this many tokens: the full size, and the compact one for small contexts.
export const CHUNK_TOKENS = 1_200
export const COMPACT_TOKENS = 600
// Characters per token, for sizing chunks without a tokenizer.
export const CHARS_PER_TOKEN = 4
export const FOCUS_PASSAGES = 3

export const NEEDS_RENDER = "This page is built by script, so only the desktop browser can read it."
export const ROBOTS = "The site's robots.txt asks Vector not to read this page."
export const METADATA = "That is a cloud metadata or link-local address, which research never reads."
export const PRIVATE_FOUND =
  "That address is on your own computer or network. Research reads those only from an address you typed, not from a link, a search result or a redirect."
export const PRIVATE_ASK =
  "The address is on your own computer or network, which research does not read without asking."

// Cloud metadata services by name. Their addresses, and every link-local one, are refused by `metadata` below.
const METADATA_ADDRESSES = new Set(["100.100.100.200", "168.63.129.16"])
const METADATA_NAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
  "instance-data",
  "instance-data.ec2.internal",
])

const LIMITS: BrainLimits.Limits = {
  ...BrainLimits.LIMITS.inline,
  bytes: { pdf: MAX_BYTES, office: MAX_BYTES, csv: MAX_BYTES, text: MAX_BYTES },
  pages: MAX_PAGES,
  chars: MAX_CHARS,
}

export type Options = {
  readonly http: HttpClient.HttpClient
  /**
   * Decides every address the read reaches: the first and each redirect hop. Its failure is the caller's (a declined
   * approval, a refused host) and is passed on unchanged.
   */
  readonly authorize: (url: string) => Effect.Effect<void, unknown>
  /**
   * Asks before a destination on the user's own machine or network. Only an address the user typed asks, and each
   * redirect it makes while it stays there; without this, such a destination is refused.
   */
  readonly authorizePrivate?: (url: string) => Effect.Effect<void, unknown>
  readonly resolver?: WebFetchRequest.DestinationResolver
  /**
   * Names that count as public although they resolve to this computer. Only tests set it, to the fake web's domain, as
   * the network guard's `names` does; production has none.
   */
  readonly publicNames?: readonly string[]
  readonly limiter: ResearchRate.Limiter
  /** robots.txt for addresses Vector found itself; `robots()` below makes one that reads through the same guards. */
  readonly robots?: ResearchRobots.Cache
  readonly userAgent?: string
  readonly timeout?: Duration.Input
}

export type Input = {
  readonly url: string
  /** The user typed or pasted this address, so robots.txt does not apply to it. */
  readonly typed?: boolean
  /** Chunk size in tokens: CHUNK_TOKENS, or COMPACT_TOKENS in compact reading. */
  readonly chunkTokens?: number
}

export type Chunk = ResearchQuote.Part

export type Heading = { readonly text: string; readonly level: number; readonly chunk: number }

export type Meta = Pick<ResearchExtract.Page, "author" | "published" | "updated" | "ids" | "data" | "references">

export type Page = {
  readonly status: Research.SourceStatus
  /** The address asked for. */
  readonly url: string
  /** Where the redirects ended. */
  readonly final: string
  readonly canonical: string
  readonly site: string
  readonly title: string
  /** Why the page was not read in full, in Vector's words. */
  readonly reason?: string
  readonly format?: string
  readonly contentType?: string
  /** The cleaned text: the chunks joined by blank lines. Only the public excerpt for a paywalled page. */
  readonly text: string
  readonly chunks: readonly Chunk[]
  readonly outline: readonly Heading[]
  readonly pages?: number
  readonly meta: Meta
  /** Links research may offer next: absolute, http or https, none that look built to carry data. */
  readonly links: readonly ResearchExtract.Link[]
  /** Lines of `text` that read as instructions to an AI assistant, 1-based. */
  readonly flagged: readonly number[]
  readonly paywall?: ResearchPaywall.Reason
  readonly fingerprint: ResearchDedupe.Fingerprint
  /**
   * A hop reached the user's own computer or network. The page's text is then private context for the outbound check,
   * never public text that could clear a private token.
   */
  readonly private: boolean
}

class Refused extends Data.TaggedError("ResearchReaderRefused")<{ readonly cause: unknown }> {}
class RobotsDenied extends Data.TaggedError("ResearchReaderRobots")<{ readonly url: string }> {}
class TooLarge extends Data.TaggedError("ResearchReaderTooLarge")<{}> {}
// A destination the reader refuses itself, whoever asks: a metadata service, or a private one Vector found.
class Unsafe extends Data.TaggedError("ResearchReaderUnsafe")<{ readonly reason: string }> {}

type Fetched =
  | {
      readonly type: "answer"
      readonly status: number
      readonly headers: Readonly<Record<string, string | undefined>>
      readonly body: Uint8Array
      readonly final: string
      readonly private: boolean
    }
  | { readonly type: "failed"; readonly final: string; readonly reason: string }
  | { readonly type: "robots"; readonly final: string }

/** Reads one address. The caller's own refusals fail the effect; anything the site or the network did is a status. */
export const read = Effect.fn("ResearchReader.read")(
  function* (input: Input, options: Options) {
    const canonical = ResearchCanonical.canonical(input.url)
    if (!canonical) return unread(input.url, "failed", "Vector reads only http and https addresses.")
    const fetched = yield* options.limiter.run(
      new URL(canonical).hostname,
      attempt(input, options).pipe(
        Effect.catchIf(
          (error) => !(error instanceof Refused),
          (error) => Effect.succeed(failure(input.url, error)),
        ),
      ),
      (value) =>
        value.type === "answer" && ResearchRate.retriable(value.status)
          ? { retryAfter: value.headers["retry-after"] }
          : undefined,
    )
    const result = yield* page(input, fetched)
    return fetched.type === "answer" ? { ...result, private: fetched.private } : result
  },
  Effect.catchIf(
    (error) => error instanceof Refused,
    (error) => Effect.fail((error as Refused).cause),
  ),
)

/**
 * A robots.txt cache whose reads go through the same guards as the pages: pinned names, and never the user's own
 * network. robots.txt is read only for addresses Vector found, and research never reads one of those on a private
 * destination, so a private host's file is not fetched or asked about: robots.txt does not apply there, and the
 * reader's private rule decides each hop.
 */
export function robots(options: Pick<Options, "http" | "resolver" | "userAgent" | "publicNames">) {
  return ResearchRobots.cache((address) =>
    Effect.gen(function* () {
      // robots.txt is read from a site the caller already allowed, so only its own redirects on that host are
      // followed. One to another site is not read, and the site counts as unreachable.
      const host = new URL(address).hostname
      const response = yield* WebFetchRequest.execute(options.http, HttpClientRequest.get(address), {
        authorize: (url) =>
          new URL(url).hostname === host
            ? Effect.void
            : Effect.fail(new Error("robots.txt redirected to another site")),
        authorizePrivate: (url) =>
          named(hostOf(url), options.publicNames) ? Effect.void : Effect.fail(new Unsafe({ reason: PRIVATE_FOUND })),
        resolver: options.resolver,
        userAgent: options.userAgent,
      }).pipe(Effect.catchIf(statusError, (error) => Effect.succeed(error.response!)))
      const body = yield* collectBoundedResponseBody(response, ResearchRobots.MAX_BYTES, () => new TooLarge())
      return { status: response.status, text: new TextDecoder().decode(body) } satisfies ResearchRobots.Fetched
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({ duration: TIMEOUT, orElse: () => Effect.succeed({ status: "unreachable" } as const) }),
      Effect.catch((error) =>
        Effect.succeed<ResearchRobots.Fetched>(
          error instanceof Unsafe ? { status: 404, text: "" } : { status: "unreachable" },
        ),
      ),
    ),
  )
}

/**
 * The chunk asked for, or the first, as research_read shows it: Vector's line about the source, then the fence. The
 * outline, when asked for, goes inside the fence, since its headings are the page's words.
 */
export function present(input: {
  readonly page: Page
  readonly source: string
  readonly chunk?: number
  readonly passages?: readonly string[]
  readonly outline?: boolean
}) {
  const page = input.page
  const total = page.chunks.length
  const index = Math.min(Math.max(input.chunk ?? 1, 1), Math.max(total, 1))
  const shown = input.outline && page.outline.length > 0 ? [`Outline:\n${outline(page).join("\n")}`] : []
  const body = [...shown, ...(input.passages ?? [page.chunks[index - 1]?.text ?? ""])]
  const where = input.passages
    ? `${input.passages.length} passage${input.passages.length === 1 ? "" : "s"}`
    : `chunk ${index} of ${total}`
  const header = [
    input.source,
    page.site,
    page.meta.published ? `published ${page.meta.published}` : undefined,
    page.pages ? `${page.pages} pages` : undefined,
    total > 0 ? where : undefined,
    page.status === "read" ? undefined : page.status,
  ]
    .filter(Boolean)
    .join(" · ")
  return `${header}\n${WebFence.fenceWebPage({ url: page.final, title: page.title, tool: "research_read" }, body.join("\n\n"))}`
}

/** The page's outline: its headings with the chunk each starts. They are the page's words, so they are shown fenced. */
export function outline(page: Page) {
  return page.outline.map(
    (heading) => `${"  ".repeat(Math.max(0, heading.level - 1))}${heading.text} (chunk ${heading.chunk})`,
  )
}

/** The passages that share the most terms with `focus`, best first. */
export function focus(chunks: readonly Chunk[], text: string, count = FOCUS_PASSAGES) {
  const wanted = BrainLexical.terms(text)
  if (wanted.size === 0) return []
  return chunks
    .flatMap((chunk) => chunk.text.split(/\n{2,}/).map((passage) => ({ passage, chunk: chunk.chunk })))
    .map((item) => ({
      ...item,
      score: [...BrainLexical.terms(item.passage).keys()].filter((term) => wanted.has(term)).length,
    }))
    .filter((item) => item.score > 0)
    .toSorted((left, right) => right.score - left.score)
    .slice(0, count)
}

/** Short snippets around each place the text appears, case aside, with the chunk it is in. */
export function find(chunks: readonly Chunk[], text: string, limit = 10) {
  const wanted = text.trim().toLowerCase()
  if (wanted.length < 2) return []
  return chunks
    .flatMap((chunk) => {
      const lower = chunk.text.toLowerCase()
      return [...lower.matchAll(new RegExp(escapeRegExp(wanted), "g"))].map((match) => ({
        chunk: chunk.chunk,
        snippet: chunk.text.slice(Math.max(0, match.index - 160), match.index + wanted.length + 160).trim(),
      }))
    })
    .slice(0, limit)
}

// One request within the limits: authorised hop by hop, its body read up to the cap. A status other than 2xx is an
// answer too, so the rate limiter can retry a 429 or 503 and the page can be read as a paywall.
function attempt(input: Input, options: Options) {
  const request = HttpClientRequest.get(input.url).pipe(
    HttpClientRequest.setHeaders({
      Accept:
        "text/html, application/xhtml+xml, application/pdf;q=0.9, text/markdown;q=0.9, text/plain;q=0.8, */*;q=0.1",
      "Accept-Language": "en-US,en;q=0.9",
    }),
  )
  return Effect.gen(function* () {
    // Each try starts over. `reached`: the current hop is on the user's network; `left`: an earlier hop was public.
    const state = { hops: 0, reached: false, left: false, private: false }
    // What each name resolved to, so a name that points at a metadata address is refused like the address.
    const resolved = new Map<string, readonly string[]>()
    const hop = (url: string) =>
      Effect.gen(function* () {
        // The hop before this one was public when it never reached the private check.
        if (state.hops > 0 && !state.reached) state.left = true
        state.hops += 1
        state.reached = false
        if (metadata(hostOf(url))) return yield* new Unsafe({ reason: METADATA })
        yield* options.authorize(url).pipe(Effect.mapError((cause) => new Refused({ cause })))
        if ((input.typed && hostOf(url) === hostOf(input.url)) || !options.robots) return
        if (!(yield* options.robots.check(url))) return yield* new RobotsDenied({ url })
      })
    const privately = (url: string) =>
      Effect.gen(function* () {
        const host = hostOf(url)
        if ((resolved.get(host) ?? [host]).some(metadata)) return yield* new Unsafe({ reason: METADATA })
        if (named(host, options.publicNames)) return
        state.reached = true
        if (!input.typed || state.left) return yield* new Unsafe({ reason: PRIVATE_FOUND })
        if (!options.authorizePrivate) return yield* new Unsafe({ reason: PRIVATE_ASK })
        yield* options.authorizePrivate(url).pipe(Effect.mapError((cause) => new Refused({ cause })))
        state.private = true
      })
    const resolve = options.resolver ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true }))
    const response = yield* WebFetchRequest.execute(options.http, request, {
      authorize: hop,
      authorizePrivate: privately,
      resolver: (hostname) =>
        resolve(hostname).then((records) => {
          resolved.set(
            hostname,
            records.map((record) => record.address),
          )
          return records
        }),
      userAgent: options.userAgent,
    }).pipe(Effect.catchIf(statusError, (error) => Effect.succeed(error.response!)))
    const body = yield* collectBoundedResponseBody(response, MAX_BYTES, () => new TooLarge())
    return {
      type: "answer",
      status: response.status,
      headers: response.headers,
      // A plain copy: the collector's buffer can be a view into a larger pooled one, which the PDF reader would read
      // whole.
      body: new Uint8Array(body),
      // A redirect keeps the query in the request's parameters, so the address is built from both.
      final: Option.getOrUndefined(HttpClientRequest.toUrl(response.request))?.toString() ?? input.url,
      private: state.private,
    } satisfies Fetched as Fetched
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: options.timeout ?? TIMEOUT,
      orElse: () =>
        Effect.succeed<Fetched>({ type: "failed", final: input.url, reason: "The site did not answer in time." }),
    }),
  )
}

function failure(url: string, error: unknown): Fetched {
  if (error instanceof RobotsDenied) return { type: "robots", final: error.url }
  if (error instanceof Unsafe) return { type: "failed", final: url, reason: error.reason }
  if (error instanceof TooLarge)
    return {
      type: "failed",
      final: url,
      reason: `The page is over ${MAX_BYTES / 1024 / 1024} MB, the most research reads.`,
    }
  const message = error instanceof Error ? error.message : String(error)
  if (/too many redirects/i.test(message))
    return { type: "failed", final: url, reason: "The page redirected too many times." }
  return { type: "failed", final: url, reason: "Vector could not reach the site." }
}

const page = Effect.fnUntraced(function* (input: Input, fetched: Fetched) {
  if (fetched.type === "robots") return unread(input.url, "robots", ROBOTS, fetched.final)
  if (fetched.type === "failed") return unread(input.url, "failed", fetched.reason, fetched.final)
  const contentType = fetched.headers["content-type"] ?? ""
  const mime = contentType.split(";", 1)[0]!.trim().toLowerCase()
  const head = decode(fetched.body.subarray(0, 64 * 1024), contentType)
  if (ResearchRate.challenge({ status: fetched.status, headers: fetched.headers, body: head }))
    return unread(input.url, "failed", ResearchRate.BLOCKED, fetched.final)
  if (ResearchRate.retriable(fetched.status))
    return unread(
      input.url,
      "failed",
      `The site is busy (${fetched.status}) and asked Vector to come back later.`,
      fetched.final,
    )
  const walled = ResearchPaywall.status(fetched.status)
  if (!walled && (fetched.status < 200 || fetched.status >= 300))
    return unread(input.url, "failed", `The site answered ${fetched.status}.`, fetched.final)
  if (/^(?:image|audio|video|font)\//.test(mime))
    return unread(input.url, "failed", `Research reads pages, PDFs and text, not ${mime} files.`, fetched.final)
  const html = mime === "text/html" || mime === "application/xhtml+xml" || (!mime && /^\s*</.test(head))
  const extracted = html ? ResearchExtract.extract(decode(fetched.body, contentType), fetched.final) : undefined
  const reading = yield* Effect.tryPromise(() =>
    BrainDocument.read(
      extracted
        ? { name: "page.html", bytes: new TextEncoder().encode(extracted.main), mime: "text/html" }
        : { name: name(fetched.final, mime), bytes: recode(fetched.body, contentType), mime },
      LIMITS,
    ),
  ).pipe(Effect.orElseSucceed(() => BrainLimits.refuse("invalid", "Vector could not read this page.")))
  const paywall = walled
    ? "status"
    : extracted
      ? ResearchPaywall.marked({ html: decode(fetched.body, contentType), structured: extracted.structured })
      : undefined
  const final = ResearchCanonical.canonical(fetched.final) ?? fetched.final
  const canonical = (extracted ? ResearchCanonical.follow(fetched.final, extracted.canonical) : undefined) ?? final
  if (reading.type === "refused") {
    if (extracted?.scripted)
      return { ...unread(input.url, "needs-render", NEEDS_RENDER, fetched.final), title: extracted.title ?? "" }
    if (paywall)
      return {
        ...unread(input.url, "paywalled", ResearchPaywall.MESSAGE, fetched.final),
        title: extracted?.title ?? "",
        paywall,
      }
    return unread(input.url, "failed", reading.message, fetched.final)
  }
  const meta: Meta = extracted
    ? {
        author: extracted.author,
        published: extracted.published,
        updated: extracted.updated,
        ids: extracted.ids,
        data: extracted.data,
        references: extracted.references,
      }
    : { ids: ResearchExtract.addressIds(fetched.final), data: reading.format === "csv", references: false }
  const size = (input.chunkTokens ?? CHUNK_TOKENS) * CHARS_PER_TOKEN
  const laid = layout(reading, size)
  const kept = paywall ? layout(excerpted(reading), size) : laid
  const text = kept.chunks.map((chunk) => chunk.text).join("\n\n")
  const status: Research.SourceStatus = extracted?.scripted ? "needs-render" : paywall ? "paywalled" : "read"
  return {
    status,
    url: input.url,
    final,
    canonical,
    site: ResearchDomain.site(final),
    title: WebFence.clean(extracted?.title ?? reading.title).trim() || reading.title,
    ...(status === "needs-render"
      ? { reason: NEEDS_RENDER }
      : status === "paywalled"
        ? { reason: ResearchPaywall.MESSAGE }
        : {}),
    format: reading.format,
    contentType,
    text,
    chunks: kept.chunks,
    outline: kept.outline,
    ...(reading.pages === undefined ? {} : { pages: reading.pages }),
    meta,
    links: ResearchProvenance.offered(
      extracted
        ? extracted.links
        : reading.links.filter((link) => /^https?:/i.test(link)).map((link) => ({ url: link, text: "" })),
    ),
    flagged: WebFence.flagged(text),
    ...(paywall ? { paywall } : {}),
    fingerprint: ResearchDedupe.fingerprint(text),
    private: false,
  } satisfies Page
})

// The extracted text in chunks of about `size` characters. A chunk starts at a PDF page break, so each chunk has one
// page, and a block larger than a chunk is cut at a line or a space.
function layout(reading: BrainDocument.Extracted, size: number) {
  const chunks: { text: string; page?: number }[] = []
  const outline: Heading[] = []
  for (const block of reading.blocks) {
    const text = WebFence.clean(reading.text.slice(block.span.start, block.span.end)).trim()
    if (!text) continue
    const last = chunks.at(-1)
    const fresh = !last || last.page !== block.span.page || last.text.length + text.length + 2 > size
    if (block.type === "heading")
      outline.push({ text, level: block.level, chunk: fresh ? chunks.length + 1 : chunks.length })
    const pieces = cut(text, size)
    pieces.forEach((piece, index) => {
      const current = chunks.at(-1)
      if (index === 0 && !fresh && current) {
        current.text = `${current.text}\n\n${piece}`
        return
      }
      chunks.push({ text: piece, ...(block.span.page === undefined ? {} : { page: block.span.page }) })
    })
  }
  return {
    chunks: chunks.map((chunk, index) => ({
      text: chunk.text,
      chunk: index + 1,
      ...(chunk.page === undefined ? {} : { page: chunk.page }),
    })),
    outline,
  }
}

// The public excerpt of a paywalled page: its first blocks, up to the excerpt's length.
function excerpted(reading: BrainDocument.Extracted): BrainDocument.Extracted {
  const cut = ResearchPaywall.excerpt(reading.text).length
  return {
    ...reading,
    text: reading.text.slice(0, cut),
    blocks: reading.blocks
      .filter((block) => block.span.start < cut)
      .map((block) => ({ ...block, span: { ...block.span, end: Math.min(block.span.end, cut) } })),
  }
}

function cut(text: string, size: number) {
  if (text.length <= size) return [text]
  const pieces: string[] = []
  const state = { rest: text }
  while (state.rest.length > size) {
    const window = state.rest.slice(0, size)
    const end = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "))
    const at = end > size / 2 ? end : size
    pieces.push(state.rest.slice(0, at).trim())
    state.rest = state.rest.slice(at).trim()
  }
  if (state.rest) pieces.push(state.rest)
  return pieces
}

function unread(url: string, status: Research.SourceStatus, reason: string, final = url): Page {
  const address = ResearchCanonical.canonical(final) ?? final
  return {
    status,
    url,
    final: address,
    canonical: address,
    site: URL.canParse(address) ? ResearchDomain.site(address) : "",
    title: "",
    reason,
    text: "",
    chunks: [],
    outline: [],
    meta: { ids: {}, data: false, references: false },
    links: [],
    flagged: [],
    fingerprint: ResearchDedupe.fingerprint(""),
    private: false,
  }
}

// A host as WebFetchRequest resolves it: no brackets round an IPv6 address, no trailing dot, lower case.
function hostOf(url: string) {
  return new URL(url).hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase()
}

function named(host: string, names: readonly string[] | undefined) {
  return (names ?? []).some((name) => host === name || host.endsWith(`.${name}`))
}

// A cloud metadata service or a link-local address: 169.254.0.0/16 (AWS, Azure, Google and most others), Alibaba's
// 100.100.100.200, Azure's WireServer 168.63.129.16 (a public address that only answers inside Azure), fe80::/10 and
// AWS's fd00:ec2::254, and the IPv4 ones written as IPv6 (mapped, NAT64 or 6to4).
function metadata(host: string) {
  if (isIP(host) === 4) return host.startsWith("169.254.") || METADATA_ADDRESSES.has(host)
  if (isIP(host) !== 6) return METADATA_NAMES.has(host)
  const groups = ipv6(host.split("%", 1)[0]!)
  if (!groups) return false
  const inner =
    (groups.slice(0, 5).every((group) => group === 0) && (groups[5] === 0xffff || groups[5] === 0)) ||
    (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0))
      ? [groups[6]!, groups[7]!]
      : groups[0] === 0x2002
        ? [groups[1]!, groups[2]!]
        : undefined
  if (inner) return metadata([inner[0] >> 8, inner[0] & 0xff, inner[1] >> 8, inner[1] & 0xff].join("."))
  return (groups[0]! & 0xffc0) === 0xfe80 || groups.join(":") === [0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254].join(":")
}

// The eight groups of an IPv6 address, with "::" filled in and a dotted IPv4 tail read as two groups.
function ipv6(address: string) {
  const halves = address.toLowerCase().split("::")
  if (halves.length > 2) return undefined
  const groups = (part: string) =>
    part
      ? part.split(":").flatMap((piece) => {
          if (!piece.includes(".")) return [Number.parseInt(piece, 16)]
          const octets = piece.split(".").map(Number)
          return [octets[0]! * 256 + octets[1]!, octets[2]! * 256 + octets[3]!]
        })
      : []
  const left = groups(halves[0] ?? "")
  const right = groups(halves[1] ?? "")
  const all =
    halves.length === 1 ? left : [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right]
  return all.length === 8 && all.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? all
    : undefined
}

function statusError(error: unknown): error is HttpClientError.HttpClientError {
  return HttpClientError.isHttpClientError(error) && error.reason._tag === "StatusCodeError" && !!error.response
}

// Charsets a page may declare that Vector decodes; anything else is read as UTF-8.
const CHARSETS = new Set([
  "utf-8",
  "utf8",
  "iso-8859-1",
  "latin1",
  "windows-1252",
  "us-ascii",
  "shift_jis",
  "euc-jp",
  "gbk",
  "gb2312",
  "gb18030",
  "big5",
  "euc-kr",
  "utf-16le",
])

function decode(bytes: Uint8Array, contentType: string) {
  const declared = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType)?.[1]?.toLowerCase()
  const label = declared === "us-ascii" ? "windows-1252" : declared === "gb2312" ? "gbk" : declared
  return new TextDecoder(label && CHARSETS.has(label) ? label : "utf-8").decode(bytes)
}

// Text in another charset, as the UTF-8 the brain's readers expect. Binary formats are passed as they came.
function recode(bytes: Uint8Array, contentType: string) {
  if (!/charset\s*=/i.test(contentType) || /charset\s*=\s*"?utf-?8/i.test(contentType)) return bytes
  return new TextEncoder().encode(decode(bytes, contentType))
}

// A file name for the sniffer from the type the site sent, since a URL's path often has no extension.
function name(url: string, mime: string) {
  const known: Readonly<Record<string, string>> = {
    "application/pdf": "document.pdf",
    "text/markdown": "page.md",
    "text/x-markdown": "page.md",
    "text/plain": "page.txt",
    "text/csv": "data.csv",
    "text/tab-separated-values": "data.tsv",
    "application/json": "data.json",
    "application/yaml": "data.yaml",
    "text/yaml": "data.yaml",
  }
  if (known[mime]) return known[mime]
  const last = new URL(url).pathname.split("/").pop() ?? ""
  return /\.[A-Za-z0-9]{1,8}$/.test(last) ? last : "page.txt"
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
