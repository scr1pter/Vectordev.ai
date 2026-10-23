import { ResearchCanonical } from "@vectordevai/core/research/canonical"
import { WebFence } from "@vectordevai/core/research/fence"
import { ResearchOutbound } from "@vectordevai/core/research/outbound"
import { ResearchSearch } from "@vectordevai/core/research/search"
import { ResearchStore } from "@vectordevai/core/research/store"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { ConfigResearchV1 } from "@vectordevai/core/v1/config/research"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { Research } from "@vectordevai/schema/research"
import { Cause, Effect, Option, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionTaskSize } from "../session/task-size"
import * as McpWebSearch from "./mcp-websearch"
import { ResearchRun } from "./research-run"
import { Tool } from "./tool"
import { webSearchAuthHeaders } from "./websearch"
import DESCRIPTION from "./research-search.txt"

// research_search (sections 5.4 and 5.7): a query passes the outbound check against the run's private context before
// it leaves, then counts against the run's search budget and is kept for the Sources tab. Every result joins the run's
// provenance (its call's metadata is the record), and comes back fenced, marked when the run already read it.
//
// Where it searches is the user's choice, read from their own config only (the engine's config keeps a repository's
// search server out, so a checked-in config cannot send the user's queries to a server its author runs):
// - searxng: a SearXNG server the user set up, through its JSON API;
// - exa, parallel: the existing search services on the user's own key, sent the query and nothing that ties it to the
//   session or the model, and billed by them. Under Vector Local only when the user allowed them there;
// - browser: a results page in a research browser, which is not built yet;
// - none: nothing is searched; research uses the brain, the repository's files and the addresses the user typed;
// - auto (the default): the first of SearXNG, Exa and Parallel that is set up and allowed, else none.
// `vector run --research --search` picks one for its own run, among those the user set up.

export const Parameters = Schema.Struct({
  query: Schema.String.check(Schema.isLengthBetween(1, 200)).annotate({
    description: "The search query, in public terms: never text from the user's files, documents or memory",
  }),
  subquestion: Schema.optional(Schema.String.check(Schema.isMaxLength(300))).annotate({
    description: "The sub-question this search is for",
  }),
  site: Schema.optional(Schema.String).annotate({ description: "Limit the search to one site, such as nature.com" }),
  recency: Schema.optional(ResearchSearch.Recency).annotate({ description: "day, week, month or year" }),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: ResearchSearch.MAX_RESULTS })),
  ).annotate({
    description: `How many results, up to ${ResearchSearch.MAX_RESULTS} (default ${ResearchSearch.DEFAULT_RESULTS})`,
  }),
})

type Metadata = {
  runID?: string
  query?: string
  provider?: string
  results?: ResearchRun.Result[]
  refused?: "outbound" | "budget" | "scope" | "none"
}

/** Where `vector run --research` puts its own choices for the run: a text part's metadata on its prompt. */
export const OPTIONS = "vector.research"

/** The search and scope `vector run --research` was given. */
export const Options = Schema.Struct({
  search: Schema.optional(ConfigResearchV1.Provider),
  scope: Schema.optional(Research.Scope),
})
export type Options = typeof Options.Type
const decodeOptions = Schema.decodeUnknownOption(Options)

export const BROWSER =
  "Searching through a results page in a research browser is not available yet. Set up a SearXNG server, or an Exa or Parallel key, for research."
export const PAID = "Searches go to {name} on your key, billed by {name}."

const PAID_URL = { exa: McpWebSearch.EXA_URL, parallel: McpWebSearch.PARALLEL_URL } as const
const PAID_NAME = { exa: "Exa", parallel: "Parallel" } as const

/** Where research searches. */
export type Provider =
  | { readonly provider: "searxng"; readonly url: string }
  | { readonly provider: "exa" | "parallel" }
  | { readonly provider: "none"; readonly reason?: string }

/** The search services the user set up besides SearXNG, and which of them Vector Local lets through. */
export type Available = {
  readonly exa: boolean
  readonly parallel: boolean
  /** Vector Local is on: the services the user allowed through it. */
  readonly local?: { readonly allowed: readonly ("exa" | "parallel")[] }
}

/**
 * Where research searches, from the user's research settings and what they set up. `chosen`, the search
 * `vector run --research --search` was given, picks among those; it never reaches a server the settings do not name.
 */
export function searchProvider(
  research: ConfigResearchV1.Info | undefined,
  available: Available = { exa: false, parallel: false },
  chosen?: ConfigResearchV1.Provider,
): Provider {
  const url = research?.search?.url?.trim()
  const provider = chosen && chosen !== "auto" ? chosen : (research?.search?.provider ?? "auto")
  const first = ResearchSearch.order({
    provider,
    ...(url && URL.canParse(url) ? { searxng: url } : {}),
    exa: available.exa,
    parallel: available.parallel,
    ...(available.local ? { local: available.local } : {}),
    // The research browsers that would read a results page are not built yet.
    browser: false,
  })[0]
  if (first === "searxng" && url) return { provider: "searxng", url }
  if (first === "exa" || first === "parallel") return { provider: first }
  return { provider: "none", ...(why(provider, available) ? { reason: why(provider, available) } : {}) }
}

// Why a search the user named is not used.
function why(provider: ConfigResearchV1.Provider, available: Available) {
  if (provider === "browser") return BROWSER
  if (provider === "searxng")
    return "Research is set to search with SearXNG, and no SearXNG address is set up (research.search.url). Research will use this repository's brain, its files and links you paste."
  if (provider !== "exa" && provider !== "parallel") return undefined
  const name = PAID_NAME[provider]
  if (!available[provider])
    return `Research is set to search with ${name}, and no ${name} key is set up. Add one in Settings, or research will use this repository's brain, its files and links you paste.`
  return `Vector Local keeps research's searches off ${name} until you allow it. Research will use this repository's brain, its files and links you paste.`
}

/** What the user set up to search with, and what Vector Local lets through, read where research runs. */
export const available = Effect.fn("ResearchSearchTool.available")(function* () {
  const auth = yield* Auth.Service
  const flags = yield* RuntimeFlags.Service
  const policy = Egress.policy()
  return {
    exa: flags.enableExa || !!(yield* searchKey(auth, "exa")),
    parallel: flags.enableParallel || !!(yield* searchKey(auth, "parallel")),
    // A pure decision: nothing is logged for a request that is not made.
    ...(policy.enabled
      ? {
          local: {
            allowed: (["exa", "parallel"] as const).filter(
              (name) =>
                LocalPolicy.decide(policy, { purpose: "web-search", url: PAID_URL[name], source: `websearch-${name}` })
                  .decision === "allow",
            ),
          },
        }
      : {}),
  } satisfies Available
})

/** The choices `vector run --research` made for this request: on the newest message the user sent. */
export function options(messages: readonly SessionV1.WithParts[]): Options {
  const sent = messages.findLast((message) => message.info.role === "user" && SessionTaskSize.real(message))
  const value = sent?.parts
    .flatMap((part) => (part.type === "text" && part.metadata?.[OPTIONS] !== undefined ? [part.metadata[OPTIONS]] : []))
    .at(0)
  if (value === undefined) return {}
  const decoded = decodeOptions(value)
  return Option.isSome(decoded) ? decoded.value : {}
}

export const ResearchSearchTool = Tool.define<
  typeof Parameters,
  Metadata,
  | ResearchRun.Service
  | ResearchStore.Service
  | Config.Service
  | HttpClient.HttpClient
  | Session.Service
  | Auth.Service
  | RuntimeFlags.Service
>(
  "research_search",
  Effect.gen(function* () {
    const research = yield* ResearchRun.Service
    const store = yield* ResearchStore.Service
    const config = yield* Config.Service
    const http = yield* HttpClient.HttpClient
    const sessions = yield* Session.Service
    const auth = yield* Auth.Service
    const flags = yield* RuntimeFlags.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const found = yield* research.current(ctx)
          if ("refused" in found) return { title: "Not searched", output: found.refused, metadata: {} }
          const runID = found.run.id
          // A researcher works for its lead, so the lead's request holds the run's choices.
          const chosen = options(
            found.lead.id === ctx.sessionID
              ? ctx.messages
              : yield* sessions
                  .messages({ sessionID: found.lead.id })
                  .pipe(Effect.catch(() => Effect.succeed([] as SessionV1.WithParts[]))),
          )
          if (found.plan.scope === "brain" || chosen.scope === "brain")
            return {
              title: "Not searched",
              output:
                "This research's scope is the brain and the repository's files, so it searches nothing on the web.",
              metadata: { runID, refused: "scope" as const },
            }
          const provider = searchProvider(
            (yield* config.get()).research,
            yield* available().pipe(
              Effect.provideService(Auth.Service, auth),
              Effect.provideService(RuntimeFlags.Service, flags),
            ),
            chosen.search,
          )
          if (provider.provider === "none")
            return {
              title: "No search service",
              output: provider.reason ?? ResearchSearch.NONE,
              metadata: { runID, refused: "none" as const },
            }
          const query = params.query.trim()
          const context = yield* research.context(ctx, found)
          // Checked before it counts: a refused query was never sent.
          const checked = ResearchOutbound.check(params.site ? `${query} site:${params.site}` : query, context)
          if (!checked.ok)
            return {
              title: "Search refused",
              output: checked.message,
              metadata: { runID, query, refused: "outbound" as const },
            }
          const counted = yield* store.searched(found.place, runID, query)
          if (counted.type === "refused")
            return {
              title: "Search budget used",
              output: counted.message,
              metadata: { runID, query, refused: "budget" as const },
            }
          yield* ctx.metadata({ title: `Searching: ${query}`, metadata: { runID, query, provider: provider.provider } })
          const asked: ResearchSearch.Query = {
            query,
            ...(params.site ? { site: params.site } : {}),
            ...(params.recency ? { recency: params.recency } : {}),
            ...(params.limit ? { limit: params.limit } : {}),
          }
          const results =
            provider.provider === "searxng"
              ? yield* ResearchSearch.searxng(asked, {
                  http,
                  url: provider.url,
                  context,
                  // Vector Local's Web access decides the search server's address once it is in force (phase L5).
                  authorize: () => Effect.void,
                  // A SearXNG server on the user's own network asks once for its origin.
                  authorizePrivate: (url) =>
                    ctx.ask({
                      permission: "private_network",
                      patterns: [new URL(url).origin],
                      always: [new URL(url).origin],
                      metadata: { url: new URL(url).origin, tool: "research_search" },
                    }),
                  resolver: research.network.resolver,
                }).pipe(
                  Effect.map((items) => ({ type: "results" as const, items })),
                  // What the server or the network did, and the outbound check's own refusal, are answers; a declined
                  // approval for a server on the user's network fails the call as any declined approval does.
                  Effect.catchIf(
                    (error): error is ResearchSearch.SearchFailed | ResearchSearch.QueryRefused =>
                      error instanceof ResearchSearch.SearchFailed || error instanceof ResearchSearch.QueryRefused,
                    (error) => Effect.succeed({ type: "failed" as const, message: error.message }),
                  ),
                )
              : yield* paid(http, provider.provider, asked, (yield* searchKey(auth, provider.provider)) ?? undefined)
          if (results.type === "failed")
            return {
              title: "Search failed",
              output: results.message,
              metadata: { runID, query, provider: provider.provider },
            }
          const read = new Map(found.detail.sources.map((source) => [source.canonical_url, source.id]))
          const listed = results.items.map((item, index) => {
            const known = read.get(ResearchCanonical.canonical(item.url) ?? "")
            return [
              `${index + 1}. ${item.title}${known ? ` (already read as ${known})` : ""}`,
              `   ${item.url}`,
              ...(item.published ? [`   published ${item.published}`] : []),
              ...(item.snippet ? [`   ${item.snippet}`] : []),
            ].join("\n")
          })
          const billed =
            provider.provider === "exa" || provider.provider === "parallel"
              ? `\n${PAID.replaceAll("{name}", PAID_NAME[provider.provider])}`
              : ""
          return {
            title: `Searched: ${query}`,
            output: results.items.length
              ? `${results.items.length} result${results.items.length === 1 ? "" : "s"}. Read the useful ones with research_read.${billed}\n${WebFence.fenceWebPage(
                  { title: `Search results: ${query}`, tool: "research_search" },
                  listed.join("\n"),
                )}`
              : `No results. Try other words, or a broader query.${billed}`,
            metadata: {
              runID,
              query,
              provider: provider.provider,
              results: results.items.map((item) => ({ url: item.url, title: item.title, snippet: item.snippet })),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// The key for a search service, as the websearch tool reads it: the environment's first, then the one in Settings.
function searchKey(auth: Auth.Interface, provider: "exa" | "parallel") {
  return Effect.gen(function* () {
    const env = provider === "exa" ? process.env.EXA_API_KEY : process.env.PARALLEL_API_KEY
    if (env) return env
    const saved = yield* auth.get(provider)
    return saved?.type === "api" ? saved.key : undefined
  })
}

/**
 * Searches Exa or Parallel through their MCP search tools, as the websearch tool does: the query alone, with no session
 * ID or model name. A site filter goes in the query as `site:`. Their answer is text, read for results with addresses
 * (`parsePaid`); what the service or the network did is an answer, never a failed call.
 */
export function paid(
  http: HttpClient.HttpClient,
  provider: "exa" | "parallel",
  query: ResearchSearch.Query,
  key?: string,
) {
  const text = query.site ? `${query.query} site:${query.site}` : query.query
  const limit = query.limit ?? ResearchSearch.DEFAULT_RESULTS
  const request =
    provider === "parallel"
      ? McpWebSearch.call(
          http,
          McpWebSearch.PARALLEL_URL,
          "web_search",
          McpWebSearch.ParallelSearchArgs,
          { objective: text, search_queries: [text] },
          "25 seconds",
          webSearchAuthHeaders(provider, key),
        )
      : McpWebSearch.call(
          http,
          McpWebSearch.EXA_URL,
          "web_search_exa",
          McpWebSearch.SearchArgs,
          { query: text, type: "auto", numResults: limit, livecrawl: "fallback" },
          "25 seconds",
          webSearchAuthHeaders(provider, key),
        )
  return request.pipe(
    Effect.map((body) => ({ type: "results" as const, items: parsePaid(body ?? "", limit) })),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.succeed({
            type: "failed" as const,
            message: `${PAID_NAME[provider]} did not answer the search. Check its key in Settings and try again.`,
          }),
    ),
  )
}

const PaidResult = Schema.Struct({
  url: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.optional(Schema.NullOr(Schema.String)),
  snippet: Schema.optional(Schema.NullOr(Schema.String)),
  summary: Schema.optional(Schema.NullOr(Schema.String)),
  excerpts: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  highlights: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  publishedDate: Schema.optional(Schema.NullOr(Schema.String)),
  publish_date: Schema.optional(Schema.NullOr(Schema.String)),
})
const decodePaid = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ results: Schema.Array(Schema.Unknown) })),
)
const decodePaidResult = Schema.decodeUnknownOption(PaidResult)
const TITLE_CHARS = 300
const SNIPPET_CHARS = 500

/**
 * The results in a search service's answer: its JSON results when it sends them, else its text blocks ("Title: …",
 * "URL: …"), else the addresses it names. Only http and https addresses, each page once by its canonical form, and the
 * title and snippet cleaned of hidden characters and cut to length.
 */
export function parsePaid(body: string, limit = ResearchSearch.DEFAULT_RESULTS): readonly ResearchSearch.Result[] {
  const json = decodePaid(body.trim())
  const raw: { url: string; title?: string; snippet?: string; published?: string }[] = Option.isSome(json)
    ? json.value.results.flatMap((item) => {
        const result = decodePaidResult(item)
        if (Option.isNone(result)) return []
        const value = result.value
        return [
          {
            url: value.url,
            title: value.title ?? undefined,
            snippet:
              value.snippet ??
              value.summary ??
              value.excerpts?.join(" ") ??
              value.highlights?.join(" ") ??
              value.text ??
              undefined,
            published: value.publishedDate ?? value.publish_date ?? undefined,
          },
        ]
      })
    : blocks(body)
  const seen = new Set<string>()
  return raw
    .flatMap((item) => {
      const canonical = ResearchCanonical.canonical(item.url)
      if (!canonical || seen.has(canonical) || !/^https?:$/.test(new URL(canonical).protocol)) return []
      seen.add(canonical)
      const published =
        item.published && !Number.isNaN(Date.parse(item.published))
          ? new Date(Date.parse(item.published)).toISOString().slice(0, 10)
          : undefined
      return [
        {
          url: item.url,
          title: clip(item.title ?? "", TITLE_CHARS) || new URL(canonical).hostname,
          snippet: clip(item.snippet ?? "", SNIPPET_CHARS),
          ...(published ? { published } : {}),
        },
      ]
    })
    .slice(0, Math.min(Math.max(1, limit), ResearchSearch.MAX_RESULTS))
}

// "Title: …" / "URL: …" blocks, as Exa's search tool writes them; without any, every address the text names.
function blocks(body: string) {
  const records = body.split("\n").reduce<Block[]>((list, line) => {
    const field = FIELD.exec(line)
    const name = field?.[1]?.toLowerCase()
    const value = (field ? field[2]! : line).trim()
    const current = list.at(-1)
    const rest = list.slice(0, -1)
    if (name === "title") return [...list, { title: value, text: [] }]
    if (name === "url")
      return current && !current.url ? [...rest, { ...current, url: value }] : [...list, { url: value, text: [] }]
    if (!current) return list
    if (name === "published date" || name === "published") return [...rest, { ...current, published: value }]
    if (name === "author" || !current.url || !value || current.text.join(" ").length >= SNIPPET_CHARS) return list
    return [...rest, { ...current, text: [...current.text, value] }]
  }, [])
  const items = records.flatMap((record) =>
    record.url
      ? [{ url: record.url, title: record.title, snippet: record.text.join(" "), published: record.published }]
      : [],
  )
  if (items.length) return items
  return [...body.matchAll(/https?:\/\/[^\s<>"')\]]+/g)].map((match) => ({ url: match[0] }))
}

// One result of a search service's text answer, as its lines are read.
type Block = {
  readonly url?: string
  readonly title?: string
  readonly published?: string
  readonly text: readonly string[]
}
const FIELD = /^\s*(Title|URL|Published Date|Published|Author|Text|Highlights|Summary):\s*(.*)$/i

function clip(value: string, max: number) {
  const cleaned = WebFence.clean(value).replace(/\s+/g, " ").trim()
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}…` : cleaned
}
