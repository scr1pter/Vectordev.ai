import { ResearchOutbound } from "@vectordevai/core/research/outbound"
import { ResearchSearch } from "@vectordevai/core/research/search"
import { ResearchStore } from "@vectordevai/core/research/store"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { Research } from "@vectordevai/schema/research"
import { Effect, Option, Schema } from "effect"
import { Session } from "@/session/session"
import { SessionTaskSize } from "../session/task-size"
import { ResearchBrowser } from "./research-browser"
import { ResearchRun } from "./research-run"
import { Tool } from "./tool"
import DESCRIPTION from "./research-search.txt"

// research_search (sections 5.4, 5.6a and 5.7): research searches the web with Vector's own Chromium, in the calling
// agent's own research browser (the lead's, or each researcher's), through the bridge's POST /research as
// research.search. The desktop loads the results page for the query, Google's first and DuckDuckGo's HTML page once
// when Google asks for a check, shows a consent wall or a page it cannot read, and returns the organic results it read
// off the page; it never answers a check (research-browser.ts and research-search-page.ts there). There is no search
// service and no key.
//
// Here, before anything leaves: the query (with its site filter) passes the outbound check against the run's private
// context, then Vector Local's Web access as it is now decides each results page as research-browser traffic
// (ResearchSearch.reachable), and only then does the search count against the run's budget and go to the desktop. The
// results come back fenced, marked when the run already read them, and join the run's provenance (this call's metadata
// is the record), so research_read and research_browser may open them. Where there is no research browser (the CLI,
// WSL, a remote server, a headless run) nothing is searched, and the tool says so; research goes on with the brain and
// the addresses the user typed. `vector run --research --search none` searches nothing for its run.

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
  /** The results page that answered: google or duckduckgo. */
  engine?: string
  results?: ResearchRun.Result[]
  /** Every results page asked for a check or could not be read. */
  unavailable?: boolean
  refused?: "outbound" | "budget" | "scope" | "none" | "offline" | "desktop" | "local"
}

/** Where `vector run --research` puts its own choices for the run: a text part's metadata on its prompt. */
export const OPTIONS = ResearchRun.OPTIONS

/**
 * The search and scope `vector run --research` was given. Only `none` changes where research searches now: every
 * other search is the research browser's. A name the command line used to take reads as none given.
 */
export const Options = Schema.Struct({
  search: Schema.optional(Schema.String),
  scope: Schema.optional(Research.Scope),
})
export type Options = typeof Options.Type
const decodeOptions = Schema.decodeUnknownOption(Options)

export const SITE = ResearchSearch.SITE

/** Where research searches: in the agent's own research browser, or nowhere, with why. */
export type Provider = { readonly provider: "browser" } | { readonly provider: "none"; readonly reason: string }

/**
 * Where research searches: the agent's own research browser when this engine runs inside the desktop app, unless
 * `vector run --research --search none` asked for no search.
 */
export function searchProvider(input: { readonly browser: boolean; readonly chosen?: string }): Provider {
  if (input.chosen === "none") return { provider: "none", reason: ResearchSearch.NONE }
  if (!input.browser) return { provider: "none", reason: ResearchSearch.NEEDS_DESKTOP }
  return { provider: "browser" }
}

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
  ResearchRun.Service | ResearchStore.Service | Session.Service
>(
  "research_search",
  Effect.gen(function* () {
    const research = yield* ResearchRun.Service
    const store = yield* ResearchStore.Service
    const sessions = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const found = yield* research.current(ctx)
          if ("refused" in found) return { title: "Not searched", output: found.refused, metadata: {} }
          const runID = found.run.id
          // Not offered with Vector Local's Web access None; a run that began before it was set searches no more.
          if (ResearchRun.offline())
            return {
              title: "Not searched",
              output: ResearchRun.OFFLINE,
              metadata: { runID, refused: "offline" as const },
            }
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
          const provider = searchProvider({ browser: ResearchBrowser.available(), chosen: chosen.search })
          if (provider.provider === "none")
            return {
              title: chosen.search === "none" ? "Not searched" : "Needs the desktop browser",
              output: provider.reason,
              metadata: { runID, refused: chosen.search === "none" ? ("none" as const) : ("desktop" as const) },
            }
          if (params.site !== undefined && !ResearchSearch.site(params.site))
            return { title: "Not searched", output: SITE, metadata: { runID } }
          const query = params.query.trim()
          const asked: ResearchSearch.Query = {
            query,
            ...(params.site ? { site: params.site } : {}),
            ...(params.recency ? { recency: params.recency } : {}),
            ...(params.limit ? { limit: params.limit } : {}),
          }
          // Checked before it counts: a refused query was never sent.
          const checked = ResearchOutbound.check(ResearchSearch.words(asked), yield* research.context(ctx, found))
          if (!checked.ok)
            return {
              title: "Search refused",
              output: checked.message,
              metadata: { runID, query, refused: "outbound" as const },
            }
          // Vector Local's Web access as it is now, which the desktop's research proxy may not have yet: each results
          // page is research-browser traffic.
          const reachable = ResearchSearch.reachable(asked)
          if (reachable.engines.length === 0)
            return {
              title: "Search refused",
              output: [ResearchSearch.LOCAL, reachable.refused].filter(Boolean).join(" "),
              metadata: { runID, query, refused: "local" as const },
            }
          const counted = yield* store.searched(found.place, runID, query)
          if (counted.type === "refused")
            return {
              title: "Search budget used",
              output: counted.message,
              metadata: { runID, query, refused: "budget" as const },
            }
          yield* ctx.metadata({ title: `Searching: ${query}`, metadata: { runID, query, provider: "browser" } })
          const report = yield* ResearchBrowser.send({
            research,
            ctx,
            found,
            body: {
              command: "research.search",
              query: ResearchSearch.words(asked),
              ...(asked.recency ? { recency: asked.recency } : {}),
              limit: asked.limit ?? ResearchSearch.DEFAULT_RESULTS,
              engines: reachable.engines,
            },
          })
          const tried = (report.search?.tried ?? []).map((item) => item.reason)
          if (!report.ok)
            return report.search
              ? {
                  title: "Search unavailable",
                  output: [ResearchSearch.unavailable(report.search.tried), ...tried].join(" "),
                  metadata: { runID, query, provider: "browser", unavailable: true },
                }
              : {
                  title: "Search failed",
                  output: report.error ?? ResearchBrowser.BROWSER_DOWN,
                  metadata: { runID, query, provider: "browser" },
                }
          const items = ResearchSearch.clean(
            report.search?.results ?? [],
            asked.limit ?? ResearchSearch.DEFAULT_RESULTS,
          )
          const engine = report.search?.engine
          const name = engine ? ResearchSearch.NAMES[engine] : "the search engine"
          // Why another engine's page answered: what the one before it showed.
          const instead = tried.length ? ` ${tried.join(" ")} Vector searched ${name} instead.` : ""
          const read = new Map(found.detail.sources.map((source) => [source.canonical_url, source.id]))
          return {
            title: `Searched: ${query}`,
            output: items.length
              ? `${items.length} result${items.length === 1 ? "" : "s"} from ${name}. Read the useful ones with research_read.${instead}\n${ResearchSearch.listing(query, items, read)}`
              : `No results on ${name}. Try other words, or a broader query.${instead}`,
            metadata: {
              runID,
              query,
              provider: "browser",
              ...(engine ? { engine } : {}),
              results: items.map((item) => ({ url: item.url, title: item.title, snippet: item.snippet })),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
