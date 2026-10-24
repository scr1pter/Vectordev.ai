export * as LocalRecommend from "./recommend"

import { Option, Schema } from "effect"
import type { LocalProbe } from "./probe"
import bundled from "./recommend-table.json"

// Which models to suggest. Two questions: what to install for a given amount of memory (this computer's, or the GPU
// memory of a server a company runs), from a bundled table of dated examples, and which of the models a server
// already has should fill each role. The table names model families and quantisations as examples, linking only to
// the publisher's own repository or the Ollama library, and every place that shows it carries its label: "Examples,
// October 2026. Check each model's licence." A company's managed file can replace the table (`local.recommend`).

export const Role = Schema.Literals(["agent", "subagent", "judge", "review", "small", "research"])
export type Role = typeof Role.Type

const Entry = Schema.Struct({
  name: Schema.String,
  publisher: Schema.String,
  licence: Schema.String,
  quantization: Schema.String,
  /** About what the weights take, in GB; loading adds room for the context. */
  memory_gb: Schema.Number,
  context: Schema.Number,
  tools: Schema.Boolean,
  serve: Schema.Array(Schema.String),
  ollama: Schema.optional(Schema.String),
  links: Schema.Array(Schema.String),
})
export type Entry = typeof Entry.Type

const Tier = Schema.Struct({
  id: Schema.String,
  min_gb: Schema.Number,
  summary: Schema.String,
  note: Schema.optional(Schema.String),
  roles: Schema.Record(Schema.String, Schema.String),
  alternatives: Schema.Array(Schema.String),
})

export const Table = Schema.Struct({
  date: Schema.String,
  label: Schema.String,
  note: Schema.optional(Schema.String),
  servers: Schema.Record(Schema.String, Schema.Struct({ name: Schema.String, install: Schema.String })),
  models: Schema.Record(Schema.String, Entry),
  tiers: Schema.Array(Tier),
}).annotate({ identifier: "LocalRecommendTable" })
export type Table = typeof Table.Type

const GB = 1024 ** 3

/**
 * The table in effect: a company's override when it is a whole, consistent table (every model a tier names is in
 * it, and some tier starts at 0), else the bundled one.
 */
export function table(override?: unknown): Table {
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(Table)(override))
  if (decoded && consistent(decoded)) return decoded
  return Schema.decodeUnknownSync(Table)(bundled)
}

function consistent(candidate: Table) {
  const named = candidate.tiers.flatMap((tier) => [...Object.values(tier.roles), ...tier.alternatives])
  return candidate.tiers.some((tier) => tier.min_gb === 0) && named.every((key) => key in candidate.models)
}

export type Suggestion = Entry & { readonly key: string }

export type Recommendation = {
  readonly tier: string
  readonly summary: string
  readonly note?: string
  /** The label every view of these examples carries. */
  readonly label: string
  readonly date: string
  /** The model for each role, or undefined when the memory is too small for that role. */
  readonly roles: Readonly<Record<Role, Suggestion | undefined>>
  readonly alternatives: readonly Suggestion[]
}

/**
 * What to install for `usable` bytes of memory a model can use (LocalHardware's `usable`, or a server's GPU memory).
 * Every role takes the agent's model unless the tier names another, so one model stays loaded and the server never
 * swaps between roles.
 */
export function recommend(input: { readonly usable: number; readonly table?: Table }): Recommendation {
  const current = input.table ?? table()
  const tier = current.tiers
    .toSorted((left, right) => left.min_gb - right.min_gb)
    .findLast((item) => item.min_gb * GB <= input.usable)!
  const suggestion = (key: string | undefined) => {
    const entry = key ? current.models[key] : undefined
    return entry && key ? { ...entry, key } : undefined
  }
  const agent = tier.roles["agent"]
  return {
    tier: tier.id,
    summary: tier.summary,
    note: tier.note,
    label: current.label,
    date: current.date,
    roles: byRole((role) => suggestion(tier.roles[role] ?? agent)),
    alternatives: tier.alternatives.flatMap((key) => suggestion(key) ?? []),
  }
}

export type Candidate = {
  /** The provider the model is configured under, such as ollama. */
  readonly provider: string
  readonly model: LocalProbe.Model
}

/**
 * Which of the models servers already have should fill each role, as provider/model. The agent's roles take the
 * largest model that may call tools and whose context fits the role (`required` tokens; an unknown context is left
 * for Check models). Titles and summaries take the same model unless `usable` bytes hold a second, smaller one beside
 * it. Cloud models are never suggested.
 */
export function assign(input: {
  readonly candidates: readonly Candidate[]
  readonly required?: number
  /** Memory the server has for models, in bytes, when known. */
  readonly usable?: number
}): Partial<Record<Role, string>> {
  const local = input.candidates.filter((item) => !item.model.cloud)
  const able = local.filter(
    (item) =>
      item.model.tools !== false &&
      (input.required === undefined || item.model.context === undefined || item.model.context >= input.required),
  )
  const agent = able.toSorted(
    (left, right) =>
      size(right.model) - size(left.model) ||
      (right.model.context ?? 0) - (left.model.context ?? 0) ||
      left.model.id.localeCompare(right.model.id),
  )[0]
  if (!agent) return {}
  const name = (item: Candidate) => `${item.provider}/${item.model.id}`
  const helper =
    input.usable === undefined || !agent.model.size
      ? undefined
      : local
          .filter((item) => item !== agent && item.model.size && agent.model.size! + item.model.size <= input.usable!)
          .toSorted((left, right) => (left.model.size ?? 0) - (right.model.size ?? 0))[0]
  return byRole((role) => (role === "small" && helper ? name(helper) : name(agent)))
}

function byRole<T>(pick: (role: Role) => T): Record<Role, T> {
  return {
    agent: pick("agent"),
    subagent: pick("subagent"),
    judge: pick("judge"),
    review: pick("review"),
    small: pick("small"),
    research: pick("research"),
  }
}

// A model's size in billions of parameters, from "30.5B" or "1T", else its size on disk.
function size(model: LocalProbe.Model) {
  const match = model.parameters?.match(/^([\d.]+)\s*([BMT])$/i)
  if (!match) return (model.size ?? 0) / GB
  const unit = match[2].toUpperCase()
  return Number(match[1]) * (unit === "T" ? 1000 : unit === "M" ? 0.001 : 1)
}
