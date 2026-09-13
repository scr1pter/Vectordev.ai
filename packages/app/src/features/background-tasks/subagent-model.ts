import type { Message, Part, Session, SessionStatus, ToolPart } from "@opencode-ai/sdk/v2"
import { GENERAL_SUBAGENT_ID, subagentIdentity } from "@opencode-ai/session-ui/subagent-identity"

/*
 * Pure derivation behind the Background tasks panel and the inline task chips.
 *
 * One card per user turn: every task tool part whose assistant message answers
 * the same user message. One phase per assistant message inside that turn: the
 * engine runs the task calls of one message together, and the next phase only
 * starts in a later message. One agent per task part.
 *
 * The engine now mirrors a lifecycle record onto the child session
 * (metadata.subagent) and onto the parent's task part metadata. Older sessions
 * have neither, so every field falls back to what was always there: the part's
 * input and state, metadata.sessionId, the child session info, session_status
 * and the child's own messages. Nothing here may throw or yield undefined text.
 */

export type SubagentKind = "subagent" | "specialist"

/** Display status. Colours: running purple, waiting amber, done green, failed red, stopped muted, pending outlined. */
export type TaskStatus = "pending" | "running" | "waiting" | "done" | "failed" | "stopped"

/** Engine lifecycle status (packages/opencode/src/agent/subagent-kind.ts). */
export type LifecycleStatus = "queued" | "running" | "completed" | "error" | "cancelled"

/** Other names models use for the general-purpose Subagent; mirrors the engine's GENERAL_ALIASES. */
export const GENERAL_ALIASES: readonly string[] = ["general-purpose", "general_purpose", "subagent"]

export const KIND_LABEL: Record<SubagentKind, string> = {
  subagent: "Subagent",
  specialist: "Subagent specialist",
}

export type TaskModel = {
  providerID: string
  modelID: string
  variant?: string
  /** Catalogue name, or the model id when the catalogue does not know it. */
  name: string
  /** The name without a leading "Claude ", for the narrow table column. */
  short: string
}

export type TaskAgent = {
  key: string
  partID?: string
  callID?: string
  messageID?: string
  sessionID?: string
  agent: string
  kind: SubagentKind
  custom: boolean
  /** "Subagent", a specialist's own name, or a custom agent's id. */
  label: string
  title: string
  prompt?: string
  status: TaskStatus
  background: boolean
  startedAt?: number
  endedAt?: number
  tokens?: number
  toolUses?: number
  model?: TaskModel
  error?: string
  /**
   * Later task parts that only added to this agent's live run (a task_id call
   * on a job still running). They get no row, square or chip of their own.
   */
  extendPartIDs?: string[]
}

export type TaskPhase = {
  key: string
  messageID?: string
  index: number
  name: string
  status: TaskStatus
  done: number
  total: number
  startedAt?: number
  endedAt?: number
  agents: TaskAgent[]
}

export type TaskCard = {
  key: string
  title: string
  description: string
  kindLabel: string
  status: TaskStatus
  live: boolean
  startedAt?: number
  endedAt?: number
  tokens?: number
  agents: TaskAgent[]
  phases: TaskPhase[]
}

export type TaskSource = {
  rootID: string
  messages(sessionID: string): readonly Message[] | undefined
  parts(messageID: string): readonly Part[] | undefined
  session(sessionID: string): Session | undefined
  /** Known child sessions of the root, from the store or the children route. */
  children?: readonly Session[]
  status?(sessionID: string): SessionStatus | undefined
  /** True when the session has an unanswered permission or question request. */
  waiting?(sessionID: string): boolean
  modelName?(providerID: string, modelID: string): string | undefined
}

// ---------------------------------------------------------------------------
// Formatting

/** 950 → "950", 228_600 → "228.6k", 1_234_567 → "1.23M", unknown → "—". */
export function formatTokens(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—"
  if (value < 1000) return String(Math.round(value))
  if (value < 999_950) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(2)}M`
}

/** 42_000 → "42s", 1_574_000 → "26m 14s", 3_840_000 → "1h 04m", unknown → "—". */
export function formatDuration(ms: number | undefined) {
  if (ms === undefined || !Number.isFinite(ms)) return "—"
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`
}

export function formatAgentCount(count: number) {
  return count === 1 ? "1 agent" : `${count} agents`
}

/** Milliseconds a task has run: to its end once finished, to `now` while live. */
export function elapsedMs(item: { startedAt?: number; endedAt?: number; status: TaskStatus }, now: number) {
  if (item.startedAt === undefined) return undefined
  const end = item.endedAt ?? (isLive(item.status) ? now : undefined)
  if (end === undefined) return undefined
  return Math.max(0, end - item.startedAt)
}

export function isLive(status: TaskStatus) {
  return status === "pending" || status === "running" || status === "waiting"
}

/** The word shown once a task stops running, or while it waits on the user. */
export function statusWord(status: TaskStatus) {
  if (status === "done") return "Done"
  if (status === "failed") return "Failed"
  if (status === "stopped") return "Stopped"
  if (status === "waiting") return "Needs you"
  if (status === "pending") return "Not started"
  return "Running"
}

// ---------------------------------------------------------------------------
// Kinds and names

/** Engine agent id for a task call. The resolved metadata agent wins; the raw subagent_type is alias-mapped. */
export function resolveAgent(input: {
  metadata?: unknown
  record?: unknown
  child?: unknown
  requested?: unknown
  title?: string
}) {
  for (const value of [input.metadata, input.record, input.child]) {
    const name = text(value)
    if (name) return name
  }
  const requested = text(input.requested)
  if (requested) {
    const lower = requested.toLowerCase()
    if (lower === GENERAL_SUBAGENT_ID || GENERAL_ALIASES.includes(lower)) return GENERAL_SUBAGENT_ID
    return requested
  }
  return suffixAgent(input.title) ?? GENERAL_SUBAGENT_ID
}

export function subagentKind(agent: string, reported?: unknown): SubagentKind {
  if (reported === "subagent" || reported === "specialist") return reported
  return agent === GENERAL_SUBAGENT_ID ? "subagent" : "specialist"
}

/** "Subagent" for the general agent, a specialist's display name, or a custom agent's id as written. */
export function agentLabel(agent: string) {
  if (agent === GENERAL_SUBAGENT_ID) return KIND_LABEL.subagent
  return subagentIdentity(agent)?.name ?? agent
}

/**
 * Card and chip kind label: "Subagent" / "Subagents" when every agent is the
 * general one, "Specialist · Review" for one specialist type, "Specialists"
 * for several, "Subagents & specialists" for a mix.
 */
export function kindLabel(agents: readonly Pick<TaskAgent, "agent" | "kind">[]) {
  if (agents.length === 0) return KIND_LABEL.subagent
  const specialists = agents.filter((agent) => agent.kind === "specialist")
  if (specialists.length === 0) return agents.length === 1 ? "Subagent" : "Subagents"
  if (specialists.length < agents.length) return "Subagents & specialists"
  const types = new Set(specialists.map((agent) => agent.agent))
  if (types.size === 1) return `Specialist · ${agentLabel(specialists[0]!.agent)}`
  return "Specialists"
}

const SUFFIX = /\s*\(@([^)]+) subagent\)\s*$/

/** Drops the engine's " (@explore subagent)" child-title suffix. */
export function stripSubagentSuffix(title: string | undefined) {
  return (title ?? "").replace(SUFFIX, "").trim()
}

function suffixAgent(title: string | undefined) {
  const match = title?.match(SUFFIX)
  return match?.[1]?.trim() || undefined
}

const TITLE_MAX = 60
const TITLE_WORDS = 6

/** Mirrors the engine's subagentTitle: the description, else the prompt's first words, capped near 60 characters. */
export function subagentTitle(description: unknown, prompt: unknown) {
  const collapse = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "")
  const title = collapse(description) || collapse(prompt).split(" ").slice(0, TITLE_WORDS).join(" ")
  if (!title) return ""
  if (title.length <= TITLE_MAX) return title
  const cut = title.slice(0, TITLE_MAX - 1)
  const space = cut.lastIndexOf(" ")
  return `${(space >= TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

export function modelShortName(name: string) {
  return name.replace(/^Claude\s+/i, "").trim() || name
}

// ---------------------------------------------------------------------------
// Lifecycle fields, read defensively from either surface

type Usage = { total?: number; toolUses?: number }

type Lifecycle = {
  kind?: SubagentKind
  agent?: string
  custom?: boolean
  title?: string
  callID?: string
  parentMessageID?: string
  sessionID?: string
  background?: boolean
  status?: LifecycleStatus
  startedAt?: number
  completedAt?: number
  usage?: Usage
  error?: string
  model?: { providerID: string; modelID: string; variant?: string }
}

const LIFECYCLE_STATUSES: readonly string[] = ["queued", "running", "completed", "error", "cancelled"]

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function readModel(value: unknown) {
  const item = record(value)
  const providerID = text(item?.providerID)
  const modelID = text(item?.modelID) ?? text(item?.id)
  if (!providerID || !modelID) return undefined
  const variant = text(item?.variant)
  return { providerID, modelID, ...(variant ? { variant } : {}) }
}

function readUsage(value: unknown): Usage | undefined {
  const item = record(value)
  if (!item) return undefined
  const tokens = record(item.tokens)
  const cache = record(tokens?.cache)
  const summed = tokens
    ? [tokens.input, tokens.output, tokens.reasoning, cache?.read, cache?.write].reduce<number>(
        (sum, part) => sum + (finite(part) ?? 0),
        0,
      )
    : undefined
  const total = finite(item.total) ?? summed
  const toolUses = finite(item.toolUses)
  if (total === undefined && toolUses === undefined) return undefined
  return { total, toolUses }
}

/** Reads lifecycle fields from a task part's metadata (parentMessageId, sessionId) or a child record (parentMessageID). */
export function readLifecycle(value: unknown): Lifecycle {
  const item = record(value)
  if (!item) return {}
  const kind = item.kind === "subagent" || item.kind === "specialist" ? item.kind : undefined
  const status = typeof item.status === "string" && LIFECYCLE_STATUSES.includes(item.status) ? item.status : undefined
  return {
    kind,
    agent: text(item.agent),
    custom: typeof item.custom === "boolean" ? item.custom : undefined,
    title: text(item.title),
    callID: text(item.callID),
    parentMessageID: text(item.parentMessageID) ?? text(item.parentMessageId),
    sessionID: text(item.sessionId),
    background: typeof item.background === "boolean" ? item.background : undefined,
    status: status as LifecycleStatus | undefined,
    startedAt: finite(item.startedAt),
    completedAt: finite(item.completedAt),
    usage: readUsage(item.usage),
    error: text(item.error),
    model: readModel(item.model),
  }
}

/** The child session's metadata.subagent record, or undefined for sessions that predate it. */
export function childRecord(session: Session | undefined) {
  const value = record(session?.metadata)?.subagent
  return record(value) ? readLifecycle(value) : undefined
}

// ---------------------------------------------------------------------------
// Status

export type StatusInput = {
  /** The parent task part's state, when there is a part. */
  part?: "pending" | "running" | "completed" | "error"
  partError?: string
  /** Lifecycle status from the part metadata or the matching child record. */
  reported?: LifecycleStatus
  background?: boolean
  startedAt?: number
  /** The child's session_status. */
  child?: SessionStatus["type"]
  /** The child's last assistant message, if its messages are loaded. */
  last?: { created?: number; completed?: number; error?: string }
  waiting?: boolean
}

const ABORTED = "MessageAbortedError"

function fromLast(last: StatusInput["last"]): TaskStatus | undefined {
  if (!last) return undefined
  if (last.error === ABORTED) return "stopped"
  if (last.error) return "failed"
  return "done"
}

function fromError(error: string | undefined): TaskStatus {
  return /cancel|abort|interrupt/i.test(error ?? "") ? "stopped" : "failed"
}

export function agentStatus(input: StatusInput): TaskStatus {
  const busy = input.child === "busy" || input.child === "retry"
  const status = baseStatus(input, busy)
  if (status === "running" && input.waiting) return "waiting"
  return status
}

function baseStatus(input: StatusInput, busy: boolean): TaskStatus {
  const reported = input.reported
  if (reported === "completed") return "done"
  if (reported === "error") return "failed"
  if (reported === "cancelled") return "stopped"
  if (reported === "queued" || reported === "running") {
    if (busy) return "running"
    // A foreground part that failed before the lifecycle merged its outcome.
    if (input.part === "error") return fromError(input.partError)
    // A record that still says live while the child is idle: the job may have
    // died with an engine restart (idle children often have no status entry
    // at all after a reload). A finished reply from this run settles it.
    const last = input.last
    const current =
      last && last.completed !== undefined && (input.startedAt === undefined || (last.created ?? 0) >= input.startedAt)
    if (input.part !== "pending" && current) return fromLast(last) ?? "done"
    return reported === "queued" ? "pending" : "running"
  }
  // No lifecycle status: sessions from before the engine recorded one.
  if (input.part === "pending") return busy ? "running" : "pending"
  if (input.part === "running") return "running"
  if (input.part === "error") return fromError(input.partError)
  if (busy) return "running"
  return fromLast(input.last) ?? "done"
}

const SUMMARY_WORDS: readonly [TaskStatus, string][] = [
  ["running", "running"],
  ["waiting", "waiting on you"],
  ["pending", "not started"],
  ["done", "done"],
  ["failed", "failed"],
  ["stopped", "stopped"],
]

/** "2 running, 1 not started": the spoken form of a row of status squares. */
export function statusSummary(statuses: readonly TaskStatus[]) {
  return SUMMARY_WORDS.map(([status, word]) => {
    const count = statuses.filter((value) => value === status).length
    return count ? `${count} ${word}` : ""
  })
    .filter(Boolean)
    .join(", ")
}

/** running beats waiting beats pending beats failed beats stopped beats done. */
export function aggregateStatus(statuses: readonly TaskStatus[]): TaskStatus {
  for (const status of ["running", "waiting", "pending", "failed", "stopped"] as const) {
    if (statuses.includes(status)) return status
  }
  return "done"
}

// ---------------------------------------------------------------------------
// Child session measurements

type ChildFacts = {
  tokens?: number
  toolUses?: number
  last?: StatusInput["last"]
  lastModel?: { providerID: string; modelID: string; variant?: string }
}

function tokenSum(tokens: unknown) {
  const item = record(tokens)
  if (!item) return 0
  const cache = record(item.cache)
  return [item.input, item.output, item.reasoning, cache?.read, cache?.write].reduce<number>(
    (sum, part) => sum + (finite(part) ?? 0),
    0,
  )
}

/**
 * Live facts from a child's own messages. Tokens sum every step-finish part
 * (the engine's own definition of usage); when no step parts are loaded the
 * assistant messages' tokens stand in, then the session row.
 */
export function childFacts(source: TaskSource, sessionID: string | undefined): ChildFacts {
  if (!sessionID) return {}
  const messages = source.messages(sessionID) ?? []
  let steps = 0
  let stepTokens = 0
  let toolUses: number | undefined
  let messageTokens: number | undefined
  let last: ChildFacts["last"]
  let lastModel: ChildFacts["lastModel"]
  for (const message of messages) {
    if (message.role !== "assistant") continue
    messageTokens = (messageTokens ?? 0) + tokenSum(message.tokens)
    last = {
      created: finite(message.time?.created),
      completed: finite(message.time?.completed),
      error: text(message.error?.name),
    }
    const model = readModel({ providerID: message.providerID, modelID: message.modelID, variant: message.variant })
    if (model) lastModel = model
    const parts = source.parts(message.id)
    if (!parts) continue
    toolUses ??= 0
    for (const part of parts) {
      if (part.type === "tool") toolUses += 1
      if (part.type === "step-finish") {
        steps += 1
        stepTokens += tokenSum(part.tokens)
      }
    }
  }
  const row = tokenSum(source.session(sessionID)?.tokens)
  const tokens = steps > 0 ? stepTokens : row > 0 ? row : messageTokens
  return { tokens, toolUses, last, lastModel }
}

// ---------------------------------------------------------------------------
// Agents

function modelRef(source: TaskSource, value: { providerID: string; modelID: string; variant?: string } | undefined) {
  if (!value) return undefined
  const name = text(source.modelName?.(value.providerID, value.modelID)) ?? value.modelID
  return { ...value, name, short: modelShortName(name) } satisfies TaskModel
}

function sessionModel(session: Session | undefined) {
  return readModel(session?.model)
}

type AgentSeed = {
  key: string
  part?: ToolPart
  messageID?: string
  child?: Session
}

function buildAgent(source: TaskSource, seed: AgentSeed): TaskAgent {
  const part = seed.part
  const state = part?.state
  const input = record(state?.input) ?? {}
  const meta = readLifecycle("metadata" in (state ?? {}) ? (state as { metadata?: unknown }).metadata : undefined)
  const sessionID = meta.sessionID ?? seed.child?.id
  const child = sessionID ? (source.session(sessionID) ?? seed.child) : seed.child
  const stored = childRecord(child)
  // A task_id resume rewrites the child's record for the new run, so its run
  // fields only describe this part when the call ids agree.
  const matched = stored && (!part || !stored.callID || stored.callID === part.callID) ? stored : undefined
  const run: Lifecycle = { ...matched, ...definedFields(meta) }
  const facts = childFacts(source, sessionID)
  const agent = resolveAgent({
    metadata: meta.agent,
    record: stored?.agent,
    child: child?.agent,
    requested: input.subagent_type,
    title: child?.title,
  })
  const kind = subagentKind(agent, meta.kind ?? stored?.kind)
  const background = run.background ?? false
  const startedAt =
    run.startedAt ??
    (state && "time" in state ? finite((state as { time?: { start?: unknown } }).time?.start) : undefined) ??
    finite(child?.time?.created)
  const partError = state?.status === "error" ? text(state.error) : undefined
  const status = agentStatus({
    part: state?.status,
    partError,
    reported: run.status,
    background,
    startedAt,
    child: sessionID ? source.status?.(sessionID)?.type : undefined,
    last: facts.last,
    waiting: sessionID ? source.waiting?.(sessionID) : false,
  })
  const settledEnd =
    !background && (state?.status === "completed" || state?.status === "error") ? finite(state.time?.end) : undefined
  const endedAt = isLive(status)
    ? undefined
    : (run.completedAt ?? settledEnd ?? facts.last?.completed ?? finite(child?.time?.updated))
  const title =
    run.title || subagentTitle(input.description, input.prompt) || stripSubagentSuffix(child?.title) || "Subagent task"
  const model = modelRef(source, run.model ?? stored?.model ?? facts.lastModel ?? sessionModel(child))
  const error =
    run.error ?? partError ?? (facts.last?.error && facts.last.error !== ABORTED ? facts.last.error : undefined)
  return {
    key: seed.key,
    partID: part?.id,
    callID: part?.callID ?? stored?.callID,
    messageID: seed.messageID ?? stored?.parentMessageID,
    sessionID,
    agent,
    kind,
    custom: meta.custom ?? stored?.custom ?? (kind === "specialist" && !subagentIdentity(agent)),
    label: agentLabel(agent),
    title,
    prompt: text(input.prompt),
    status,
    background,
    startedAt,
    endedAt: endedAt !== undefined && startedAt !== undefined ? Math.max(endedAt, startedAt) : endedAt,
    tokens: run.usage?.total ?? facts.tokens,
    toolUses: run.usage?.toolUses ?? facts.toolUses,
    model,
    error: status === "failed" ? error : undefined,
  }
}

function definedFields<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as Partial<T>
}

function looksLikeSubagent(session: Session) {
  return !!childRecord(session) || SUFFIX.test(session.title ?? "")
}

// ---------------------------------------------------------------------------
// Cards and phases

function firstPromptLine(source: TaskSource, userMessageID: string | undefined) {
  if (!userMessageID) return undefined
  for (const part of source.parts(userMessageID) ?? []) {
    if (part.type !== "text" || part.synthetic || part.ignored) continue
    const line = (part.text ?? "")
      .split("\n")
      .map((value) => value.trim())
      .find(Boolean)
    if (line) return line.replace(/\s+/g, " ")
  }
  return undefined
}

export function phaseName(index: number, agents: readonly Pick<TaskAgent, "agent" | "kind">[]) {
  const name = `Phase ${index}`
  if (agents.length === 0 || agents.some((agent) => agent.kind !== "specialist")) return name
  const type = agents[0]!.agent
  if (agents.some((agent) => agent.agent !== type)) return name
  return `${name} · ${agentLabel(type)}`
}

function minDefined(values: readonly (number | undefined)[]) {
  const list = values.filter((value): value is number => value !== undefined)
  return list.length ? Math.min(...list) : undefined
}

function maxDefined(values: readonly (number | undefined)[]) {
  const list = values.filter((value): value is number => value !== undefined)
  return list.length ? Math.max(...list) : undefined
}

function sumDefined(values: readonly (number | undefined)[]) {
  const list = values.filter((value): value is number => value !== undefined)
  return list.length ? list.reduce((sum, value) => sum + value, 0) : undefined
}

function buildPhase(key: string, index: number, messageID: string | undefined, agents: TaskAgent[]): TaskPhase {
  const status = aggregateStatus(agents.map((agent) => agent.status))
  return {
    key,
    messageID,
    index,
    name: phaseName(index, agents),
    status,
    done: agents.filter((agent) => agent.status === "done").length,
    total: agents.length,
    startedAt: minDefined(agents.map((agent) => agent.startedAt)),
    endedAt: isLive(status) ? undefined : maxDefined(agents.map((agent) => agent.endedAt)),
    agents,
  }
}

type CardSeed = {
  key: string
  userMessageID?: string
  phases: { key: string; messageID?: string; agents: TaskAgent[] }[]
}

/** A child session is one agent however many task parts drive it; a part with no child yet is its own. */
function agentIdentity(agent: Pick<TaskAgent, "key" | "sessionID">) {
  return agent.sessionID ?? `part:${agent.key}`
}

function perSession<T extends Pick<TaskAgent, "key" | "sessionID">>(agents: readonly T[]) {
  const seen = new Map<string, T>()
  for (const agent of agents) if (!seen.has(agentIdentity(agent))) seen.set(agentIdentity(agent), agent)
  return [...seen.values()]
}

/** Distinct agents: a child resumed with task_id counts once, however many runs it has had. */
export function countAgents(agents: readonly Pick<TaskAgent, "key" | "sessionID">[]) {
  return perSession(agents).length
}

/**
 * Each child session's tokens once, from its newest run that has a count. A
 * child's usage is cumulative across its runs, so adding runs double-counts.
 */
function sessionTokens(agents: readonly TaskAgent[]) {
  const newest = new Map<string, { startedAt: number; tokens: number }>()
  for (const agent of agents) {
    if (agent.tokens === undefined) continue
    const key = agentIdentity(agent)
    const startedAt = agent.startedAt ?? 0
    const seen = newest.get(key)
    if (!seen || startedAt >= seen.startedAt) newest.set(key, { startedAt, tokens: agent.tokens })
  }
  return sumDefined([...newest.values()].map((entry) => entry.tokens))
}

function buildCard(source: TaskSource, seed: CardSeed): TaskCard {
  const phases = seed.phases.map((phase, index) => buildPhase(phase.key, index + 1, phase.messageID, phase.agents))
  const agents = phases.flatMap((phase) => phase.agents)
  const status = aggregateStatus(agents.map((agent) => agent.status))
  const live = isLive(status)
  const single = agents.length === 1 ? agents[0] : undefined
  const titles = agents.map((agent) => agent.title)
  const title =
    single?.title ??
    firstPromptLine(source, seed.userMessageID) ??
    (agents.length > 1 ? `${titles[0]} and ${agents.length - 1} more` : (titles[0] ?? "Subagent task"))
  return {
    key: seed.key,
    title,
    description: single ? (single.prompt ?? "") : titles.join(", "),
    kindLabel: kindLabel(perSession(agents)),
    status,
    live,
    startedAt: minDefined(agents.map((agent) => agent.startedAt)),
    endedAt: live ? undefined : maxDefined(agents.map((agent) => agent.endedAt)),
    tokens: sessionTokens(agents),
    agents,
    phases,
  }
}

function isTaskPart(part: Part): part is ToolPart {
  return part.type === "tool" && part.tool === "task"
}

/**
 * A task_id call on a job that is still running adds to that run rather than
 * starting one: the engine leaves the child's record on the launching call and
 * returns a second part for the same child ("Background task updated"). That
 * part folds into the agent that owns the run. A resume of a finished child
 * rewrites the record to its own call, so it stays a run of its own.
 */
function extendsRun(source: TaskSource, owner: TaskAgent, agent: TaskAgent, part: ToolPart) {
  const recorded = childRecord(agent.sessionID ? source.session(agent.sessionID) : undefined)?.callID
  if (recorded === part.callID) return false
  if (isLive(owner.status)) return true
  // The run has settled since; the part still extended it if it started first.
  return agent.startedAt !== undefined && owner.endedAt !== undefined && agent.startedAt < owner.endedAt
}

/**
 * Every subagent the root session started, grouped into cards (user turns)
 * and phases (assistant messages). Live cards come first, newest first;
 * finished ones follow, most recently finished first.
 */
export function buildTaskCards(source: TaskSource): TaskCard[] {
  const children = (source.children ?? []).filter((session) => session.parentID === source.rootID)
  const byCall = new Map<string, Session>()
  for (const session of children) {
    const callID = childRecord(session)?.callID
    if (callID) byCall.set(callID, session)
  }

  const claimed = new Set<string>()
  // The agent that owns each child's latest run, for parts that only extend it.
  const owners = new Map<string, TaskAgent>()
  const cards = new Map<string, CardSeed>()
  const cardFor = (key: string, userMessageID?: string) => {
    const existing = cards.get(key)
    if (existing) return existing
    const next: CardSeed = { key, userMessageID, phases: [] }
    cards.set(key, next)
    return next
  }
  const messageParent = new Map<string, string>()

  for (const message of source.messages(source.rootID) ?? []) {
    if (message.role !== "assistant") continue
    messageParent.set(message.id, message.parentID)
    const parts = (source.parts(message.id) ?? []).filter(isTaskPart)
    if (parts.length === 0) continue
    const agents: TaskAgent[] = []
    for (const part of parts) {
      const meta = readLifecycle(part.state && "metadata" in part.state ? part.state.metadata : undefined)
      // An errored call can lose its metadata until the lifecycle merges it
      // back, so the child is also found through the call id.
      const child = meta.sessionID ? undefined : byCall.get(part.callID)
      const agent = buildAgent(source, { key: part.id, part, messageID: message.id, child })
      const owner = agent.sessionID ? owners.get(agent.sessionID) : undefined
      if (owner && extendsRun(source, owner, agent, part)) {
        owner.extendPartIDs = [...(owner.extendPartIDs ?? []), part.id]
        continue
      }
      if (agent.sessionID) {
        claimed.add(agent.sessionID)
        owners.set(agent.sessionID, agent)
      }
      agents.push(agent)
    }
    // A message whose only task part extended an earlier run starts no phase.
    if (agents.length === 0) continue
    const key = message.parentID || message.id
    cardFor(key, message.parentID).phases.push({ key: message.id, messageID: message.id, agents })
  }

  // Children with no part in the loaded history: older pages, or a part that
  // was trimmed. Only sessions the task tool created count.
  const orphans = children.filter((session) => !claimed.has(session.id) && looksLikeSubagent(session))
  const orphanPhases = new Map<string, TaskAgent[]>()
  for (const session of orphans) {
    const agent = buildAgent(source, { key: `session:${session.id}`, child: session })
    const phaseKey = agent.messageID ?? `session:${session.id}`
    orphanPhases.set(phaseKey, [...(orphanPhases.get(phaseKey) ?? []), agent])
  }
  const earliest = (agents: readonly TaskAgent[]) => minDefined(agents.map((agent) => agent.startedAt)) ?? 0
  const orderedOrphans = [...orphanPhases].sort((a, b) => earliest(a[1]) - earliest(b[1]))
  for (const [phaseKey, agents] of orderedOrphans) {
    const userMessageID = messageParent.get(phaseKey)
    const card = cardFor(userMessageID ?? `orphan:${phaseKey}`, userMessageID)
    const sorted = agents.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    const existing = card.phases.find((phase) => phase.key === phaseKey)
    if (existing) existing.agents.push(...sorted)
    else card.phases.push({ key: phaseKey, messageID: agents[0]?.messageID, agents: sorted })
  }

  const built = [...cards.values()].filter((card) => card.phases.some((phase) => phase.agents.length > 0))
  return built.map((seed) => buildCard(source, seed)).sort(compareCards)
}

function compareCards(a: TaskCard, b: TaskCard) {
  if (a.live !== b.live) return a.live ? -1 : 1
  if (a.live) return (b.startedAt ?? 0) - (a.startedAt ?? 0)
  return (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0)
}

export type TaskLocation = { card: TaskCard; phase: TaskPhase; agent: TaskAgent; first: boolean }

/** Where a task part sits; `first` marks the part that carries its phase's inline chip. */
export function locateTaskPart(cards: readonly TaskCard[], partID: string): TaskLocation | undefined {
  for (const card of cards) {
    for (const phase of card.phases) {
      const index = phase.agents.findIndex((agent) => agent.partID === partID)
      if (index === -1) {
        // A part that only extended a run belongs to that run's agent and draws nothing.
        const owner = phase.agents.find((agent) => agent.extendPartIDs?.includes(partID))
        if (owner) return { card, phase, agent: owner, first: false }
        continue
      }
      const first = phase.agents.findIndex((agent) => agent.partID !== undefined)
      return { card, phase, agent: phase.agents[index]!, first: index === first }
    }
  }
  return undefined
}

type CountedCard = { agents: readonly Pick<TaskAgent, "key" | "sessionID" | "status">[] }

/** Distinct agents still running, waiting or queued: what keeps the clock ticking. */
export function liveAgentCount(cards: readonly CountedCard[]) {
  return countAgents(cards.flatMap((card) => card.agents.filter((agent) => isLive(agent.status))))
}

/** Distinct agents running or waiting on you, for the header badge; queued ones have not started. */
export function runningAgentCount(cards: readonly CountedCard[]) {
  return countAgents(
    cards.flatMap((card) => card.agents.filter((agent) => agent.status === "running" || agent.status === "waiting")),
  )
}

/**
 * Hidden-finished bookkeeping: the trash records when each finished card was
 * cleared. A card that finishes again later (a resumed task) shows again.
 */
export function isDismissed(card: Pick<TaskCard, "live" | "endedAt">, dismissedAt: number | undefined) {
  if (card.live || dismissedAt === undefined) return false
  return card.endedAt === undefined || card.endedAt <= dismissedAt
}
