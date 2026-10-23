export * as ResearchSource from "./research-source"

import { WebFence } from "@vectordevai/core/research/fence"
import { ResearchProvenance } from "@vectordevai/core/research/provenance"
import { ResearchReader } from "@vectordevai/core/research/reader"
import { ResearchSignals } from "@vectordevai/core/research/signals"
import { ResearchStore } from "@vectordevai/core/research/store"
import type { Research } from "@vectordevai/schema/research"
import { Effect } from "effect"
import type { ResearchRun } from "./research-run"

// A page research read, saved in its run as a source (S1, S2, ...) and shown to the agent: research_read's pages, and
// the pages a research browser or the user's own browser read for the run. Dedupe, the page budget and the store's
// "known" answer apply the same way to all of them, so research_note checks quotes from browsed pages just as it checks
// fetched ones. What the page says is shown fenced; Vector's own lines about it (signals, why it was not read) are
// outside the fence and hold none of the page's strings.

/** What research_read's metadata says of a read. */
export type Metadata = {
  runID?: string
  source?: string
  url?: string
  status?: Research.SourceStatus
  /** Links this read offered, which join the run's provenance. */
  links?: string[]
  private?: boolean
  refused?: "provenance" | "outbound" | "scope" | "budget" | "offline"
}

/** How a read is shown: a chunk, the passages that match some words, or snippets around a phrase. */
export type View = {
  readonly chunk?: number
  readonly focus?: string
  readonly find?: string
  /** Also list the page's links, which then may be read. */
  readonly links?: boolean
}

// The most links a read lists.
export const MAX_LINKS = 60

export const OUTBOUND =
  "That address would send text from your private context. Choose a result or a link that does not carry it."
export const SCOPE = "This research's scope is the brain and the repository's files, so it reads no web pages."
export const HIDDEN =
  "That source is for the research lead only: it was read in the user's own signed-in browser, or it is on their computer or network. Researchers read public pages; read a public address instead."

/**
 * Whether a saved source is kept from the agent asking (sections 5.6a and 6.4a): a researcher, a web worker, sees no
 * private source of the run and nothing read signed in. Only the lead holds those.
 */
export function hidden(saved: ResearchStore.Saved, lead: boolean) {
  return !lead && (saved.private || saved.source.signals?.signed_in === true)
}

/**
 * Saves a page the run read and shows it. `tool` names who read it in the fence; `signedIn` marks a page the user's own
 * signed-in browser showed, whose text is private context like a private document's. `lead` says whether the agent
 * reading is the run's lead, who alone is shown a private source another read saved.
 */
export const keep = Effect.fnUntraced(function* (input: {
  readonly research: ResearchRun.Interface
  readonly store: ResearchStore.Interface
  readonly found: ResearchRun.Found
  readonly page: ResearchReader.Page
  readonly view: View
  readonly lead: boolean
  readonly tool?: string
  readonly signedIn?: boolean
}) {
  const found = input.found
  const page = input.page
  const view = input.view
  const runID = found.run.id
  const secret = page.private || input.signedIn === true
  // "You trust this site" is Vector's own word beside the fence, so only sites the user chose earn it, never ones a
  // plan approved on its own named.
  const chosen = yield* input.research.domains(found)
  const signals = {
    ...ResearchSignals.signals({
      url: page.final,
      meta: page.meta,
      flagged: page.flagged.length,
      paywalled: page.status === "paywalled",
      corroborated: 0,
      prefer: chosen.prefer,
      avoid: chosen.avoid,
      now: Date.now(),
    }),
    ...(input.signedIn ? { signed_in: true } : {}),
  }
  const added = yield* input.store.addSource(found.place, runID, {
    url: page.final,
    canonical: page.canonical,
    site: page.site,
    title: page.title,
    status: page.status,
    chunks: page.chunks,
    ...(page.reason ? { reason: page.reason } : {}),
    ...(page.format ? { format: page.format } : {}),
    ...(page.pages ? { pages: page.pages } : {}),
    private: secret,
    fingerprint: page.fingerprint,
    meta: { author: page.meta.author, published: page.meta.published },
    signals,
    fetchedAt: Date.now(),
  })
  const links = view.links
    ? ResearchProvenance.offered(page.links)
        .slice(0, MAX_LINKS)
        .map((link) => link.url)
    : []
  if (added.type === "refused")
    return {
      title: "Not read",
      output: added.message,
      metadata: { runID, url: page.final, refused: "budget" } satisfies Metadata as Metadata,
    }
  if (added.type === "duplicate")
    return {
      title: `${added.source.id}: a copy of ${added.of}`,
      output: `${added.source.id} is a copy of ${added.of}, which this run already read. Read ${added.of} instead.`,
      metadata: { runID, source: added.source.id, url: page.final, status: "duplicate" } satisfies Metadata as Metadata,
    }
  // Another agent of the run read it meanwhile.
  if (added.type === "known") {
    const saved = yield* input.store.source(found.place, runID, added.source.id)
    if (saved && hidden(saved, input.lead))
      return {
        title: "Not read",
        output: HIDDEN,
        metadata: { runID, url: page.final } satisfies Metadata as Metadata,
      }
    if (saved && saved.chunks.length > 0) return shown(runID, saved, view)
  }
  const source = added.source
  if (page.status !== "read" && page.status !== "paywalled")
    return {
      title: `${source.id}: not read`,
      output: `${source.id} (${page.site}) was not read: ${(page.reason ?? page.status).replace(/\.+$/, "")}.`,
      metadata: { runID, source: source.id, url: page.final, status: page.status } satisfies Metadata as Metadata,
    }
  const passages = view.focus
    ? ResearchReader.focus(page.chunks, view.focus).map((item) => `[chunk ${item.chunk}]\n${item.passage}`)
    : view.find
      ? ResearchReader.find(page.chunks, view.find).map((item) => `[chunk ${item.chunk}] ${item.snippet}`)
      : undefined
  return {
    title: `${source.id}: ${page.title || page.site}`,
    output: [
      ResearchReader.present({
        page,
        source: source.id,
        ...(view.chunk ? { chunk: view.chunk } : {}),
        ...(passages ? { passages: passages.length ? passages : ["Nothing on this page matches."] } : {}),
        outline: view.chunk === undefined && !passages,
      }),
      ...signalLine(signals),
      ...(page.status === "paywalled" ? ["Paywalled: Vector kept the public excerpt only."] : []),
      ...(page.private
        ? ["This page is on your own computer or network, so its text stays out of searches and addresses."]
        : []),
      ...(input.signedIn
        ? [
            "This page was read in your own signed-in browser, so its text stays out of searches, addresses and researchers' sub-questions.",
          ]
        : []),
      ...(links.length ? [linkList(page.final, links, input.tool ?? "research_read")] : []),
    ].join("\n\n"),
    metadata: {
      runID,
      source: source.id,
      url: page.final,
      status: page.status,
      ...(secret ? { private: true } : {}),
      ...(links.length ? { links } : {}),
    } satisfies Metadata as Metadata,
  }
})

/** A saved source as a read shows it again: Vector's line about it, then its text in the fence. No network call. */
export function shown(runID: string, saved: ResearchStore.Saved, view: View) {
  return {
    title: `${saved.source.id}: ${saved.source.title || saved.source.site}`,
    output: savedText(saved, view),
    metadata: {
      runID,
      source: saved.source.id,
      url: saved.source.url,
      status: saved.source.status,
      ...(saved.private ? { private: true } : {}),
    } satisfies Metadata as Metadata,
  }
}

// What Vector noticed about the page, in its own words. A page's own strings (its author, an identifier) stay out of
// this line, which is outside the fence.
function signalLine(signal: Research.Signal) {
  const labels = ResearchSignals.labels(signal).filter(
    (label) => !label.startsWith("By ") && !/^(?:DOI|arXiv|PMID|Published) /.test(label),
  )
  return labels.length ? [`Signals: ${labels.join(" · ")}`] : []
}

// The links a read offers: the page's words, so fenced too.
function linkList(url: string, links: readonly string[], tool: string) {
  return `Links on this page (each may be read):\n${WebFence.fenceWebPage({ url, title: "Links", tool }, links.join("\n"))}`
}

function savedText(saved: ResearchStore.Saved, view: View) {
  const source = saved.source
  if (saved.forgotten) return `${source.id} was forgotten, so its text is gone.`
  if (saved.chunks.length === 0) return `${source.id} has no saved text (${source.reason ?? source.status}).`
  const total = saved.chunks.length
  const index = Math.min(Math.max(view.chunk ?? 1, 1), total)
  const body = view.focus
    ? ResearchReader.focus(saved.chunks, view.focus).map((item) => `[chunk ${item.chunk}]\n${item.passage}`)
    : view.find
      ? ResearchReader.find(saved.chunks, view.find).map((item) => `[chunk ${item.chunk}] ${item.snippet}`)
      : [saved.chunks[index - 1]!.text]
  const where =
    view.focus || view.find ? `${body.length} passage${body.length === 1 ? "" : "s"}` : `chunk ${index} of ${total}`
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
