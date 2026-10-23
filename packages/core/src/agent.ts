export * as AgentV2 from "./agent"

import path from "path"
import { makeLocationNode } from "./effect/app-node"
import { Array, Context, Effect, Layer, Types } from "effect"
import { Agent } from "@vectordevai/schema/agent"
import { Permission } from "@vectordevai/schema/permission"
import { Global } from "./global"
import { State } from "./state"
import { Wildcard } from "./util/wildcard"

export const ID = Agent.ID
export type ID = typeof ID.Type
export const defaultID = ID.make("build")

export const Color = Agent.Color

export const Info = Agent.Info
export type Info = Agent.Info

/** The read rules every built-in agent starts from: secret files ask before they are read, the example file does not. */
export const readDefaults: Permission.Ruleset = [
  { action: "read", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
]

/** Reads outside the location ask, except Vector's own saved tool output and its temporary folder. */
export const externalReads: Permission.Ruleset = [
  { action: "external_directory", resource: "*", effect: "ask" },
  ...[path.join(Global.Path.data, "tool-output", "*"), path.join(Global.Path.tmp, "*")].map(
    (resource): Permission.Rule => ({ action: "external_directory", resource, effect: "allow" }),
  ),
]

// Deep research's lead (section 5.3) on this runner: it plans, searches, reads, saves notes and writes the report,
// reads the repository's files and asks the user. It makes no code changes. This runner has no task tool yet, so the
// lead launches no researchers and no judge; those run on the V1 runner.
export const researchID = ID.make("research")

/** The tools the research agent may be offered at all, whatever any rule allows. */
export const researchTools = [
  "research_plan",
  "research_search",
  "research_read",
  "research_note",
  "research_report",
  "question",
  "read",
  "grep",
  "glob",
] as const

// Coding and outside tools no user or repository rule may hand the research agent. They are denied last.
const researchDenied = [
  "edit",
  "write",
  "apply_patch",
  "bash",
  "todowrite",
  "plan_enter",
  "plan_exit",
  "vector_cloud*",
  "webfetch",
  "websearch",
  "skill",
  "escalate",
  "task",
  "task_manage",
]

/**
 * The rules no configuration lifts for an agent, applied as their own ruleset beside its permissions: the research
 * tools belong to the research agent alone, whatever another agent's rules allow (a user's `"*": "allow"` included).
 */
export function reserved(id: ID | string): Permission.Ruleset {
  return id === researchID ? [] : [{ action: "research_*", resource: "*", effect: "deny" }]
}

/**
 * The research agent's permissions from the user's and repository's rules (RC1). Those rules only narrow within the
 * agent's own tools, and the coding tools are denied last, so a global `bash: allow`, `edit: allow` or `"*": "allow"`
 * reopens nothing, as Plan mode's merge order would let them. The run's first page read asks once (research_read scopes
 * the ask to the run and never saves it), whatever broad allow there is: only a rule for research_read itself answers
 * it. An address on the user's own network asks per origin.
 */
export function researchPermissions(rules: Permission.Ruleset): Permission.Ruleset {
  // A blanket read allow lands after the read defaults, so secret files would stop asking. Their asks follow each such
  // allow again, except for a path one of the rules names itself.
  const secrets = readDefaults.filter(
    (secret) =>
      secret.resource !== "*" &&
      !rules.some(
        (rule) =>
          rule.action === "read" &&
          !blanket(rule.resource) &&
          (Wildcard.match(rule.resource, secret.resource) || Wildcard.match(secret.resource, rule.resource)),
      ),
  )
  return [
    { action: "*", resource: "*", effect: "deny" },
    ...researchTools.map((action): Permission.Rule => ({ action, resource: "*", effect: "allow" })),
    { action: "research_read", resource: "*", effect: "ask" },
    { action: "private_network", resource: "*", effect: "ask" },
    ...readDefaults,
    ...externalReads,
    ...rules.flatMap((rule) =>
      narrow(rule)
        .filter((item) => item.action !== "research_read" || item.effect !== "allow" || rule.action === "research_read")
        .flatMap((item) =>
          item.action === "read" && item.effect === "allow" && blanket(item.resource) ? [item, ...secrets] : [item],
        ),
    ),
    ...researchDenied.map((action): Permission.Rule => ({ action, resource: "*", effect: "deny" })),
  ]
}

// One user or repository rule as it may apply to the research agent. A deny applies anywhere. An allow or an ask
// applies to the research tools it names, and an ask also narrows reads outside the location.
function narrow(rule: Permission.Rule): Permission.Rule[] {
  if (rule.effect === "deny") return [rule]
  const named = researchTools
    .filter((tool) => Wildcard.match(tool, rule.action))
    .map((action): Permission.Rule => ({ ...rule, action }))
  if (rule.effect !== "ask" || !Wildcard.match("external_directory", rule.action)) return named
  return [...named, { ...rule, action: "external_directory" }]
}

const blanket = (resource: string) => /^[*/]*$/.test(resource)

export interface Selection {
  readonly id: ID
  readonly info: Info | undefined
}

type Data = {
  agents: Map<ID, Types.DeepMutable<Info>>
  default?: ID
}

export type Draft = {
  list: () => readonly Info[]
  get: (id: ID) => Info | undefined
  default: (id: ID | undefined) => void
  update: (id: ID, fn: (agent: Types.DeepMutable<Info>) => void) => void
  remove: (id: ID) => void
}

export interface Interface extends State.Transformable<Draft> {
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  readonly default: () => Effect.Effect<Info | undefined>
  readonly resolve: (id?: ID | string) => Effect.Effect<Info | undefined>
  readonly select: (id?: ID | string) => Effect.Effect<Selection>
  readonly all: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@vector/v2/Agent") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = State.create<Data, Draft>({
      initial: () => ({ agents: new Map() }),
      draft: (draft) => ({
        list: () => Array.fromIterable(draft.agents.values()) as Info[],
        get: (id) => draft.agents.get(id),
        default: (id) => {
          draft.default = id
        },
        update: (id, fn) => {
          const current = draft.agents.get(id) ?? (Info.empty(id) as Types.DeepMutable<Info>)
          if (!draft.agents.has(id)) draft.agents.set(id, current)
          fn(current)
          current.id = id
        },
        remove: (id) => {
          draft.agents.delete(id)
        },
      }),
      // After every transform, the user's and repository's included, so their rules only narrow the research agent.
      finalize: (draft) =>
        Effect.sync(() => {
          if (!draft.get(researchID)) return
          draft.update(researchID, (agent) => {
            agent.permissions = researchPermissions(agent.permissions).map((rule) => ({ ...rule }))
          })
        }),
    })
    const selectable = (agent: Info | undefined) =>
      agent && agent.mode !== "subagent" && !agent.hidden ? agent : undefined
    const selectedDefault = () => {
      const data = state.get()
      const configured = data.default ? selectable(data.agents.get(data.default)) : undefined
      if (configured) return configured
      const build = selectable(data.agents.get(ID.make("build")))
      if (build) return build
      for (const agent of data.agents.values()) {
        const fallback = selectable(agent)
        if (fallback) return fallback
      }
    }

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      get: Effect.fn("AgentV2.get")(function* (id) {
        return state.get().agents.get(id)
      }),
      default: Effect.fn("AgentV2.default")(function* () {
        return selectedDefault()
      }),
      resolve: Effect.fn("AgentV2.resolve")(function* (id) {
        if (id !== undefined) return state.get().agents.get(ID.make(id))
        return selectedDefault()
      }),
      select: Effect.fn("AgentV2.select")(function* (id) {
        if (id !== undefined) {
          const selected = ID.make(id)
          return { id: selected, info: state.get().agents.get(selected) }
        }
        const info = selectedDefault()
        return { id: info?.id ?? defaultID, info }
      }),
      all: Effect.fn("AgentV2.all")(function* () {
        return Array.fromIterable(state.get().agents.values())
      }),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [] })
