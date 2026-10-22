export * as ResearchSearch from "./search"

import { Data, Duration, Effect, Option, Schema } from "effect"
import { HttpClientError, HttpClientRequest, type HttpClient } from "effect/unstable/http"
import { collectBoundedResponseBody } from "../tool/http-body"
import { WebFetchRequest } from "../util/webfetch-request"
import { ResearchCanonical } from "./canonical"
import { WebFence } from "./fence"

// Where research searches. SearXNG is a search server the user runs or chooses: Vector asks its JSON API
// (`GET {url}/search?q=…&format=json`), which the server's settings have to allow. Exa and Parallel are the existing
// search clients, on the user's own key. The `browser` provider reads a results page in the agent's own research
// browser and is off until each engine's terms are checked. `none` searches nothing: research uses the repository's
// brain, its files and the addresses the user pasted. `auto` takes the first of these that is set up, and under Vector
// Local skips Exa and Parallel unless the user allowed them. The search server is the user's choice, so it is read
// only from their own config (the engine enforces that).

export const Provider = Schema.Literals(["auto", "searxng", "exa", "parallel", "browser", "none"])
export type Provider = typeof Provider.Type

export const Recency = Schema.Literals(["day", "week", "month", "year"])
export type Recency = typeof Recency.Type

export const MAX_RESULTS = 20
export const DEFAULT_RESULTS = 8
export const MAX_BYTES = 2 * 1024 * 1024
export const TIMEOUT = Duration.seconds(20)
const TITLE_CHARS = 300
const SNIPPET_CHARS = 500

export const NONE =
  "No search service set up. Research will use this repository's brain, its files and links you paste. Set up search."
export const JSON_OFF =
  "This SearXNG server does not answer in JSON. Turn on the json format in its settings (search.formats) and try again."
export const BUSY = "The search server is limiting searches right now. Try again in a minute."
export const FORWARDING =
  "This server may pass your prompts or queries on to services it is set up to use. Vector can't see past it."

/** Why Vector Local lets a paid search service see the queries, shown beside the allow. */
export function provided(provider: "exa" | "parallel") {
  const name = provider === "exa" ? "Exa" : "Parallel"
  return `${name} sees your search queries; billed by ${name} on your key`
}

export type Result = {
  readonly url: string
  readonly title: string
  readonly snippet: string
  readonly published?: string
  readonly engine?: string
}

export type Query = {
  readonly query: string
  readonly site?: string
  readonly recency?: Recency
  readonly limit?: number
}

export class SearchFailed extends Data.TaggedError("ResearchSearchFailed")<{ readonly message: string }> {}
// The caller's own refusal, carried through the request so it is passed on as it was.
class Declined extends Data.TaggedError("ResearchSearchDeclined")<{ readonly cause: unknown }> {}

/** The providers `auto` tries, in order, with what is set up and allowed. */
export function order(input: {
  readonly provider: Provider
  readonly searxng?: string
  readonly exa: boolean
  readonly parallel: boolean
  /** Vector Local is on; `allowed` lists the paid services the user let through. */
  readonly local?: { readonly allowed: readonly ("exa" | "parallel")[] }
  /** Searching through a results page in the research browser: off by default, desktop only. */
  readonly browser?: boolean
}): readonly Exclude<Provider, "auto">[] {
  const paid = (name: "exa" | "parallel") => input[name] && (!input.local || input.local.allowed.includes(name))
  const available: Readonly<Record<Exclude<Provider, "auto" | "none">, boolean>> = {
    searxng: !!input.searxng,
    exa: paid("exa"),
    parallel: paid("parallel"),
    browser: !!input.browser,
  }
  if (input.provider === "none") return ["none"]
  if (input.provider !== "auto") return available[input.provider] ? [input.provider, "none"] : ["none"]
  return [...(["searxng", "exa", "parallel", "browser"] as const).filter((name) => available[name]), "none"]
}

/** The SearXNG JSON request for a query: its search path under the server's address, with the query's options. */
export function searxngUrl(base: string, query: Query) {
  const url = new URL(base)
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/search`
  url.search = ""
  url.hash = ""
  url.searchParams.set("q", query.site ? `${query.query} site:${query.site}` : query.query)
  url.searchParams.set("format", "json")
  if (query.recency) url.searchParams.set("time_range", query.recency)
  return url.toString()
}

const SearxngResult = Schema.Struct({
  url: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  publishedDate: Schema.optional(Schema.NullOr(Schema.String)),
  engine: Schema.optional(Schema.NullOr(Schema.String)),
})
const SearxngAnswer = Schema.Struct({ results: Schema.Array(Schema.Unknown) })
const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(SearxngAnswer))
const decodeResult = Schema.decodeUnknownOption(SearxngResult)

/**
 * The results of a SearXNG JSON answer: http and https addresses only, each page once (by its canonical form), the
 * title and snippet cleaned of hidden characters and cut to length. Results the parser cannot read are left out, and
 * an answer that is not SearXNG's JSON gives none.
 */
export function parseSearxng(body: string, limit = DEFAULT_RESULTS): readonly Result[] {
  const answer = decodeAnswer(body)
  if (Option.isNone(answer)) return []
  const seen = new Set<string>()
  return answer.value.results
    .flatMap((raw) => {
      const result = decodeResult(raw)
      if (Option.isNone(result)) return []
      const canonical = ResearchCanonical.canonical(result.value.url)
      if (!canonical || seen.has(canonical)) return []
      seen.add(canonical)
      const published = date(result.value.publishedDate)
      return [
        {
          url: result.value.url,
          title: text(result.value.title, TITLE_CHARS) || new URL(canonical).hostname,
          snippet: text(result.value.content, SNIPPET_CHARS),
          ...(published ? { published } : {}),
          ...(result.value.engine ? { engine: text(result.value.engine, 40) } : {}),
        },
      ]
    })
    .slice(0, Math.min(Math.max(1, limit), MAX_RESULTS))
}

/**
 * Searches a SearXNG server. The request goes through WebFetchRequest like any web read: the name is pinned and a
 * server on the user's own network asks `authorizePrivate` once. `authorize` is the caller's decision for the
 * server's address (Vector Local's Web access); its failure is passed on unchanged.
 */
export const searxng = Effect.fn("ResearchSearch.searxng")(function* (
  query: Query,
  options: {
    readonly http: HttpClient.HttpClient
    readonly url: string
    readonly authorize: (url: string) => Effect.Effect<void, unknown>
    readonly authorizePrivate?: (url: string) => Effect.Effect<void, unknown>
    readonly resolver?: WebFetchRequest.DestinationResolver
  },
) {
  const address = searxngUrl(options.url, query)
  const answer = yield* Effect.gen(function* () {
    const response = yield* WebFetchRequest.execute(
      options.http,
      HttpClientRequest.get(address).pipe(HttpClientRequest.setHeaders({ Accept: "application/json" })),
      {
        authorize: (url) => options.authorize(url).pipe(Effect.mapError((cause) => new Declined({ cause }))),
        authorizePrivate: options.authorizePrivate
          ? (url) => options.authorizePrivate!(url).pipe(Effect.mapError((cause) => new Declined({ cause })))
          : undefined,
        resolver: options.resolver,
      },
    ).pipe(
      Effect.catchIf(
        (error): error is HttpClientError.HttpClientError =>
          HttpClientError.isHttpClientError(error) && error.reason._tag === "StatusCodeError" && !!error.response,
        (error) => Effect.succeed(error.response!),
      ),
    )
    const body = yield* collectBoundedResponseBody(
      response,
      MAX_BYTES,
      () => new SearchFailed({ message: "The search server sent more than Vector reads for one search." }),
    )
    return { status: response.status, body: new TextDecoder().decode(body) }
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: TIMEOUT,
      orElse: () => Effect.fail(new SearchFailed({ message: "The search server did not answer in time." })),
    }),
    Effect.catchIf(
      (error) => !(error instanceof Declined) && !(error instanceof SearchFailed),
      () => Effect.fail(new SearchFailed({ message: "Vector could not reach the search server." })),
    ),
  )
  // SearXNG answers 403 when its settings leave the json format off, and 429 when its limiter holds a client back.
  if (answer.status === 403) return yield* new SearchFailed({ message: JSON_OFF })
  if (answer.status === 429) return yield* new SearchFailed({ message: BUSY })
  if (answer.status < 200 || answer.status >= 300)
    return yield* new SearchFailed({ message: `The search server answered ${answer.status}.` })
  if (Option.isNone(decodeAnswer(answer.body))) return yield* new SearchFailed({ message: JSON_OFF })
  return parseSearxng(answer.body, query.limit)
}, Effect.catchIf(
  (error) => error instanceof Declined,
  (error) => Effect.fail((error as Declined).cause),
))

function text(value: string | null | undefined, max: number) {
  const cleaned = WebFence.clean(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}…` : cleaned
}

function date(value: string | null | undefined) {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString().slice(0, 10)
}
