export * as ResearchRun from "./research-run"

import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { ResearchOutbound } from "@vectordevai/core/research/outbound"
import { ResearchProvenance } from "@vectordevai/core/research/provenance"
import { ResearchRate } from "@vectordevai/core/research/rate"
import { ResearchReader } from "@vectordevai/core/research/reader"
import { ResearchRobots } from "@vectordevai/core/research/robots"
import { ResearchStore } from "@vectordevai/core/research/store"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import type { WebFetchRequest } from "@vectordevai/core/util/webfetch-request"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { Research } from "@vectordevai/schema/research"
import type { RunBudget } from "@vectordevai/schema/run-budget"
import { Context, Effect, Layer, Semaphore } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { Instruction } from "../session/instruction"
import { SessionMemory } from "../session/memory"
import { SessionID } from "../session/schema"
import { SubagentLifecycle } from "./subagent-lifecycle"
import type { Tool } from "./tool"

// The engine's side of a Deep research run (sections 5.4 and 5.6a). A run is keyed by its lead's session and the
// repository's brain, so the researchers the lead launches write into the lead's run. What the run may read and what
// it may send are worked out here from the history of every session in the run, so they hold across restarts and are
// the same in every research tool:
// - the run is the newest plan the lead's session approved (research_plan's completed call carries its id);
// - provenance is the run's search results, the links research_read offered, and addresses the user typed;
// - the outbound check's private context is everything private any agent of the run was given: the owner's personal
//   lines recalled or pinned for it (a researcher's how-you-work lines included), MEMORY.md, private document cards,
//   repository files read, pages read in the user's signed-in browser, and sources read from the user's own network.
//   Only the root user's typed words are exempt: a sub-question or a task brief is written by an agent.

export const LEAD = "research"
export const RESEARCHER = "researcher"
export const JUDGE = "research-judge"

/** research_plan's metadata key for the run it approved. */
export const RUN = "runID"

/** Caps for one run: its spend and steps, the pages and searches the store counts, and its researchers. */
export type Limits = {
  readonly usd: number
  readonly steps: number
  readonly pages: number
  readonly searches: number
  readonly researchers: number
}

/** Default caps for one run, used only when the user has no cap of their own (section 11.2). */
export const LIMITS: Readonly<Record<Research.Depth, Limits>> = {
  focused: { usd: 1, steps: 80, pages: 15, searches: 8, researchers: 2 },
  deep: { usd: 3, steps: 240, pages: 40, searches: 24, researchers: 4 },
}

/** What a researcher hands back to the lead, at most (section 5.3). */
export const RETURN_CHARS = 1_500

export const NO_PLAN =
  "Plan the research with research_plan first: nothing is searched or read before the plan is approved."
export const STOPPED = "This research was stopped. Plan a new run with research_plan only if the user asks for one."
export const READ_APPROVAL =
  "Read public pages for this research? Vector reads only pages from search results, links on pages it read, and addresses you typed. This approval lasts for this research only."
export const REQUEST_REFUSAL =
  "That research request would send text from what this session read. Rephrase the question with public terms, or ask the user to type the words they want researched."
export const BRIEF_REFUSAL =
  "That brief would send text from your private context to a web worker. Write the sub-question in public terms."

// How long a run keeps its own rate limiter after its last read, and how many runs keep one.
const LIMITERS = 16

/**
 * The network research reads through. Production resolves names with the system's resolver; tests give the fake web's
 * resolver and its domain as public names, as the reader's own tests do.
 */
export type Network = {
  readonly resolver?: WebFetchRequest.DestinationResolver
  readonly publicNames?: readonly string[]
}
export class NetworkService extends Context.Service<NetworkService, Network>()("@vector/ResearchNetwork") {}
export const networkNode = LayerNode.make({
  service: NetworkService,
  layer: Layer.succeed(NetworkService, {}),
  deps: [],
})

/** The run a research tool call works in. */
export type Found = {
  readonly place: Brain.Place
  /** The run's lead: the session that approved the plan. */
  readonly lead: Session.Info
  readonly run: Research.Run
  readonly plan: Research.Plan
  readonly detail: ResearchStore.Detail
}

/** The run a call works in, or why there is none. */
export type Current = Found | { readonly refused: string }

export type Brief =
  | { readonly type: "ok"; readonly prompt: string; readonly budget?: RunBudget.Info }
  | { readonly type: "refused"; readonly message: string }

export interface Interface {
  readonly place: () => Effect.Effect<Brain.Place>
  /** The run's lead: the session itself, or for a researcher or the judge the lead that launched it. */
  readonly lead: (sessionID: SessionID) => Effect.Effect<Session.Info>
  /** The run this call works in, or why there is none to work in. */
  readonly current: (ctx: Tool.Context) => Effect.Effect<Current>
  /** The outbound check's context: the run's, or without a run the calling session's alone. */
  readonly context: (ctx: Tool.Context, found?: Found) => Effect.Effect<ResearchOutbound.Context>
  /** The addresses the run may read. */
  readonly provenance: (ctx: Tool.Context, found: Found) => Effect.Effect<ResearchProvenance.Addresses>
  /** Asks once per run before its first page is read. The approval is never saved. */
  readonly approve: (ctx: Tool.Context, found: Found, url: string) => Effect.Effect<void>
  readonly limiter: (runID: string) => ResearchRate.Limiter
  readonly robots: () => Effect.Effect<ResearchRobots.Cache | undefined>
  readonly network: Network
  /** The run's page and search budget, from the user's config or the defaults for its depth. */
  readonly limits: (depth: Research.Depth) => Effect.Effect<Limits>
  /**
   * A task brief for a research agent, before the child starts: the lead's request or a researcher's sub-question,
   * checked against what the caller may not send, and a researcher's brief cut to the sub-question and the run's
   * public preferences.
   */
  readonly brief: (input: {
    readonly agent: string
    readonly ctx: Tool.Context
    readonly prompt: string
    /** The rest of the brief the caller wrote (success criteria, a context pack), checked with the prompt. */
    readonly extra: readonly string[]
    readonly resume?: string
  }) => Effect.Effect<Brief>
  /** What a researcher returns to the lead: at most 1,500 characters, and the notes it saved. */
  readonly returned: (sessionID: SessionID, text: string) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@vector/ResearchRun") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const brain = yield* Brain.Service
    const knowledge = yield* BrainKnowledge.Service
    const instruction = yield* Instruction.Service
    const store = yield* ResearchStore.Service
    const guests = yield* FreeModelGuests.Service
    const config = yield* Config.Service
    const guard = yield* SpendGuard.Service
    const http = yield* HttpClient.HttpClient
    const network = yield* NetworkService

    // Runs whose user approved reading public pages, in this process. A restart asks once more.
    const approved = new Set<string>()
    const approving = new Map<string, Semaphore.Semaphore>()
    const limiters = new Map<string, ResearchRate.Limiter>()
    const cached: { robots?: ResearchRobots.Cache } = {}
    // The text of a run's pages, kept while its count of readable sources is the same.
    const pages = new Map<
      string,
      {
        readonly count: number
        readonly text: { readonly open: readonly string[]; readonly closed: readonly string[] }
      }
    >()

    const place = () => instruction.place()

    const lead = Effect.fn("ResearchRun.lead")(function* (sessionID: SessionID) {
      const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
      const agent = SubagentLifecycle.read(session)?.agent ?? session.agent
      if (session.parentID && (agent === RESEARCHER || agent === JUDGE))
        return yield* sessions.get(session.parentID).pipe(Effect.orDie)
      return session
    })

    // The session the user types in: the run's lead in Deep research, or the build session that handed it a question.
    const top = Effect.fn("ResearchRun.top")(function* (sessionID: SessionID) {
      let session = yield* sessions.get(sessionID).pipe(Effect.orDie)
      for (let depth = 0; session.parentID && depth < 4; depth++)
        session = yield* sessions.get(session.parentID).pipe(Effect.orDie)
      return session
    })

    const history = (ctx: Tool.Context, sessionID: SessionID) =>
      sessionID === ctx.sessionID
        ? Effect.succeed(ctx.messages)
        : sessions.messages({ sessionID }).pipe(Effect.catch(() => Effect.succeed([] as SessionV1.WithParts[])))

    // Every session of the run: the lead and the research agents it launched.
    const members = Effect.fn("ResearchRun.members")(function* (ctx: Tool.Context, leader: Session.Info) {
      const children = (yield* sessions.children(leader.id)).filter((child) => {
        const agent = SubagentLifecycle.read(child)?.agent ?? child.agent
        return agent === RESEARCHER || agent === JUDGE
      })
      return yield* Effect.forEach([leader.id, ...children.map((child) => child.id)], (id) => history(ctx, id))
    })

    const typedOf = Effect.fn("ResearchRun.typed")(function* (ctx: Tool.Context) {
      const root = yield* top(ctx.sessionID)
      const messages = yield* history(ctx, root.id)
      return messages.flatMap((message) =>
        message.info.role === "user" ? [SessionMemory.typed(message)].filter(Boolean) : [],
      )
    })

    const current = Effect.fn("ResearchRun.current")(function* (ctx: Tool.Context) {
      const where = yield* place()
      const leader = yield* lead(ctx.sessionID)
      const messages = yield* history(ctx, leader.id)
      // The newest plan call decides: one the user has not approved yet (a steer, a cancel) leaves nothing to work in.
      const planned = messages
        .flatMap((message) => message.parts)
        .findLast(
          (part): part is SessionV1.ToolPart =>
            part.type === "tool" && part.tool === "research_plan" && part.state.status === "completed",
        )
      const runID =
        planned?.state.status === "completed" && typeof planned.state.metadata[RUN] === "string"
          ? planned.state.metadata[RUN]
          : undefined
      if (!runID) return refuse(NO_PLAN)
      const detail = yield* store.get(where, runID)
      if (!detail) return refuse(ResearchStore.NO_RUN)
      if (detail.run.status === "stopped" || detail.run.status === "failed") return refuse(STOPPED)
      // A session an invited guest has acted in keeps nothing of its research in the brain.
      if (!detail.guest && ((yield* guests.marked(leader.id)) || (yield* guests.marked(ctx.sessionID))))
        yield* store.guest(where, runID)
      const plan = detail.run.plan
      if (!plan) return refuse(NO_PLAN)
      return { place: where, lead: leader, run: detail.run, plan, detail } satisfies Found as Current
    })

    const context = Effect.fn("ResearchRun.context")(function* (ctx: Tool.Context, found?: Found) {
      const where = found?.place ?? (yield* place())
      const messages = found ? yield* members(ctx, found.lead) : [ctx.messages]
      const parts = messages.flat().flatMap((message) => message.parts)
      const root = yield* top(ctx.sessionID)
      const guest = (yield* guests.marked(root.id)) || (yield* guests.marked(ctx.sessionID))
      const cfg = yield* config.get()

      // The owner's personal lines this run was given: recalled into a message, found by the memory tool, or pinned in
      // a digest. How-you-work preferences are the work; decisions, lessons, facts and private entries are private.
      const recalled = new Set(
        parts.flatMap((part) => [...(SessionMemory.recall(part)?.personal ?? []), ...SessionMemory.personal(part)]),
      )
      const entries = guest
        ? []
        : (yield* brain.list(where, { scope: "personal" })).filter(
            (entry) => recalled.has(entry.id) || (entry.pinned && entry.status === "active"),
          )
      const habit = (entry: (typeof entries)[number]) =>
        !entry.private && (entry.kind === "preference" || entry.kind === "review")
      const files = brain.files()
      const memory = guest ? "" : yield* text(files.memory)
      const rules = yield* text(files.rules)

      // Document cards and passages the run was shown: a private document's are private, the repository's the work.
      const cards = [
        ...new Set(
          parts.flatMap((part) => {
            const known = SessionMemory.knowledge(part)
            return [
              ...(SessionMemory.recall(part)?.cards ?? []),
              ...(known?.cards ?? []),
              ...(known?.get.map((item) => item.id) ?? []),
            ]
          }),
        ),
      ]
      const shown = cards.length
        ? yield* knowledge.lines(where, cards, { personal: !guest, sessionID: ctx.sessionID })
        : new Map<string, string>()
      const visible = yield* Effect.forEach(cards, (id) =>
        knowledge.sources(where, [id]).pipe(
          Effect.map((found) => ({
            id,
            private:
              found.documents.length === 0 || found.documents.some((document) => document.visibility === "private"),
          })),
        ),
      )
      const card = (secret: boolean) =>
        visible.flatMap((item) => (item.private === secret && shown.get(item.id) ? [shown.get(item.id)!] : []))

      const outputs = (tools: readonly string[]) =>
        parts.flatMap((part) =>
          part.type === "tool" && tools.includes(part.tool) && part.state.status === "completed"
            ? [part.state.output]
            : [],
        )
      const sources = found ? yield* sourceText(found) : { open: [] as string[], closed: [] as string[] }
      const results = parts.flatMap((part) => resultsOf(part, found?.run.id))
      return {
        private: [
          memory,
          ...entries.filter((entry) => !habit(entry)).map((entry) => entry.text),
          ...card(true),
          // What the lead read in the user's own browser, signed in, is private like a private document.
          ...outputs(["browser"]),
          ...sources.closed,
        ].filter(Boolean),
        work: [
          rules,
          ...entries.filter(habit).map((entry) => entry.text),
          ...card(false),
          ...outputs(["read", "grep", "glob", "list"]),
        ].filter(Boolean),
        typed: yield* typedOf(ctx),
        public: [...results.flatMap((result) => [result.title, result.snippet]), ...sources.open],
        domains: [
          ...(found?.plan.prefer_domains ?? []),
          ...(found?.plan.avoid_domains ?? []),
          ...(cfg.research?.domains?.prefer ?? []),
          ...(cfg.research?.domains?.avoid ?? []),
        ],
      } satisfies ResearchOutbound.Context
    })

    // The text of the run's pages: what was read on the user's own network is private, the rest public.
    const sourceText = Effect.fn("ResearchRun.sourceText")(function* (found: Found) {
      const readable = found.detail.sources.filter(
        (source) => (source.status === "read" || source.status === "paywalled") && !source.forgotten,
      )
      const known = pages.get(found.run.id)
      if (known && known.count === readable.length) return known.text
      const saved = yield* Effect.forEach(readable, (source) => store.source(found.place, found.run.id, source.id))
      const text = {
        open: saved.flatMap((item) => (item && !item.private ? item.chunks.map((chunk) => chunk.text) : [])),
        closed: saved.flatMap((item) => (item?.private ? item.chunks.map((chunk) => chunk.text) : [])),
      }
      pages.set(found.run.id, { count: readable.length, text })
      if (pages.size > LIMITERS) pages.delete(pages.keys().next().value!)
      return text
    })

    const provenance = Effect.fn("ResearchRun.provenance")(function* (ctx: Tool.Context, found: Found) {
      const parts = (yield* members(ctx, found.lead)).flat().flatMap((message) => message.parts)
      const typed = (yield* typedOf(ctx)).flatMap(ResearchProvenance.typed)
      const results = parts.flatMap((part) => resultsOf(part, found.run.id).map((result) => result.url))
      const links = parts.flatMap((part) => linksOf(part, found.run.id))
      return ResearchProvenance.add(
        ResearchProvenance.add(ResearchProvenance.add(ResearchProvenance.empty(), results, "search"), links, "link"),
        typed,
        "typed",
      )
    })

    const approve = Effect.fn("ResearchRun.approve")(function* (ctx: Tool.Context, found: Found, url: string) {
      if (approved.has(found.run.id)) return
      const lock = approving.get(found.run.id) ?? Semaphore.makeUnsafe(1)
      approving.set(found.run.id, lock)
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (approved.has(found.run.id)) return
          // Scoped to the run and never saved: there is nothing for "Always" to keep.
          yield* ctx.ask({
            permission: "research_read",
            patterns: [found.run.id],
            always: [],
            metadata: { runID: found.run.id, url, question: found.plan.question, description: READ_APPROVAL },
          })
          approved.add(found.run.id)
        }),
      )
      approving.delete(found.run.id)
    })

    const limiter = (runID: string) => {
      const known = limiters.get(runID)
      limiters.delete(runID)
      const next = known ?? ResearchRate.make()
      limiters.set(runID, next)
      if (limiters.size > LIMITERS) limiters.delete(limiters.keys().next().value!)
      return next
    }

    const robots = Effect.fn("ResearchRun.robots")(function* () {
      if ((yield* config.get()).research?.robots === false) return undefined
      cached.robots ??= ResearchReader.robots({ http, resolver: network.resolver, publicNames: network.publicNames })
      return cached.robots
    })

    const limits = Effect.fn("ResearchRun.limits")(function* (depth: Research.Depth) {
      const own = (yield* config.get()).research?.limits?.[depth]
      return { ...LIMITS[depth], ...own } satisfies Limits
    })

    const brief = Effect.fn("ResearchRun.brief")(function* (input: {
      readonly agent: string
      readonly ctx: Tool.Context
      readonly prompt: string
      readonly extra: readonly string[]
      readonly resume?: string
    }) {
      const text = [input.prompt, ...input.extra].join("\n")
      if (input.agent === LEAD) {
        // The lead starts with only what this request says, so the request must not carry private text with it.
        const checked = ResearchOutbound.check(text, yield* context(input.ctx))
        if (!checked.ok) return { type: "refused", message: refusal(REQUEST_REFUSAL, checked) } satisfies Brief
        // The lead stays at its launcher's size: a deep run (and its default caps) only from a Thorough request.
        const size = input.ctx.extra?.taskSize
        const depth: Research.Depth =
          size && typeof size === "object" && "tier" in size && size.tier === "thorough" ? "deep" : "focused"
        const own = (yield* guard.snapshot(input.ctx.sessionID))?.budget
        const caps = yield* limits(depth)
        return {
          type: "ok",
          prompt: input.prompt,
          // Research's default caps apply only when the user set none of their own.
          ...(own?.usd === undefined && own?.steps === undefined
            ? { budget: { usd: caps.usd, steps: caps.steps } }
            : {}),
        } satisfies Brief
      }
      if (input.agent !== RESEARCHER) return { type: "ok", prompt: input.prompt } satisfies Brief
      if (input.ctx.agent !== LEAD)
        return {
          type: "refused",
          message: "Only the research lead launches researchers, inside its run.",
        } satisfies Brief
      const found = yield* current(input.ctx)
      if ("refused" in found) return { type: "refused", message: found.refused } satisfies Brief
      if (!input.resume) {
        const started = (yield* sessions.children(found.lead.id)).filter(
          (child) => (SubagentLifecycle.read(child)?.agent ?? child.agent) === RESEARCHER,
        ).length
        const cap = (yield* limits(found.plan.depth)).researchers
        if (started >= cap)
          return {
            type: "refused",
            message: `This ${found.plan.depth} research has its ${cap} researcher${cap === 1 ? "" : "s"}. Research the rest yourself, or resume one with task_id.`,
          } satisfies Brief
      }
      const checked = ResearchOutbound.check(text, yield* context(input.ctx, found))
      if (!checked.ok) return { type: "refused", message: refusal(BRIEF_REFUSAL, checked) } satisfies Brief
      // A researcher gets its sub-question and the run's public preferences, nothing else of the lead's context.
      return {
        type: "ok",
        prompt: [
          "<research_assignment>",
          `Research question: ${found.plan.question}`,
          `Your sub-question: ${input.prompt.trim()}`,
          ...(found.plan.prefer_domains?.length ? [`Prefer sources on: ${found.plan.prefer_domains.join(", ")}`] : []),
          ...(found.plan.avoid_domains?.length ? [`Avoid sources on: ${found.plan.avoid_domains.join(", ")}`] : []),
          ...(found.plan.time_window ? [`Time window: ${found.plan.time_window}`] : []),
          `Save what you find with research_note, then return at most ${RETURN_CHARS} characters with the note IDs you saved.`,
          "</research_assignment>",
        ].join("\n"),
      } satisfies Brief
    })

    const returned = Effect.fn("ResearchRun.returned")(function* (sessionID: SessionID, text: string) {
      const notes = (yield* sessions
        .messages({ sessionID })
        .pipe(Effect.catch(() => Effect.succeed([] as SessionV1.WithParts[]))))
        .flatMap((message) => message.parts)
        .flatMap((part) =>
          part.type === "tool" &&
          part.tool === "research_note" &&
          part.state.status === "completed" &&
          typeof part.state.metadata?.note === "string"
            ? [part.state.metadata.note as string]
            : [],
        )
      const trimmed = text.trim()
      const clipped = trimmed.length > RETURN_CHARS ? `${trimmed.slice(0, RETURN_CHARS - 1).trimEnd()}…` : trimmed
      return notes.length ? `${clipped}\n\nNotes saved: ${[...new Set(notes)].join(", ")}` : clipped
    })

    return Service.of({
      place,
      lead,
      current,
      context,
      provenance,
      approve,
      limiter,
      robots,
      network,
      limits,
      brief,
      returned,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Session.node,
    Brain.node,
    BrainKnowledge.node,
    Instruction.node,
    ResearchStore.node,
    FreeModelGuests.node,
    Config.node,
    SpendGuard.node,
    httpClient,
    networkNode,
  ],
})

/** A search result research_search recorded for a run. */
export type Result = { readonly url: string; readonly title: string; readonly snippet: string }

/** The search results a research_search call of this run recorded. */
export function resultsOf(part: SessionV1.Part, runID: string | undefined): Result[] {
  if (part.type !== "tool" || part.tool !== "research_search" || part.state.status !== "completed") return []
  if (runID !== undefined && part.state.metadata?.[RUN] !== runID) return []
  const results = part.state.metadata?.results
  return Array.isArray(results)
    ? results.flatMap((item: unknown) =>
        item && typeof item === "object" && "url" in item && typeof item.url === "string"
          ? [
              {
                url: item.url,
                title: "title" in item && typeof item.title === "string" ? item.title : "",
                snippet: "snippet" in item && typeof item.snippet === "string" ? item.snippet : "",
              },
            ]
          : [],
      )
    : []
}

/** The links a research tool call of this run offered: research_read's, and the research browser's ("via S#"). */
export function linksOf(part: SessionV1.Part, runID: string): string[] {
  if (part.type !== "tool" || (part.tool !== "research_read" && part.tool !== "research_browser")) return []
  if (part.state.status !== "completed" || part.state.metadata?.[RUN] !== runID) return []
  const links = part.state.metadata?.links
  return Array.isArray(links) ? links.filter((link: unknown): link is string => typeof link === "string") : []
}

function refuse(message: string): Current {
  return { refused: message }
}

function refusal(message: string, checked: Extract<ResearchOutbound.Result, { ok: false }>) {
  return checked.reason === "secret"
    ? `${message} It holds a password, key or token.`
    : `${message} It shares "${checked.match}".`
}

const text = (file: string) =>
  Effect.promise(() =>
    Bun.file(file)
      .text()
      .catch(() => ""),
  )
