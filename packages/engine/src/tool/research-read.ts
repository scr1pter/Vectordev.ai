import { ResearchCanonical } from "@vectordevai/core/research/canonical"
import { WebFence } from "@vectordevai/core/research/fence"
import { ResearchOutbound } from "@vectordevai/core/research/outbound"
import { ResearchProvenance } from "@vectordevai/core/research/provenance"
import { ResearchReader } from "@vectordevai/core/research/reader"
import { ResearchSignals } from "@vectordevai/core/research/signals"
import { ResearchStore } from "@vectordevai/core/research/store"
import type { Research } from "@vectordevai/schema/research"
import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import type { Provider } from "@/provider/provider"
import { ResearchRun } from "./research-run"
import { Tool } from "./tool"
import DESCRIPTION from "./research-read.txt"

// research_read (section 5.4). An address must be in the run's provenance (a search result, a link a read offered, or
// one the user typed): research cannot write an address of its own, so a hostile page cannot steer it into putting
// private text in a URL, and the address also passes the outbound check. The run's first new page asks once ("Read
// public pages for this research"), for this run only. The page goes through the research reader (every redirect hop
// authorised, names pinned, an address on the user's own network asked about per origin), is saved in the run as S#,
// and comes back fenced. Reading a saved source again is free and makes no network call.

export const Parameters = Schema.Struct({
  url: Schema.optional(Schema.String).annotate({
    description: "An address from a search result, a link research_read offered, or the user's message",
  }),
  source: Schema.optional(Schema.String).annotate({
    description: 'A source this run saved, such as "S3", to read again',
  }),
  chunk: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "Which chunk to show (1 by default); the first read shows the outline with each section's chunk",
  }),
  focus: Schema.optional(Schema.String.check(Schema.isMaxLength(300))).annotate({
    description: "Show the 3 passages that best match these words instead of a chunk",
  }),
  find: Schema.optional(Schema.String.check(Schema.isMaxLength(200))).annotate({
    description: "Show short snippets around each place this text appears",
  }),
  links: Schema.optional(Schema.Boolean).annotate({
    description: "Also list the page's links, which then may be read",
  }),
  mode: Schema.optional(Schema.Literals(["auto", "fetch", "render"])).annotate({
    description: "auto (default) or fetch read the page directly; render needs the desktop browser",
  }),
})

type Metadata = {
  runID?: string
  source?: string
  url?: string
  status?: Research.SourceStatus
  /** Links this read offered, which join the run's provenance. */
  links?: string[]
  private?: boolean
  refused?: "provenance" | "outbound" | "scope" | "budget"
}

export const OUTBOUND =
  "That address would send text from your private context. Choose a result or a link that does not carry it."
export const RENDER =
  "Reading a page through the desktop browser is not available to research_read yet. Read it with mode fetch, or report it as needing the browser."
// The most links a read lists.
const MAX_LINKS = 60

export const ResearchReadTool = Tool.define<
  typeof Parameters,
  Metadata,
  ResearchRun.Service | ResearchStore.Service | HttpClient.HttpClient
>(
  "research_read",
  Effect.gen(function* () {
    const research = yield* ResearchRun.Service
    const store = yield* ResearchStore.Service
    const http = yield* HttpClient.HttpClient

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const found = yield* research.current(ctx)
          if ("refused" in found) return { title: "Not read", output: found.refused, metadata: {} }
          const runID = found.run.id
          const show = (saved: ResearchStore.Saved, extra: Metadata = {}) => ({
            title: `${saved.source.id}: ${saved.source.title || saved.source.site}`,
            output: savedText(saved, params),
            metadata: { runID, source: saved.source.id, url: saved.source.url, status: saved.source.status, ...extra },
          })

          if (params.source) {
            const saved = yield* store.source(found.place, runID, params.source)
            if (!saved)
              return { title: "Not read", output: `There is no ${params.source} in this run.`, metadata: { runID } }
            return show(saved)
          }
          if (!params.url)
            return {
              title: "Not read",
              output: 'Give the address to read, or a saved source such as "S3".',
              metadata: { runID },
            }
          if (found.plan.scope === "brain")
            return {
              title: "Not read",
              output: "This research's scope is the brain and the repository's files, so it reads no web pages.",
              metadata: { runID, refused: "scope" as const },
            }

          const checked = ResearchProvenance.check(yield* research.provenance(ctx, found), params.url)
          if (!checked.ok)
            return {
              title: "Not read",
              output: checked.message,
              metadata: { runID, url: params.url, refused: "provenance" as const },
            }
          const outbound = ResearchOutbound.address(checked.url, yield* research.context(ctx, found))
          if (!outbound.ok)
            return {
              title: "Not read",
              output: OUTBOUND,
              metadata: { runID, url: checked.url, refused: "outbound" as const },
            }

          // A page the run read is read again from what it saved.
          const known = found.detail.sources.find(
            (source) =>
              (source.canonical_url === checked.canonical ||
                ResearchCanonical.canonical(source.url) === checked.canonical) &&
              (source.status === "read" || source.status === "paywalled"),
          )
          if (known) {
            const saved = yield* store.source(found.place, runID, known.id)
            if (saved && !saved.forgotten) {
              const shown = show(saved)
              return params.links
                ? {
                    ...shown,
                    output: `${shown.output}\n\nThis run read ${saved.source.id} before, so its links were offered then.`,
                  }
                : shown
            }
          }
          if (params.mode === "render")
            return { title: "Not read", output: RENDER, metadata: { runID, url: checked.url } }
          // The store refuses a page past the budget too; asking it first spares the site a request.
          if (found.run.pages >= (yield* research.limits(found.plan.depth)).pages)
            return {
              title: "Page budget used",
              output: ResearchStore.PAGES,
              metadata: { runID, url: checked.url, refused: "budget" as const },
            }

          yield* research.approve(ctx, found, checked.url)
          yield* ctx.metadata({ title: `Reading ${checked.url}`, metadata: { runID, url: checked.url } })
          const model = ctx.extra?.model as Provider.Model | undefined
          const page = yield* ResearchReader.read(
            {
              url: checked.url,
              typed: checked.from === "typed",
              chunkTokens:
                (model?.limit.context ?? Infinity) < 32_000
                  ? ResearchReader.COMPACT_TOKENS
                  : ResearchReader.CHUNK_TOKENS,
            },
            {
              http,
              // Vector Local's Web access decides each hop once it is in force (phase L5); the reader itself refuses a
              // private destination research found, and a metadata address whoever asks.
              authorize: () => Effect.void,
              authorizePrivate: (url) =>
                ctx.ask({
                  permission: "private_network",
                  patterns: [new URL(url).origin],
                  always: [new URL(url).origin],
                  metadata: { url, tool: "research_read" },
                }),
              limiter: research.limiter(runID),
              ...(yield* research.robots().pipe(Effect.map((robots) => (robots ? { robots } : {})))),
              ...(research.network.resolver ? { resolver: research.network.resolver } : {}),
              ...(research.network.publicNames ? { publicNames: research.network.publicNames } : {}),
            },
          )
          const signals = ResearchSignals.signals({
            url: page.final,
            meta: page.meta,
            flagged: page.flagged.length,
            paywalled: page.status === "paywalled",
            corroborated: 0,
            ...(found.plan.prefer_domains ? { prefer: found.plan.prefer_domains } : {}),
            ...(found.plan.avoid_domains ? { avoid: found.plan.avoid_domains } : {}),
            now: Date.now(),
          })
          const added = yield* store.addSource(found.place, runID, {
            url: page.final,
            canonical: page.canonical,
            site: page.site,
            title: page.title,
            status: page.status,
            chunks: page.chunks,
            ...(page.reason ? { reason: page.reason } : {}),
            ...(page.format ? { format: page.format } : {}),
            ...(page.pages ? { pages: page.pages } : {}),
            private: page.private,
            fingerprint: page.fingerprint,
            meta: { author: page.meta.author, published: page.meta.published },
            signals,
            fetchedAt: Date.now(),
          })
          const links = params.links
            ? ResearchProvenance.offered(page.links)
                .slice(0, MAX_LINKS)
                .map((link) => link.url)
            : []
          if (added.type === "refused")
            return {
              title: "Not read",
              output: added.message,
              metadata: { runID, url: page.final, refused: "budget" as const },
            }
          if (added.type === "duplicate")
            return {
              title: `${added.source.id}: a copy of ${added.of}`,
              output: `${added.source.id} is a copy of ${added.of}, which this run already read. Read ${added.of} instead.`,
              metadata: { runID, source: added.source.id, url: page.final, status: "duplicate" as const },
            }
          // Another agent of the run read it meanwhile.
          if (added.type === "known") {
            const saved = yield* store.source(found.place, runID, added.source.id)
            if (saved && saved.chunks.length > 0) return show(saved)
          }
          const source = added.source
          if (page.status !== "read" && page.status !== "paywalled")
            return {
              title: `${source.id}: not read`,
              output: `${source.id} (${page.site}) was not read: ${(page.reason ?? page.status).replace(/\.+$/, "")}.`,
              metadata: { runID, source: source.id, url: page.final, status: page.status },
            }
          const passages = params.focus
            ? ResearchReader.focus(page.chunks, params.focus).map((item) => `[chunk ${item.chunk}]\n${item.passage}`)
            : params.find
              ? ResearchReader.find(page.chunks, params.find).map((item) => `[chunk ${item.chunk}] ${item.snippet}`)
              : undefined
          return {
            title: `${source.id}: ${page.title || page.site}`,
            output: [
              ResearchReader.present({
                page,
                source: source.id,
                ...(params.chunk ? { chunk: params.chunk } : {}),
                ...(passages ? { passages: passages.length ? passages : ["Nothing on this page matches."] } : {}),
                outline: params.chunk === undefined && !passages,
              }),
              ...signalLine(signals),
              ...(page.status === "paywalled" ? ["Paywalled: Vector kept the public excerpt only."] : []),
              ...(page.private
                ? ["This page is on your own computer or network, so its text stays out of searches and addresses."]
                : []),
              ...(links.length ? [linkList(page.final, links)] : []),
            ].join("\n\n"),
            metadata: {
              runID,
              source: source.id,
              url: page.final,
              status: page.status,
              ...(page.private ? { private: true } : {}),
              ...(links.length ? { links } : {}),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// What Vector noticed about the page, in its own words. A page's own strings (its author, an identifier) stay out of
// this line, which is outside the fence.
function signalLine(signal: Research.Signal) {
  const labels = ResearchSignals.labels(signal).filter(
    (label) => !label.startsWith("By ") && !/^(?:DOI|arXiv|PMID|Published) /.test(label),
  )
  return labels.length ? [`Signals: ${labels.join(" · ")}`] : []
}

// The links a read offers: the page's words, so fenced too.
function linkList(url: string, links: readonly string[]) {
  return `Links on this page (each may be read):\n${WebFence.fenceWebPage({ url, title: "Links", tool: "research_read" }, links.join("\n"))}`
}

// A saved source as research_read shows it: Vector's line about it, then its text in the fence.
function savedText(
  saved: ResearchStore.Saved,
  params: { readonly chunk?: number; readonly focus?: string; readonly find?: string },
) {
  const source = saved.source
  if (saved.forgotten) return `${source.id} was forgotten, so its text is gone.`
  if (saved.chunks.length === 0) return `${source.id} has no saved text (${source.reason ?? source.status}).`
  const total = saved.chunks.length
  const index = Math.min(Math.max(params.chunk ?? 1, 1), total)
  const body = params.focus
    ? ResearchReader.focus(saved.chunks, params.focus).map((item) => `[chunk ${item.chunk}]\n${item.passage}`)
    : params.find
      ? ResearchReader.find(saved.chunks, params.find).map((item) => `[chunk ${item.chunk}] ${item.snippet}`)
      : [saved.chunks[index - 1]!.text]
  const where =
    params.focus || params.find ? `${body.length} passage${body.length === 1 ? "" : "s"}` : `chunk ${index} of ${total}`
  const header = [
    source.id,
    source.site,
    source.signals?.published ? `published ${source.signals.published}` : undefined,
    source.pages ? `${source.pages} pages` : undefined,
    where,
    source.status === "read" ? undefined : source.status,
    "saved",
  ]
    .filter(Boolean)
    .join(" · ")
  return `${header}\n${WebFence.fenceWebPage(
    { url: source.url, title: source.title, tool: "research_read" },
    (body.length ? body : ["Nothing in this source matches."]).join("\n\n"),
  )}`
}
