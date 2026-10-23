export * as ResearchRunV2 from "./research-run"

import path from "path"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { HttpClient } from "effect/unstable/http"
import { ToolFailure } from "@vectordevai/llm"
import { Research } from "@vectordevai/schema/research"
import type { Brain } from "../brain/brain"
import { BrainPaths } from "../brain/paths"
import { Config } from "../config"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { LayerNodePlatform } from "../effect/app-node-platform"
import { FreeModelGuests } from "../free-model-guests"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { EgressHttpClient } from "../local-mode/http-client"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { Project } from "../project"
import { ResearchNetwork } from "../research/network"
import { ResearchOutbound } from "../research/outbound"
import { ResearchPlan } from "../research/plan"
import { ResearchProvenance } from "../research/provenance"
import { ResearchRate } from "../research/rate"
import { ResearchReader } from "../research/reader"
import { ResearchRobots } from "../research/robots"
import { ResearchStore } from "../research/store"
import type { SessionMessage } from "../session/message"
import type { SessionSchema } from "../session/schema"
import { SessionContextEpochTable } from "../session/sql"
import { SessionStore } from "../session/store"
import type { Tool } from "./tool"

// The V2 runner's side of a Deep research run (sections 5.4 and 5.6a), as the engine's ResearchRun is the V1 runner's.
// A run is keyed by its lead's session and the repository's brain, and the store is the same one, so a run reads and
// stores the same on either runner. What the run may read and what it may send are worked out from the lead's whole
// durable conversation (compactions included), so they hold across restarts and are the same in every research tool:
// - the run is the newest plan the lead's session approved (research_plan's completed call records its id);
// - provenance is the run's search results, the links research_read offered, and addresses the user typed;
// - the outbound check's private context is everything the session took in that is not known to be public: every
//   tool's output but the web's (files read, commands run, other tools' answers), files attached to a prompt, the
//   ambient instructions in its system prompt, and pages read from the user's own network. The user's own global
//   instructions are private facts; the repository's are the work. Only the root user's typed words are exempt.
// This runner has no task tool, so a run has its lead alone: no researchers and no judge.

/** The run a research tool call works in. */
export type Found = {
  readonly place: Brain.Place
  /** The run's lead: the session that approved the plan. */
  readonly lead: SessionSchema.Info
  readonly run: Research.Run
  readonly plan: Research.Plan
  readonly detail: ResearchStore.Detail
  /** The user approved the plan on its card; otherwise it was approved on its own (a child or a headless run). */
  readonly approvedByUser: boolean
  /** The lead's whole conversation, compactions included. */
  readonly messages: readonly SessionMessage.Message[]
}

/** The run a call works in, or why there is none. */
export type Current = Found | { readonly refused: string }

/** The sites the user chose for research: what may become a site: filter, and what reads as "You trust this site". */
export type Domains = { readonly prefer: readonly string[]; readonly avoid: readonly string[] }

/** A completed tool call, with what it recorded and the text the model read. */
export type Call = {
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
  readonly structured: Readonly<Record<string, unknown>>
  readonly text: string
}

/** A search result research_search recorded for a run. */
export type Result = { readonly url: string; readonly title: string; readonly snippet: string }

export interface Interface {
  readonly place: () => Brain.Place
  /** The run this call works in, or why there is none to work in. */
  readonly current: (context: Tool.Context) => Effect.Effect<Current>
  /** The outbound check's context: the run's, or without a run the calling session's. */
  readonly context: (context: Tool.Context, found?: Found) => Effect.Effect<ResearchOutbound.Context>
  /** The addresses the run may read. */
  readonly provenance: (context: Tool.Context, found: Found) => Effect.Effect<ResearchProvenance.Addresses>
  readonly settings: () => Effect.Effect<ResearchPlan.Settings>
  /**
   * The sites the user chose: their own config's, and the plan's when they approved it on its card. A repository's
   * avoid list and a plan an agent approved on its own choose nothing.
   */
  readonly domains: (found?: Found) => Effect.Effect<Domains>
  /** The run's caps, from the user's own config or the defaults for its depth. */
  readonly limits: (depth: Research.Depth) => Effect.Effect<ResearchPlan.Limits>
  /** Asks once per run before its first page is read. The approval is never saved. */
  readonly approve: (context: Tool.Context, found: Found, url: string) => Effect.Effect<void, ToolFailure>
  readonly limiter: (runID: string) => ResearchRate.Limiter
  readonly robots: () => Effect.Effect<ResearchRobots.Cache | undefined>
  readonly network: ResearchNetwork.Network
  /** An invited guest acted in the session, so it keeps nothing of its research in the brain. */
  readonly guest: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@vector/v2/ResearchRun") {}

export const DECLINED = "The user did not approve reading pages for this research, so nothing was read."

// How many runs keep a rate limiter and their pages' text in memory, and how deep a session tree is walked to the
// session the user types in.
const KEPT = 16
const DEPTH = 4

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* SessionStore.Service
    const store = yield* ResearchStore.Service
    const config = yield* Config.Service
    const location = yield* Location.Service
    const guests = yield* FreeModelGuests.Service
    const permission = yield* PermissionV2.Service
    const global = yield* Global.Service
    const network = yield* ResearchNetwork.Service
    const db = (yield* Database.Service).db
    // robots.txt is read for research, so its requests are research-reader's wherever the check runs.
    const http = HttpClient.transform(
      EgressHttpClient.make(yield* HttpClient.HttpClient),
      EgressHttpClient.labelled("research-reader"),
    )

    // Runs whose user approved reading public pages, in this Location. A restart asks once more.
    const approved = new Set<string>()
    const approving = new Map<string, Semaphore.Semaphore>()
    const limiters = new Map<string, ResearchRate.Limiter>()
    const cached: { robots?: ResearchRobots.Cache } = {}
    // The text of a run's pages, kept while its count of readable sources is the same.
    const pages = new Map<string, { readonly count: number; readonly text: Text }>()

    // Every worktree of a repository shares its brain; a folder outside git has its own, as the V1 runner keys it.
    const place = (): Brain.Place => ({
      repository:
        location.project.id === Project.ID.global ? BrainPaths.folderKey(location.directory) : location.project.id,
      root:
        location.project.directory === path.parse(location.project.directory).root
          ? location.directory
          : location.project.directory,
      sources: [],
      held: false,
    })

    const history = (sessionID: SessionSchema.ID) =>
      sessions.all(sessionID).pipe(Effect.orElseSucceed((): SessionMessage.Message[] => []))

    // The session the user types in: the session itself, or the one above a child session.
    const top = (sessionID: SessionSchema.ID, depth = 0): Effect.Effect<SessionSchema.Info | undefined> =>
      sessions
        .get(sessionID)
        .pipe(
          Effect.flatMap((session) =>
            session?.parentID && depth < DEPTH ? top(session.parentID, depth + 1) : Effect.succeed(session),
          ),
        )

    // What the user typed: the root session's prompts. Vector writes a helper session's, and a launching agent a
    // child's, so neither is typed.
    const typedOf = Effect.fn("ResearchRunV2.typed")(function* (sessionID: SessionSchema.ID) {
      const root = yield* top(sessionID)
      if (!root || root.internal) return []
      return (yield* history(root.id)).flatMap((message) =>
        message.type === "user" && message.text.trim() ? [message.text] : [],
      )
    })

    const current = Effect.fn("ResearchRunV2.current")(function* (context: Tool.Context) {
      const lead = yield* sessions.get(context.sessionID)
      if (!lead) return refuse(ResearchStore.NO_RUN)
      const messages = yield* history(lead.id)
      // The newest plan call decides: one the user has not approved yet (a steer, a cancel) leaves nothing to work in.
      const plans = calls(messages, "research_plan")
      const runID = text(plans.at(-1)?.structured.runID)
      if (!runID) return refuse(ResearchPlan.NO_PLAN)
      const where = place()
      const detail = yield* store.get(where, runID)
      if (!detail) return refuse(ResearchStore.NO_RUN)
      if (detail.run.status === "stopped" || detail.run.status === "failed") return refuse(ResearchPlan.STOPPED)
      // A session an invited guest has acted in keeps nothing of its research in the brain.
      if (!detail.guest && (yield* guests.marked(lead.id))) yield* store.guest(where, runID)
      const plan = detail.run.plan
      if (!plan) return refuse(ResearchPlan.NO_PLAN)
      // Approved on its own unless the user answered the card; a status-only call keeps the earlier approval.
      const approvedByUser = plans.some(
        (call) =>
          call.structured.runID === runID &&
          (call.structured.answer === "start" || call.structured.answer === "start-deep"),
      )
      return {
        place: where,
        lead,
        run: detail.run,
        plan,
        detail,
        approvedByUser,
        messages,
      } satisfies Found as Current
    })

    const settings = Effect.fn("ResearchRunV2.settings")(function* () {
      return ResearchPlan.settings(yield* config.entries(), config.scope)
    })

    const domains = Effect.fn("ResearchRunV2.domains")(function* (found?: Found) {
      const chosen = yield* settings()
      const avoided = new Set((chosen.own.domains?.avoid ?? []).map(ResearchPlan.normal))
      // Every plan carries the repository's avoid list too, so a site only a repository avoids is left out of it here.
      const repository = new Set(chosen.avoid.map(ResearchPlan.normal).filter((domain) => !avoided.has(domain)))
      const plan = found?.approvedByUser ? found.plan : undefined
      return {
        prefer: [
          ...new Set([...(chosen.own.domains?.prefer ?? []), ...(plan?.prefer_domains ?? [])].map(ResearchPlan.normal)),
        ].filter(Boolean),
        avoid: [
          ...new Set([
            ...avoided,
            ...(plan?.avoid_domains ?? []).map(ResearchPlan.normal).filter((domain) => !repository.has(domain)),
          ]),
        ].filter(Boolean),
      } satisfies Domains
    })

    const limits = Effect.fn("ResearchRunV2.limits")(function* (depth: Research.Depth) {
      return ResearchPlan.limits(yield* settings(), depth)
    })

    // The text of the run's pages: what was read on the user's own network is private, the rest public.
    const sourceText = Effect.fn("ResearchRunV2.sourceText")(function* (found: Found) {
      const readable = found.detail.sources.filter(
        (source) => (source.status === "read" || source.status === "paywalled") && !source.forgotten,
      )
      const known = pages.get(found.run.id)
      if (known && known.count === readable.length) return known.text
      const saved = yield* Effect.forEach(readable, (source) => store.source(found.place, found.run.id, source.id))
      const value = {
        open: saved.flatMap((item) => (item && !item.private ? item.chunks.map((chunk) => chunk.text) : [])),
        closed: saved.flatMap((item) => (item?.private ? item.chunks.map((chunk) => chunk.text) : [])),
      }
      pages.set(found.run.id, { count: readable.length, text: value })
      if (pages.size > KEPT) pages.delete(pages.keys().next().value!)
      return value
    })

    // The ambient instructions the session's system prompt carries, as its context epoch last recorded them: the
    // user's own global instructions are private facts, everything else in the baseline (the repository's instructions,
    // the working directory) is the work.
    const instructions = Effect.fn("ResearchRunV2.instructions")(function* (sessionID: SessionSchema.ID) {
      const epoch = yield* db
        .select({ baseline: SessionContextEpochTable.baseline, snapshot: SessionContextEpochTable.snapshot })
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!epoch) return { private: [], work: [] }
      const files = Option.getOrElse(decodeFiles(epoch.snapshot["core/instructions"]?.value), () => [])
      return {
        private: files.flatMap((file) => (FSUtil.contains(global.config, file.path) ? [file.content] : [])),
        work: [epoch.baseline],
      }
    })

    const context = Effect.fn("ResearchRunV2.context")(function* (context: Tool.Context, found?: Found) {
      const messages = found?.messages ?? (yield* history(context.sessionID))
      const taken = messages.map(intake)
      const ambient = yield* instructions(context.sessionID)
      const sources = found ? yield* sourceText(found) : { open: [], closed: [] }
      const results = resultsOf(messages, found?.run.id)
      const chosen = yield* domains(found)
      return {
        private: [...taken.flatMap((item) => item.private), ...sources.closed, ...ambient.private].filter(Boolean),
        work: [place().root, ...ambient.work, ...taken.flatMap((item) => item.work)].filter(Boolean),
        typed: yield* typedOf(context.sessionID),
        public: [...results.flatMap((result) => [result.title, result.snippet]), ...sources.open],
        // The user's own sites become site: filters.
        domains: [...chosen.prefer, ...chosen.avoid],
      } satisfies ResearchOutbound.Context
    })

    const provenance = Effect.fn("ResearchRunV2.provenance")(function* (context: Tool.Context, found: Found) {
      const typed = (yield* typedOf(context.sessionID)).flatMap(ResearchProvenance.typed)
      return ResearchProvenance.add(
        ResearchProvenance.add(
          ResearchProvenance.add(
            ResearchProvenance.empty(),
            resultsOf(found.messages, found.run.id).map((result) => result.url),
            "search",
          ),
          linksOf(found.messages, found.run.id),
          "link",
        ),
        typed,
        "typed",
      )
    })

    const approve = Effect.fn("ResearchRunV2.approve")(function* (context: Tool.Context, found: Found, url: string) {
      if (approved.has(found.run.id)) return
      const lock = approving.get(found.run.id) ?? Semaphore.makeUnsafe(1)
      approving.set(found.run.id, lock)
      yield* lock
        .withPermits(1)(
          Effect.gen(function* () {
            if (approved.has(found.run.id)) return
            // Scoped to the run and never saved: there is nothing for "Always" to keep.
            yield* permission.assert({
              action: "research_read",
              resources: [found.run.id],
              save: [],
              metadata: {
                runID: found.run.id,
                url,
                question: found.plan.question,
                description: ResearchPlan.READ_APPROVAL,
              },
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
            })
            approved.add(found.run.id)
          }),
        )
        .pipe(
          Effect.mapError(() => new ToolFailure({ message: DECLINED })),
          Effect.ensuring(Effect.sync(() => approving.delete(found.run.id))),
        )
    })

    const limiter = (runID: string) => {
      const known = limiters.get(runID)
      limiters.delete(runID)
      const next = known ?? ResearchRate.make()
      limiters.set(runID, next)
      if (limiters.size > KEPT) limiters.delete(limiters.keys().next().value!)
      return next
    }

    const robots = Effect.fn("ResearchRunV2.robots")(function* () {
      if ((yield* settings()).own.robots === false) return undefined
      cached.robots ??= ResearchReader.robots({ http, resolver: network.resolver, publicNames: network.publicNames })
      return cached.robots
    })

    return Service.of({
      place,
      current,
      context,
      provenance,
      settings,
      domains,
      limits,
      approve,
      limiter,
      robots,
      network,
      guest: (sessionID) => guests.marked(sessionID),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    SessionStore.node,
    ResearchStore.node,
    Config.node,
    Location.node,
    FreeModelGuests.node,
    PermissionV2.node,
    Global.node,
    ResearchNetwork.node,
    Database.node,
    LayerNodePlatform.httpClient,
  ],
})

/** Every completed call of a tool in a conversation, oldest first, or of every tool without a name. */
export function calls(messages: readonly SessionMessage.Message[], tool?: string): Call[] {
  return messages.flatMap((message) =>
    message.type === "assistant"
      ? message.content.flatMap((part) =>
          part.type === "tool" && part.state.status === "completed" && (tool === undefined || part.name === tool)
            ? [
                {
                  name: part.name,
                  input: part.state.input,
                  structured: part.state.structured,
                  text: part.state.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n"),
                },
              ]
            : [],
        )
      : [],
  )
}

/** The search results research_search recorded for a run, or for any run without one. */
export function resultsOf(messages: readonly SessionMessage.Message[], runID?: string): Result[] {
  return calls(messages, "research_search")
    .filter((call) => runID === undefined || call.structured.runID === runID)
    .flatMap((call) => {
      const results = call.structured.results
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
    })
}

/** The links research_read offered in a run. */
export function linksOf(messages: readonly SessionMessage.Message[], runID: string): string[] {
  return calls(messages, "research_read")
    .filter((call) => call.structured.runID === runID)
    .flatMap((call) => {
      const links = call.structured.links
      return Array.isArray(links) ? links.filter((link: unknown): link is string => typeof link === "string") : []
    })
}

type Text = { readonly open: readonly string[]; readonly closed: readonly string[] }

// Tools whose output is the web's. A public page and a search result are the run's public text, from the store and
// the search calls; a page read on the user's own network is private. research_plan, research_note and
// research_report hold what the run already read.
const WEB_TOOLS = new Set([
  "webfetch",
  "websearch",
  "research_plan",
  "research_search",
  "research_read",
  "research_note",
  "research_report",
])
// Tools whose output the repository or Vector wrote: the work.
const WORK_TOOLS = new Set([
  "bash",
  "read",
  "grep",
  "glob",
  "edit",
  "write",
  "apply_patch",
  "todowrite",
  "question",
  "skill",
])

/**
 * What a message took in, by kind: everything but what is known to be public. A tool's output is private unless the
 * repository or Vector wrote it (the work) or the web did, so another tool's (an application or plugin tool, a
 * teammate's message) is private. A prompt's attached text files and Vector's own notes are the work. The user's typed
 * words are exempt anyway.
 */
function intake(message: SessionMessage.Message): { readonly private: string[]; readonly work: string[] } {
  if (message.type === "user") return { private: [], work: (message.files ?? []).flatMap(attached) }
  if (message.type === "synthetic" || message.type === "system") return { private: [], work: [message.text] }
  if (message.type === "shell") return { private: [], work: [message.command, message.output] }
  if (message.type === "compaction") return { private: [], work: [message.summary, message.recent] }
  if (message.type !== "assistant") return { private: [], work: [] }
  const found = calls([message]).flatMap((call): { readonly kind: "private" | "work"; readonly text: string }[] => {
    // A page read from the user's own computer or network is theirs.
    if (call.name === "research_read" && call.structured.private === true) return [{ kind: "private", text: call.text }]
    if (WEB_TOOLS.has(call.name)) return []
    return [{ kind: WORK_TOOLS.has(call.name) ? "work" : "private", text: call.text }]
  })
  return {
    private: found.flatMap((item) => (item.kind === "private" ? [item.text] : [])),
    work: found.flatMap((item) => (item.kind === "work" ? [item.text] : [])),
  }
}

// The text a prompt's attachment carried to the model: a selection's text, or a text file sent inline.
function attached(file: NonNullable<SessionMessage.User["files"]>[number]) {
  const inline = /^data:(text\/[^;,]+|application\/json)(;base64)?,/i.exec(file.uri)
  const body = inline
    ? inline[2]
      ? Buffer.from(file.uri.slice(inline[0].length), "base64").toString("utf8")
      : decodeURIComponent(file.uri.slice(inline[0].length))
    : undefined
  return [file.source?.text, body].filter((value): value is string => !!value)
}

const decodeFiles = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
)

function refuse(message: string): Current {
  return { refused: message }
}

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined)
