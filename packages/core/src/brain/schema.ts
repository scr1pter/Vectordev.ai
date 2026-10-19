export * as BrainSchema from "./schema"

import { Schema } from "effect"

// One entry model for everything durable that steers the agent. A repository rule and a learned lesson are the same
// kind of record; they differ in who wrote them (origin) and how much they bind (kind: only `rule` is binding).

/** Where an entry applies: one repository on this computer, or every repository (the user's own). */
export const Scope = Schema.Literals(["repository", "personal"])
export type Scope = typeof Scope.Type

/**
 * - rule: binding. Only ever read from a rules file a person wrote; Vector never creates one.
 * - preference: how this user likes things done.
 * - decision: a choice and its reason.
 * - lesson: what worked or failed here, "when X, do Y because Z".
 * - fact: something checkable in the code.
 * - failure: a check that failed this way before and the repair that worked (failure memory).
 * - review: what Vectorscope was told not to flag; read by reviews, never sent with coding requests.
 */
export const Kind = Schema.Literals(["rule", "preference", "decision", "lesson", "fact", "failure", "review"])
export type Kind = typeof Kind.Type

/**
 * Metadata key of a message part whose text came from outside this conversation: a transcript imported as passive
 * history, the issue and pull request text the GitHub agent is given, a resource an editor embedded over ACP, or what
 * was piped into `vector run`. A role "user" message carrying it was not typed by the user, so its words vouch for no
 * memory, and memory written in a session that has one waits for review, as it does after reading the web. The value
 * says where the text came from; "file", a local file an editor embedded, is this computer's and holds nothing.
 */
export const OUTSIDE = "vector.outside"

/** What the agent and the user may write themselves. */
export const LearnedKind = Schema.Literals(["preference", "decision", "lesson", "fact"])
export type LearnedKind = typeof LearnedKind.Type

/**
 * - active: used by the agent.
 * - proposed: written without evidence Vector could check; active once seen in a second session or approved.
 * - quarantined: held for the user's review (untrusted source, guest, web or MCP content, instruction-like text).
 *   Neither proposed nor quarantined entries are ever shown to the agent, so a session cannot launder its own writes.
 * - archived: decayed or put away; restorable.
 * - superseded: replaced by a newer entry, kept and linked.
 */
export const Status = Schema.Literals(["active", "proposed", "quarantined", "archived", "superseded"])
export type Status = typeof Status.Type

export const Origin = Schema.Literals(["file", "user", "agent", "failure-memory"])
export type Origin = typeof Origin.Type

export const Hold = Schema.Literals([
  "web",
  "mcp",
  "subagent",
  "untrusted-repository",
  "guest",
  "instruction-like",
  "hidden-unicode",
])
export type Hold = typeof Hold.Type

export const Source = Schema.Struct({
  /** The file the entry is read from, for entries that mirror a file. */
  file: Schema.String,
  line: Schema.optional(Schema.Finite),
})

export const Entry = Schema.Struct({
  id: Schema.String,
  scope: Scope,
  kind: Kind,
  origin: Origin,
  status: Status,
  pinned: Schema.Boolean,
  text: Schema.String,
  paths: Schema.Array(Schema.String),
  confidence: Schema.Finite,
  uses: Schema.Finite,
  stale: Schema.Boolean,
  hold: Schema.optional(Hold),
  source: Schema.optional(Source),
  supersededBy: Schema.optional(Schema.String),
  related: Schema.Array(Schema.String),
  lastUsedAt: Schema.optional(Schema.Finite),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
}).annotate({ identifier: "MemoryEntry" })
export type Entry = typeof Entry.Type

export const Evidence = Schema.Struct({
  type: Schema.Literals(["message", "file", "check", "user", "file-item"]),
  path: Schema.optional(Schema.String),
  quote: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  sessionID: Schema.optional(Schema.String),
  createdAt: Schema.Finite,
}).annotate({ identifier: "MemoryEvidence" })
export type Evidence = typeof Evidence.Type
