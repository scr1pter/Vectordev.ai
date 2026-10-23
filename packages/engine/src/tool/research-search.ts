import { ResearchCanonical } from "@vectordevai/core/research/canonical"
import { WebFence } from "@vectordevai/core/research/fence"
import { ResearchOutbound } from "@vectordevai/core/research/outbound"
import { ResearchSearch } from "@vectordevai/core/research/search"
import { ResearchStore } from "@vectordevai/core/research/store"
import type { ConfigResearchV1 } from "@vectordevai/core/v1/config/research"
import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { EgressHttpClient } from "@vectordevai/core/local-mode/http-client"
import { Config } from "@/config/config"
import { ResearchRun } from "./research-run"
import { Tool } from "./tool"
import DESCRIPTION from "./research-search.txt"

// research_search (section 5.4): a query passes the outbound check against the run's private context before it
// leaves, then counts against the run's search budget and is kept for the Sources tab. Every result joins the run's
// provenance (its call's metadata is the record), and comes back fenced, marked when the run already read it.

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

export const NOT_YET =
  "Exa and Parallel are not yet available to Deep research. Set up a SearXNG server for research, or research will use this repository's brain, its files and links you paste."

/**
 * Where research searches, from the user's research settings: a SearXNG server when one is set (for `auto` too), or
 * none. Exa and Parallel through research come later, so they read as none here, with why.
 */
export function searchProvider(
  research: ConfigResearchV1.Info | undefined,
): { readonly provider: "searxng"; readonly url: string } | { readonly provider: "none"; readonly reason?: string } {
  const chosen = research?.search?.provider ?? "auto"
  const url = research?.search?.url?.trim()
  if ((chosen === "auto" || chosen === "searxng") && url && URL.canParse(url)) return { provider: "searxng", url }
  if (chosen === "exa" || chosen === "parallel") return { provider: "none", reason: NOT_YET }
  return { provider: "none" }
}

export const ResearchSearchTool = Tool.define<
  typeof Parameters,
  Metadata,
  ResearchRun.Service | ResearchStore.Service | Config.Service | HttpClient.HttpClient
>(
  "research_search",
  Effect.gen(function* () {
    const research = yield* ResearchRun.Service
    const store = yield* ResearchStore.Service
    const config = yield* Config.Service
    // A search is decided and logged as websearch-searxng while Vector Local is on: allowed when its server is listed,
    // and following Web access.
    const http = EgressHttpClient.make(yield* HttpClient.HttpClient)

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const found = yield* research.current(ctx)
          if ("refused" in found) return { title: "Not searched", output: found.refused, metadata: {} }
          const runID = found.run.id
          if (found.plan.scope === "brain")
            return {
              title: "Not searched",
              output:
                "This research's scope is the brain and the repository's files, so it searches nothing on the web.",
              metadata: { runID, refused: "scope" as const },
            }
          const provider = searchProvider((yield* config.get()).research)
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
          const results = yield* ResearchSearch.searxng(
            {
              query,
              ...(params.site ? { site: params.site } : {}),
              ...(params.recency ? { recency: params.recency } : {}),
              ...(params.limit ? { limit: params.limit } : {}),
            },
            {
              http,
              url: provider.url,
              context,
              // Vector Local decides the search server's address as the request is sent (websearch-searxng).
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
            },
          ).pipe(
            EgressHttpClient.labelled("websearch-searxng"),
            Effect.map((items) => ({ type: "results" as const, items })),
            // What the server or the network did, and the outbound check's own refusal, are answers; a declined
            // approval for a server on the user's network fails the call as any declined approval does.
            Effect.catchIf(
              (error): error is ResearchSearch.SearchFailed | ResearchSearch.QueryRefused =>
                error instanceof ResearchSearch.SearchFailed || error instanceof ResearchSearch.QueryRefused,
              (error) => Effect.succeed({ type: "failed" as const, message: error.message }),
            ),
          )
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
          return {
            title: `Searched: ${query}`,
            output: results.items.length
              ? `${results.items.length} result${results.items.length === 1 ? "" : "s"}. Read the useful ones with research_read.\n${WebFence.fenceWebPage(
                  { title: `Search results: ${query}`, tool: "research_search" },
                  listed.join("\n"),
                )}`
              : "No results. Try other words, or a broader query.",
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
