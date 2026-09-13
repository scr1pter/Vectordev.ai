// Follows agents into the files they edit. The store is fed only by raw server
// events, so it keeps working while the Codespace is closed, and the editor
// lands on the file being edited the moment it opens.
//
// Vector's own agents (the session, its subagents, and a parallel workspace's
// agent) are followed from their running edit, write or apply_patch tool call.
// That event names the file before the permission prompt, the write and the
// formatter, so the editor opens and marks where the change will land ahead of
// time. The text captured then is the "before" that the landed edit is diffed
// against, so a watcher reload that arrives first can no longer overwrite it.
// External agents (Claude Code, Codex, Cursor) publish no tool calls. They are
// followed from the files their runner reports and from the file watcher.

import { createEffect, createSignal, getOwner, onCleanup, untrack, type Signal } from "solid-js"
import {
  EDIT_TOOLS,
  editTargets,
  intentRange,
  landingPath,
  predatesEdit,
  TYPING_ARM_MS,
  type EditTarget,
} from "@/components/agent-edit-intent"
import {
  activeAttributions,
  agentColor,
  agentCursorLine,
  ATTRIBUTION_TTL_MS,
  attributionsForPath,
  diffLineRanges,
  inferredLineRanges,
  mergeAttribution,
  resolveAgentColor,
  type AgentAttribution,
  type LineRange,
} from "@/components/editor-attribution"

export type FollowCursorState = "editing" | "waiting" | "landed"

export type FollowCursor = {
  /** Store key: workspace-relative for the main directory, absolute for another workspace. */
  path: string
  agentId: string
  agentName: string
  color: string
  line: number
  /** Where the change is about to land, while it has not yet. */
  pending?: LineRange
  state: FollowCursorState
  /** Date.now() of the last change to this cursor. */
  token: number
  intent?: string
  scope?: string
}

export type FollowTarget = {
  path: string
  line: number
  endLine: number
  token: number
  agentId: string
  agentName: string
  color: string
  sessionID?: string
  messageID?: string
  /** The directory the path belongs to when it is not the editor's own. */
  scope?: string
}

export type FollowTyping = {
  path: string
  token: number
  agentId: string
  agentName: string
  color: string
}

export type FollowEvent = { type: string; properties?: unknown }
export type FollowEnvelope = { name?: string; details: FollowEvent }

// Where a store key's text comes from. The main directory reads through the
// app's file context; another workspace reads its own directory.
export type FollowSource = {
  scope?: string
  /** The store key for a path an event names, or undefined when it is not followed. */
  key: (file: string) => string | undefined
  /** The text the editor holds for a key right now, without any I/O. */
  peek: (key: string) => string | undefined
  /** Force-read a key's text from disk. */
  read: (key: string) => Promise<string | undefined>
}

export type ExternalActivityEntry = {
  id: string
  label?: string
  kind?: string
  state: "running" | "done" | "failed"
  /** Relative paths the step touches, when the runner reports them. */
  files?: readonly string[]
}

export type FollowExternal = {
  label: string
  running: boolean
  /** The runner's steps. Undefined until they have been read: the first snapshot read is history. */
  activity?: () => readonly ExternalActivityEntry[] | undefined
}

export type FollowIdentity = { id: string; name: string; color: string }

export type AgentFollowDeps = {
  listen?: (fn: (event: FollowEnvelope) => void) => () => void
  source: FollowSource
  followAgent: () => boolean
  agents: () => readonly { name: string; color?: string }[]
  /** The agent that owns a message, so a cursor is labelled before file.edited names it. */
  agentFor?: (sessionID: string, messageID: string) => string | undefined
  /** An external agent in this directory: its watcher events and activity count as edits. */
  external?: () => FollowExternal | undefined
  /** The user's own save is in flight, so the watcher event it causes is not an agent edit. */
  saving?: () => boolean
}

export type FollowHandleOptions = {
  source?: FollowSource
  /** Attribute everything this event causes to one fixed agent (a parallel workspace). */
  identity?: FollowIdentity
  /** Watcher events are agent edits (an external agent's workspace). */
  watcherEdits?: boolean
}

type IntentFile = {
  key: string
  target: EditTarget
  before?: string
  pending?: LineRange
  landed: boolean
  landing: boolean
}

type Intent = {
  id: string
  sessionID?: string
  messageID?: string
  tool: string
  input: Record<string, unknown>
  agent: FollowIdentity
  fixedIdentity: boolean
  files: IntentFile[]
  source: FollowSource
  at: number
  external: boolean
}

/** An intent still open after this long lost its tool result, so it is dropped. */
const OPEN_INTENT_MAX_MS = 15 * 60_000
/** A completed call whose file.edited never matched is landed from its input after this. */
const LAND_FALLBACK_MS = 1_500
/** An external runner reports "done" a moment before the watcher sees the write. */
const EXTERNAL_LAND_FALLBACK_MS = 600
export const WATCHER_DEBOUNCE_MS = 120
/** A Vector edit echoes through the watcher; the echo is not a second edit. */
const INTENT_ECHO_MS = 2_000
/** A completed tool part older than this is history, not a live edit. */
const STALE_COMPLETION_MS = 10_000
const RECENT_LAND_MS = 30_000

const record = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : undefined)
const str = (value: unknown) => (typeof value === "string" ? value : undefined)

const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/])/

function cap<T>(collection: Set<T> | Map<T, unknown>, max: number) {
  if (collection.size <= max) return
  for (const key of collection.keys()) {
    collection.delete(key)
    if (collection.size <= max) return
  }
}

type ToolPartInfo = {
  callID: string
  sessionID: string
  messageID: string
  tool: string
  status: string
  input: Record<string, unknown>
  end?: number
  /** The part already carries the tool's diff: the edit tool republishes it once the file is written. */
  written: boolean
}

function toolPart(value: unknown): ToolPartInfo | undefined {
  const part = record(value)
  if (!part || part.type !== "tool") return
  const tool = str(part.tool)
  if (!tool || !EDIT_TOOLS.has(tool)) return
  const state = record(part.state)
  const status = str(state?.status)
  const callID = str(part.callID) ?? str(part.id)
  const sessionID = str(part.sessionID)
  const messageID = str(part.messageID)
  if (!state || !status || !callID || !sessionID || !messageID) return
  const end = record(state.time)?.end
  const metadata = record(state.metadata)
  return {
    callID,
    sessionID,
    messageID,
    tool,
    status,
    input: record(state.input) ?? {},
    end: typeof end === "number" ? end : undefined,
    written: metadata?.diff !== undefined || metadata?.filediff !== undefined,
  }
}

export function excludedPath(path: string, excluded: readonly string[]) {
  return path
    .split("/")
    .slice(0, -1)
    .some((segment) => excluded.includes(segment))
}

function relativeOnly(file: string) {
  const path = file.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "")
  if (!path || ABSOLUTE.test(path) || path.split("/").includes("..")) return
  return path
}

/** A path inside `directory`, relative to it; undefined for anything outside. */
export function workspaceRelativePath(directory: string, file: string): string | undefined {
  const root = directory.replace(/\\/g, "/").replace(/\/+$/, "")
  const path = file.replace(/\\/g, "/")
  if (root && path.startsWith(`${root}/`)) return relativeOnly(path.slice(root.length + 1))
  return relativeOnly(path)
}

export type FollowFileContext = {
  normalize: (input: string) => string
  get: (path: string) => { content?: { content?: string } } | undefined
  load: (path: string, options?: { force?: boolean }) => Promise<unknown>
}

// The editor's own directory, read through the app's file context so the
// follow loads the same buffer the editor shows.
export function fileFollowSource(file: FollowFileContext, excluded: readonly string[] = []): FollowSource {
  return {
    key: (input) => {
      const path = file.normalize(input)
      if (!path || excludedPath(path, excluded)) return
      // normalize leaves a path outside the workspace absolute (minus its first
      // slash). The file context cannot read it, so it is not followed.
      if (ABSOLUTE.test(input) && path === input.replace(/^[\\/]+/, "")) return
      return path
    },
    peek: (key) => file.get(key)?.content?.content,
    read: async (key) => {
      await file.load(key, { force: true })
      return file.get(key)?.content?.content
    },
  }
}

// Another directory (a parallel workspace). Keys are absolute so they never
// collide with the editor's own workspace-relative paths.
export function directoryFollowSource(input: {
  directory: string
  excluded?: readonly string[]
  peek: (key: string) => string | undefined
  read: (relative: string, key: string) => Promise<string | undefined>
}): FollowSource {
  const root = input.directory.replace(/\\/g, "/").replace(/\/+$/, "")
  return {
    scope: input.directory,
    key: (file) => {
      const relative = workspaceRelativePath(input.directory, file)
      if (!relative || excludedPath(relative, input.excluded ?? [])) return
      return `${root}/${relative}`
    },
    peek: input.peek,
    read: (key) => {
      if (!key.startsWith(`${root}/`)) return Promise.resolve(undefined)
      return input.read(key.slice(root.length + 1), key)
    },
  }
}

/**
 * The relative files an external runner's activity entry touches. Read
 * defensively: runners that predate the field send none, and anything
 * absolute or climbing out of the workspace is ignored.
 */
export function activityFiles(entry: unknown): string[] {
  const files = record(entry)?.files
  if (!Array.isArray(files)) return []
  const out: string[] = []
  for (const file of files) {
    const path = typeof file === "string" ? relativeOnly(file) : undefined
    if (path && !out.includes(path)) out.push(path)
  }
  return out
}

/** The activity entries with files across an external agent's turns. */
export function externalActivityEntries(turns: unknown): ExternalActivityEntry[] {
  if (!Array.isArray(turns)) return []
  const out: ExternalActivityEntry[] = []
  for (const turn of turns) {
    const activity = record(turn)?.activity
    if (!Array.isArray(activity)) continue
    const turnID = str(record(turn)?.id)
    for (const value of activity) {
      const entry = record(value)
      const id = str(entry?.id)
      const state = entry?.state
      if (!entry || !id || (state !== "running" && state !== "done" && state !== "failed")) continue
      const files = activityFiles(entry)
      if (!files.length) continue
      out.push({
        id: turnID ? `${turnID}:${id}` : id,
        label: str(entry.label),
        kind: str(entry.kind),
        state,
        files,
      })
    }
  }
  return out
}

/** The paths an event names (as the event wrote them), for immediate file-tree markers. */
export function eventFiles(event: FollowEvent): string[] {
  const properties = record(event.properties)
  if (!properties) return []
  if (event.type === "file.edited") return str(properties.file) ? [properties.file as string] : []
  if (event.type === "file.watcher.updated") {
    return str(properties.file) && properties.event !== "unlink" ? [properties.file as string] : []
  }
  if (event.type !== "message.part.updated") return []
  const part = toolPart(properties.part)
  if (!part || part.status === "error" || part.status === "pending") return []
  return editTargets(part.tool, part.input)
    .filter((target) => target.kind !== "delete")
    .map(landingPath)
}

function findMessage(messages: readonly unknown[] | undefined, messageID: string) {
  for (const item of messages ?? []) {
    const message = record(item)
    if (message?.id === messageID) return message
  }
}

/** The agent that wrote a message, when the message is loaded. */
export function messageAgent(messages: readonly unknown[] | undefined, messageID: string) {
  return str(findMessage(messages, messageID)?.agent)
}

/** A session, then its parent, and so on up to its root. Guarded against a cycle. */
export function sessionLineage(sessionID: string, parentOf: (sessionID: string) => string | undefined) {
  const out = [sessionID]
  for (
    let current = parentOf(sessionID);
    current && !out.includes(current) && out.length < 100;
    current = parentOf(current)
  ) {
    out.push(current)
  }
  return out
}

/** A session's current turn: its latest user message, when its messages are loaded. */
export function latestTurn(messages: readonly unknown[] | undefined) {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = record(messages?.[index])
    if (message?.role === "user") return str(message.id)
  }
}

/**
 * Whether the "agent is editing" toast is due for a root session's turn.
 * `last` is the turn the previous toast was for (undefined when that turn was
 * not known). Without a way to tell turns apart, one toast stands until the
 * session goes idle, which is when the caller forgets it.
 */
export function followToastDue(seen: boolean, last: string | undefined, turn: string | undefined) {
  if (!seen) return true
  return last !== undefined && turn !== undefined && last !== turn
}

export function createAgentFollow(deps: AgentFollowDeps) {
  const [attributions, setAttributions] = createSignal<AgentAttribution[]>([])
  const [cursors, setCursors] = createSignal<FollowCursor[]>([])
  const [typing, setTyping] = createSignal<Record<string, FollowTyping>>({})
  const [followed, setFollowed] = createSignal<{ agentId: string; name: string; color: string; path: string }>()

  const intents = new Map<string, Intent>()
  // Calls that are over: every file landed, or the call failed, was rejected
  // or expired. The edit tool republishes its running part (with its metadata)
  // after file.edited, and that must not reopen the call it just landed.
  const closed = new Set<string>()
  // One target signal per directory, so an event in a parallel workspace never
  // re-runs what watches the main directory's target, or another workspace's.
  const targetSignals = new Map<string, Signal<FollowTarget | undefined>>()
  const waiting = new Set<string>()
  const requests = new Map<string, string>()
  const agentNames = new Map<string, string>()
  const echoes = new Map<string, number>()
  const recentLands = new Map<string, number>()
  const watcherTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; before?: string }>()
  const activity = new Map<string, ExternalActivityEntry["state"]>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let activityPrimed = false
  let pruneTimer: ReturnType<typeof setInterval> | undefined
  let buffer: ((key: string) => string | undefined) | undefined
  let stopListening: (() => void) | undefined
  let disposed = false

  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!disposed) fn()
    }, ms)
    timers.add(timer)
    return timer
  }

  const close = (id: string) => {
    closed.delete(id)
    closed.add(id)
    cap(closed, 500)
  }
  const targetSignal = (scope: string | undefined) => {
    const key = scope ?? ""
    let signal = targetSignals.get(key)
    if (!signal) {
      signal = createSignal<FollowTarget>()
      targetSignals.set(key, signal)
    }
    return signal
  }
  const targetOf = (scope: string | undefined) => targetSignal(scope)[0]()

  // Unsaved drafts win over the loaded file: they are what the editor shows.
  const peekText = (source: FollowSource, key: string) =>
    (source === deps.source ? buffer?.(key) : undefined) ?? source.peek(key)

  const identityFor = (sessionID: string, messageID: string | undefined): FollowIdentity => {
    const name = (messageID ? deps.agentFor?.(sessionID, messageID) : undefined) ?? agentNames.get(sessionID)
    return { id: sessionID, name: name ?? "Agent", color: resolveAgentColor(name, deps.agents(), sessionID) }
  }
  const externalIdentity = (external: FollowExternal): FollowIdentity => ({
    id: external.label,
    name: external.label,
    color: agentColor(external.label),
  })

  const prune = () => {
    const now = Date.now()
    setAttributions((list) => {
      const next = activeAttributions(list, now)
      return next.length === list.length ? list : next
    })
    setCursors((list) => {
      const next = list.filter(
        (cursor) => now - cursor.token < (cursor.state === "landed" ? ATTRIBUTION_TTL_MS : OPEN_INTENT_MAX_MS),
      )
      return next.length === list.length ? list : next
    })
    setTyping((all) => {
      const stale = Object.keys(all).filter((key) => now - all[key]!.token >= TYPING_ARM_MS)
      if (!stale.length) return all
      const next = { ...all }
      for (const key of stale) delete next[key]
      return next
    })
    for (const [id, intent] of intents) {
      if (now - intent.at <= OPEN_INTENT_MAX_MS) continue
      intents.delete(id)
      close(id)
    }
    for (const [key, at] of echoes) if (now - at > INTENT_ECHO_MS) echoes.delete(key)
    for (const [key, at] of recentLands) if (now - at > RECENT_LAND_MS) recentLands.delete(key)
    const idle =
      !attributions().length &&
      !cursors().length &&
      !Object.keys(typing()).length &&
      !intents.size &&
      !echoes.size &&
      !recentLands.size
    if (idle && pruneTimer) {
      clearInterval(pruneTimer)
      pruneTimer = undefined
    }
  }
  const schedulePrune = () => {
    if (pruneTimer || disposed) return
    pruneTimer = setInterval(prune, 1_000)
  }

  const putCursor = (next: FollowCursor) => {
    setCursors((list) => [...list.filter((item) => item.agentId !== next.agentId || item.path !== next.path), next])
    schedulePrune()
  }
  const removeCursors = (match: (cursor: FollowCursor) => boolean) =>
    setCursors((list) => {
      const next = list.filter((cursor) => !match(cursor))
      return next.length === list.length ? list : next
    })
  const updateCursors = (match: (cursor: FollowCursor) => boolean, update: (cursor: FollowCursor) => FollowCursor) =>
    setCursors((list) => (list.some(match) ? list.map((cursor) => (match(cursor) ? update(cursor) : cursor)) : list))

  const aim = (target: FollowTarget) => {
    targetSignal(target.scope)[1](target)
    if (!target.scope) {
      setFollowed({ agentId: target.agentId, name: target.agentName, color: target.color, path: target.path })
    }
  }
  const arm = (key: string, agent: FollowIdentity, token: number) => {
    setTyping((all) => ({
      ...all,
      [key]: { path: key, token, agentId: agent.id, agentName: agent.name, color: agent.color },
    }))
    schedulePrune()
  }
  const disarm = (key: string, token: number) =>
    setTyping((all) => {
      if (all[key]?.token !== token) return all
      const next = { ...all }
      delete next[key]
      return next
    })

  const intentCursor = (intent: Intent, file: IntentFile, state: FollowCursorState, token: number): FollowCursor => ({
    path: file.key,
    agentId: intent.agent.id,
    agentName: intent.agent.name,
    color: intent.agent.color,
    line: file.pending?.start ?? 1,
    pending: file.pending,
    state,
    token,
    intent: intent.id,
    scope: intent.source.scope,
  })

  const intentTarget = (intent: Intent, file: IntentFile, token: number): FollowTarget => ({
    path: file.key,
    line: file.pending?.start ?? 1,
    endLine: file.pending?.end ?? file.pending?.start ?? 1,
    token,
    agentId: intent.agent.id,
    agentName: intent.agent.name,
    color: intent.agent.color,
    sessionID: intent.sessionID,
    messageID: intent.messageID,
    scope: intent.source.scope,
  })

  // The file was not loaded when the call started: load it now, both so the
  // editor can show it and so the landed edit has a "before" to diff against.
  const fillBefore = async (intent: Intent, file: IntentFile) => {
    const text = await intent.source.read(file.key).catch(() => undefined)
    if (disposed || text === undefined || file.before !== undefined || file.landed || file.landing) return
    // The write beat this read, so it already holds the agent's text (perhaps
    // not yet formatted). That is no "before": the landing falls back to the
    // call's own input instead.
    if (!predatesEdit(text, file.target)) return
    file.before = text
    file.pending = intentRange(text, file.target)
    const pending = file.pending
    if (intents.get(intent.id) !== intent || !pending) return
    updateCursors(
      (cursor) => cursor.intent === intent.id && cursor.path === file.key && cursor.state !== "landed",
      (cursor) => ({ ...cursor, line: pending.start, pending }),
    )
    const current = targetOf(intent.source.scope)
    if (current?.path === file.key && current.agentId === intent.agent.id) {
      aim({ ...current, line: pending.start, endLine: pending.end, token: Date.now() })
    }
  }

  const openIntent = (input: {
    id: string
    sessionID?: string
    messageID?: string
    tool: string
    input: Record<string, unknown>
    targets: readonly EditTarget[]
    agent: FollowIdentity
    fixedIdentity: boolean
    source: FollowSource
    external: boolean
  }) => {
    const follow = deps.followAgent()
    const at = Date.now()
    const files: IntentFile[] = []
    for (const target of input.targets) {
      if (target.kind === "delete") continue
      const key = input.source.key(landingPath(target))
      if (!key || files.some((file) => file.key === key)) continue
      // A move reads its "before" from where the file was.
      const from = target.movePath ? input.source.key(target.file) : key
      const shown = from ? peekText(input.source, from) : undefined
      // Not following: never load a file only to attribute it, exactly as before.
      if (!follow && shown === undefined) continue
      // A call first seen completed can find its own write already on screen.
      const before = shown !== undefined && predatesEdit(shown, target) ? shown : undefined
      files.push({ key, target, before, pending: intentRange(before, target), landed: false, landing: false })
    }
    if (!files.length) return
    const intent: Intent = {
      id: input.id,
      sessionID: input.sessionID,
      messageID: input.messageID,
      tool: input.tool,
      input: input.input,
      agent: input.agent,
      fixedIdentity: input.fixedIdentity,
      files,
      source: input.source,
      at,
      external: input.external,
    }
    intents.set(intent.id, intent)
    if (!intent.external) for (const file of files) echoes.set(file.key, at)
    schedulePrune()
    if (!follow) return intent
    const state: FollowCursorState = waiting.delete(intent.id) ? "waiting" : "editing"
    for (const file of files) {
      putCursor(intentCursor(intent, file, state, at))
      arm(file.key, intent.agent, at)
      if (file.before === undefined) void fillBefore(intent, file)
    }
    aim(intentTarget(intent, files[0]!, at))
    return intent
  }

  const dropIntent = (id: string) => {
    const intent = intents.get(id)
    intents.delete(id)
    waiting.delete(id)
    close(id)
    removeCursors((cursor) => cursor.intent === id && cursor.state !== "landed")
    if (intent) for (const file of intent.files) disarm(file.key, intent.at)
  }

  const setIntentState = (id: string, state: FollowCursorState) =>
    updateCursors(
      (cursor) => cursor.intent === id && cursor.state !== "landed",
      (cursor) => ({ ...cursor, state }),
    )

  // Paint what landed and move the agent's cursor (and the follow) onto it.
  const settle = (input: {
    key: string
    agent: FollowIdentity
    ranges: LineRange[]
    follow: boolean
    fallbackLine?: number
    intent?: string
    sessionID?: string
    messageID?: string
    scope?: string
  }) => {
    const now = Date.now()
    if (input.ranges.length) {
      setAttributions((current) =>
        mergeAttribution(
          current,
          {
            path: input.key,
            agentId: input.agent.id,
            agentName: input.agent.name,
            color: input.agent.color,
            ranges: input.ranges,
            at: now,
          },
          now,
        ),
      )
      schedulePrune()
    }
    if (!input.follow) {
      removeCursors((cursor) => cursor.agentId === input.agent.id && cursor.path === input.key)
      return
    }
    const first = input.ranges[0]
    const line = first ? agentCursorLine(first) : input.fallbackLine
    if (line === undefined) removeCursors((cursor) => cursor.agentId === input.agent.id && cursor.path === input.key)
    else {
      putCursor({
        path: input.key,
        agentId: input.agent.id,
        agentName: input.agent.name,
        color: input.agent.color,
        line,
        state: "landed",
        token: now,
        intent: input.intent,
        scope: input.scope,
      })
    }
    aim({
      path: input.key,
      line: first?.start ?? line ?? 1,
      endLine: first?.end ?? line ?? 1,
      token: now,
      agentId: input.agent.id,
      agentName: input.agent.name,
      color: input.agent.color,
      sessionID: input.sessionID,
      messageID: input.messageID,
      scope: input.scope,
    })
  }

  const land = async (intent: Intent, file: IntentFile, agentName?: string) => {
    if (file.landed || file.landing) return
    file.landing = true
    // file.edited names the agent; the message may not have been loaded when
    // the call started.
    if (agentName && !intent.fixedIdentity && intent.sessionID && agentName !== intent.agent.name) {
      intent.agent = {
        id: intent.agent.id,
        name: agentName,
        color: resolveAgentColor(agentName, deps.agents(), intent.sessionID),
      }
    }
    const follow = deps.followAgent()
    // A long permission wait outlives the arm set at call time.
    const armed = typing()[file.key]
    if (follow && (!armed || Date.now() - armed.token > TYPING_ARM_MS / 2)) arm(file.key, intent.agent, Date.now())
    // What is on screen counts as the "before" only while the change has not
    // reached it (see fillBefore).
    const shown = file.before === undefined ? peekText(intent.source, file.key) : undefined
    const before = file.before ?? (shown !== undefined && predatesEdit(shown, file.target) ? shown : undefined)
    const after = await intent.source.read(file.key).catch(() => undefined)
    file.landing = false
    file.landed = true
    if (!intent.external) echoes.set(file.key, Date.now())
    recentLands.set(`${intent.messageID ?? ""}\n${file.key}`, Date.now())
    if (intents.get(intent.id) === intent && intent.files.every((item) => item.landed)) {
      intents.delete(intent.id)
      close(intent.id)
    }
    if (disposed) return
    if (after === undefined) {
      removeCursors((cursor) => cursor.intent === intent.id && cursor.path === file.key)
      return
    }
    let ranges = before !== undefined && before !== after ? diffLineRanges(before, after) : []
    // The "before" was captured too late (the write beat the load) or never:
    // the tool call's own input still says what it wrote.
    if (!ranges.length) {
      ranges = inferredLineRanges(
        after,
        { tool: intent.tool, input: intent.input },
        { nearLine: file.pending?.start, path: file.key, normalize: intent.source.key },
      )
    }
    settle({
      key: file.key,
      agent: intent.agent,
      ranges,
      follow,
      fallbackLine: file.pending?.start,
      intent: intent.id,
      sessionID: intent.sessionID,
      messageID: intent.messageID,
      scope: intent.source.scope,
    })
  }

  // An edit with no call seen: diff whatever was on screen against the file.
  const landLoose = async (input: {
    key: string
    source: FollowSource
    agent: FollowIdentity
    before?: string
    sessionID?: string
    messageID?: string
  }) => {
    const follow = deps.followAgent()
    const before = input.before ?? peekText(input.source, input.key)
    // Not following: only a file already on hand is attributed, as before.
    if (!follow && before === undefined) return
    const token = Date.now()
    if (follow) arm(input.key, input.agent, token)
    const after = await input.source.read(input.key).catch(() => undefined)
    if (disposed) return
    const ranges = before !== undefined && after !== undefined && before !== after ? diffLineRanges(before, after) : []
    if (after === undefined || (before !== undefined && !ranges.length)) {
      // Nothing changed after all (a no-op write, a spurious watcher event).
      disarm(input.key, token)
      return
    }
    settle({
      key: input.key,
      agent: input.agent,
      ranges,
      follow,
      sessionID: input.sessionID,
      messageID: input.messageID,
      scope: input.source.scope,
    })
  }

  const landLater = (intent: Intent, ms: number) =>
    later(() => {
      if (intents.get(intent.id) !== intent) return
      for (const file of intent.files) if (!file.landed && !file.landing) void land(intent, file)
    }, ms)

  const findIntent = (sessionID: string, messageID: string | undefined, key: string) => {
    // Oldest first: calls on one file run in the order they were made.
    for (const intent of intents.values()) {
      if (intent.external || intent.sessionID !== sessionID) continue
      if (messageID && intent.messageID !== messageID) continue
      const file = intent.files.find((item) => item.key === key && !item.landed && !item.landing)
      if (file) return { intent, file }
    }
  }

  const externalIntentFor = (key: string) => {
    for (const intent of intents.values()) {
      if (!intent.external) continue
      const file = intent.files.find((item) => item.key === key && !item.landed && !item.landing)
      if (file) return { intent, file }
    }
  }

  const onPart = (properties: Record<string, unknown>, source: FollowSource, options?: FollowHandleOptions) => {
    const part = toolPart(properties.part)
    if (!part) return
    const id = `${part.sessionID}\n${part.callID}`
    // A call that is over stays over, whatever its tool republishes.
    if (closed.has(id)) return
    const existing = intents.get(id)
    const start = (targets: readonly EditTarget[]) =>
      openIntent({
        id,
        sessionID: part.sessionID,
        messageID: part.messageID,
        tool: part.tool,
        input: part.input,
        targets,
        agent: options?.identity ?? identityFor(part.sessionID, part.messageID),
        fixedIdentity: Boolean(options?.identity),
        source,
        external: false,
      })
    if (part.status === "running") {
      // A running part that already carries the diff is the edit tool's
      // republish after its write: the file holds the new text, so there is no
      // before left to open a call on. The completed part lands it instead.
      if (!existing && !part.written) start(editTargets(part.tool, part.input))
      return
    }
    if (part.status === "error") {
      dropIntent(id)
      return
    }
    if (part.status !== "completed") return
    if (existing) {
      landLater(existing, LAND_FALLBACK_MS)
      return
    }
    // The running update was coalesced away, or this store started mid-call:
    // treat the completed call as its intent and landing at once. Files whose
    // file.edited already landed are left alone.
    if (part.end !== undefined && Date.now() - part.end > STALE_COMPLETION_MS) return
    const fresh = editTargets(part.tool, part.input).filter((target) => {
      const key = source.key(landingPath(target))
      return key !== undefined && !recentLands.has(`${part.messageID}\n${key}`)
    })
    const intent = fresh.length ? start(fresh) : undefined
    if (intent) landLater(intent, 0)
  }

  const onEdited = (properties: Record<string, unknown>, source: FollowSource, options?: FollowHandleOptions) => {
    const file = str(properties.file)
    const sessionID = str(properties.sessionID)
    if (!file || !sessionID) return
    const key = source.key(file)
    if (!key) return
    const agentName = str(properties.agent)
    if (agentName) {
      agentNames.set(sessionID, agentName)
      cap(agentNames, 200)
    }
    const messageID = str(properties.messageID)
    echoes.set(key, Date.now())
    schedulePrune()
    const found = findIntent(sessionID, messageID, key)
    if (found) {
      void land(found.intent, found.file, agentName)
      return
    }
    recentLands.set(`${messageID ?? ""}\n${key}`, Date.now())
    void landLoose({ key, source, agent: options?.identity ?? identityFor(sessionID, messageID), sessionID, messageID })
  }

  const onWatcher = (properties: Record<string, unknown>, source: FollowSource, options?: FollowHandleOptions) => {
    const external = options?.watcherEdits ? undefined : deps.external?.()
    if (!options?.watcherEdits && !external) return
    if (deps.saving?.()) return
    const file = str(properties.file)
    if (!file || properties.event === "unlink") return
    const key = source.key(file)
    if (!key) return
    const open = externalIntentFor(key)
    // A stopped runner's late write is still its own when it reported the file.
    if (external && !external.running && !open) return
    // A Vector agent's write echoes here right after file.edited.
    const echo = echoes.get(key)
    if (echo !== undefined && Date.now() - echo < INTENT_ECHO_MS) return
    const agent = options?.identity ?? (external ? externalIdentity(external) : undefined)
    if (!agent) return
    const pending = watcherTimers.get(key)
    if (pending) {
      clearTimeout(pending.timer)
      timers.delete(pending.timer)
    }
    // Capture the text before the file context's own watcher reload replaces it.
    const before = pending ? pending.before : (open?.file.before ?? peekText(source, key))
    const timer = later(() => {
      watcherTimers.delete(key)
      const current = externalIntentFor(key)
      if (current) {
        void land(current.intent, current.file)
        return
      }
      void landLoose({ key, source, agent, before })
    }, WATCHER_DEBOUNCE_MS)
    watcherTimers.set(key, { timer, before })
  }

  const onPermissionAsked = (properties: Record<string, unknown>) => {
    const sessionID = str(properties.sessionID)
    const callID = str(record(properties.tool)?.callID)
    if (!sessionID || !callID) return
    const id = `${sessionID}\n${callID}`
    const request = str(properties.id)
    if (request) {
      requests.set(request, id)
      cap(requests, 500)
    }
    if (!intents.has(id)) {
      // Asked before the running part arrived; the intent starts out waiting.
      waiting.add(id)
      cap(waiting, 200)
      return
    }
    setIntentState(id, "waiting")
  }

  const onPermissionReplied = (properties: Record<string, unknown>) => {
    const request = str(properties.requestID)
    const id = request ? requests.get(request) : undefined
    if (!request || !id) return
    requests.delete(request)
    waiting.delete(id)
    if (properties.reply === "reject") {
      dropIntent(id)
      return
    }
    setIntentState(id, "editing")
  }

  const handle = (event: FollowEvent, options?: FollowHandleOptions) => {
    if (disposed) return
    const type = event.type
    if (
      type !== "message.part.updated" &&
      type !== "file.edited" &&
      type !== "file.watcher.updated" &&
      type !== "permission.asked" &&
      type !== "permission.replied"
    )
      return
    const properties = record(event.properties)
    if (!properties) return
    const source = options?.source ?? deps.source
    if (type === "message.part.updated") return onPart(properties, source, options)
    if (type === "file.edited") return onEdited(properties, source, options)
    if (type === "file.watcher.updated") return onWatcher(properties, source, options)
    if (type === "permission.asked") return onPermissionAsked(properties)
    return onPermissionReplied(properties)
  }

  // External runners report the files a step touches. A running step opens
  // the file with the agent's cursor before the write reaches the watcher; a
  // finished one lands even where the watcher is off (web dev, WSL).
  const ingestActivity = (
    /** Undefined while the runner's record has not been read, which is not "nothing has run". */
    entries: readonly ExternalActivityEntry[] | undefined,
    options?: { source?: FollowSource; identity?: FollowIdentity },
  ) => {
    if (disposed || !entries) return
    const source = options?.source ?? deps.source
    const external = deps.external?.()
    const agent = options?.identity ?? (external ? externalIdentity(external) : undefined)
    if (!agent) return
    // The first snapshot read is history, not live: those steps ran before
    // the store started.
    const primed = activityPrimed
    activityPrimed = true
    for (const entry of entries) {
      const files = activityFiles(entry)
      if (!files.length) continue
      const previous = activity.get(entry.id)
      if (previous === entry.state) continue
      activity.set(entry.id, entry.state)
      const id = `external\n${entry.id}`
      if (entry.state === "failed") {
        dropIntent(id)
        continue
      }
      if (!primed && entry.state !== "running") continue
      const intent =
        intents.get(id) ??
        (previous
          ? undefined
          : openIntent({
              id,
              tool: "external",
              input: {},
              targets: files.map((file) => ({ file, kind: "update" as const })),
              agent,
              fixedIdentity: true,
              source,
              external: true,
            }))
      if (entry.state === "done" && intent) landLater(intent, EXTERNAL_LAND_FALLBACK_MS)
    }
    cap(activity, 500)
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    stopListening?.()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    for (const pending of watcherTimers.values()) clearTimeout(pending.timer)
    watcherTimers.clear()
    if (pruneTimer) clearInterval(pruneTimer)
    pruneTimer = undefined
  }

  stopListening = deps.listen?.((event) => handle(event.details))
  if (getOwner()) {
    onCleanup(dispose)
    if (deps.external) {
      createEffect(() => {
        const entries = deps.external?.()?.activity?.()
        if (entries) untrack(() => ingestActivity(entries))
      })
    }
  }

  return {
    attributions,
    cursors,
    /** Where the editor should be for the main directory. Other directories' targets never notify it. */
    target: () => targetOf(undefined),
    /** Where the editor should be for another directory (a parallel workspace). */
    targetFor: (scope: string | undefined) => targetOf(scope),
    /** The agent being followed in the main directory, and what it is doing. */
    following: () => {
      const current = followed()
      if (!current) return
      const cursor = cursors().find((item) => item.agentId === current.agentId && item.path === current.path)
      return { ...current, state: cursor?.state ?? ("landed" as FollowCursorState) }
    },
    attributionsFor: (path: string) => attributionsForPath(attributions(), path),
    cursorsFor: (path: string) => cursors().filter((cursor) => cursor.path === path),
    typingFor: (path: string) => typing()[path],
    /** Supply the editor's unsaved drafts, which win over the loaded file. */
    setBuffer: (fn: ((key: string) => string | undefined) | undefined) => {
      buffer = fn
    },
    handle,
    ingestActivity,
    /** Re-issue a target with a fresh token, so an editor opened late still reveals it. */
    refreshTarget: (scope?: string) => {
      // Untracked: a caller inside a computation must not re-run on the target it sets.
      const current = untrack(() => targetOf(scope))
      if (current) aim({ ...current, token: Date.now() })
    },
    clearFollowing: () => setFollowed(undefined),
    dispose,
  }
}

export type AgentFollow = ReturnType<typeof createAgentFollow>
