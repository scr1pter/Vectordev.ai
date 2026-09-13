import { Effect } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import type { MessageID, SessionID } from "@/session/schema"
import type { SubagentRecord, SubagentStatus, SubagentUsage } from "@/agent/subagent-kind"
import { isRecord } from "@/util/record"

/*
 * Lifecycle bookkeeping for task-tool subagents.
 *
 * Each child session carries a SubagentRecord at `metadata.subagent`.
 * Session.setMetadata publishes `session.updated`, so the record survives a
 * restart and reaches clients live. The same lifecycle fields are mirrored
 * onto the parent's task tool part, which publishes `message.part.updated`.
 * Nothing here may fail a task, so every helper swallows its own errors.
 */

/** Key of the lifecycle record in a child session's metadata. */
export const METADATA_KEY = "subagent"

export type FinalStatus = Extract<SubagentStatus, "completed" | "error" | "cancelled">

/** Lifecycle fields that change after launch. In a patch, `undefined` clears the field. */
export type Outcome = Partial<Pick<SubagentRecord, "status" | "completedAt" | "usage" | "error">>

// A background launch's part is completed right after the launch returns, and
// a foreground part turns to error as soon as the call fails, so a short wait
// covers both.
const PART_ATTEMPTS = 50
const PART_RETRY = "200 millis"

export function read(info: Pick<Session.Info, "metadata">): SubagentRecord | undefined {
  const value = info.metadata?.[METADATA_KEY]
  return isRecord(value) ? (value as SubagentRecord) : undefined
}

/** Shallow merge in which an `undefined` patch value removes the key. */
export function merge(base: Record<string, unknown> | undefined, patch: object) {
  const next: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return next
}

/** Drops keys whose value is `undefined`. */
export function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as Partial<T>
}

/** Merges a patch into the child's record. setMetadata replaces the whole metadata object, so this reads first. */
export function update(sessions: Session.Interface, sessionID: SessionID, patch: Partial<SubagentRecord>) {
  return Effect.gen(function* () {
    const info = yield* sessions.get(sessionID)
    yield* sessions.setMetadata({
      sessionID,
      metadata: { ...info.metadata, [METADATA_KEY]: merge(read(info), patch) },
    })
  }).pipe(
    Effect.catchCause(() => Effect.void),
    Effect.withSpan("SubagentLifecycle.update"),
  )
}

function failure(error: SessionV1.Assistant["error"]): { status: "error" | "cancelled"; error?: string } | undefined {
  if (!error) return undefined
  if (error.name === "MessageAbortedError") return { status: "cancelled" }
  const data: unknown = (error as { data?: unknown }).data
  const message = isRecord(data) && typeof data.message === "string" && data.message ? data.message : undefined
  return { status: "error", error: message ?? error.name }
}

/**
 * The child's usage: the session row's cost and tokens, which the session
 * projector sums from every step-finish part, plus tool and step counts. Also
 * returns the error the last assistant message ended with, if any.
 */
export function observe(sessions: Session.Interface, sessionID: SessionID) {
  return Effect.gen(function* () {
    const info = yield* sessions.get(sessionID)
    const messages = yield* sessions.messages({ sessionID })
    let toolUses = 0
    let steps = 0
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type === "tool") toolUses += 1
        if (part.type === "step-finish") steps += 1
      }
    }
    const tokens = {
      input: info.tokens?.input ?? 0,
      output: info.tokens?.output ?? 0,
      reasoning: info.tokens?.reasoning ?? 0,
      cache: { read: info.tokens?.cache.read ?? 0, write: info.tokens?.cache.write ?? 0 },
    }
    const usage: SubagentUsage = {
      cost: info.cost ?? 0,
      tokens,
      total: tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write,
      toolUses,
      steps,
    }
    const last = messages.findLast((message) => message.info.role === "assistant")
    return { usage, failure: last?.info.role === "assistant" ? failure(last.info.error) : undefined }
  }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
}

/**
 * Final lifecycle fields for a run whose job ended with `input.status`. A job
 * that completed while the child's last assistant message carries an error is
 * recorded as error, or as cancelled when that error is an abort.
 */
export function outcome(
  sessions: Session.Interface,
  sessionID: SessionID,
  input: { status: FinalStatus; error?: string },
) {
  return observe(sessions, sessionID).pipe(
    Effect.map((observed) => {
      const final = input.status === "completed" && observed?.failure ? observed.failure : input
      return {
        status: final.status,
        completedAt: Date.now(),
        usage: observed?.usage,
        error: final.error,
      } satisfies Outcome
    }),
  )
}

/** Writes the final lifecycle fields onto the child's record and returns them. */
export function settle(
  sessions: Session.Interface,
  sessionID: SessionID,
  input: { status: FinalStatus; error?: string },
) {
  return outcome(sessions, sessionID, input).pipe(Effect.tap((value) => update(sessions, sessionID, value)))
}

/**
 * Merges `patch` into the metadata of the parent's task tool part, found by
 * message and call id, and publishes message.part.updated. The processor
 * writes the tool's returned metadata when it settles the call, so a part
 * that is still pending or running is retried briefly instead of patched. A
 * part that does not exist (a caller without a processor) is skipped. A
 * function `patch` is read when the write lands, so it carries the latest state.
 */
export function patchPart(input: {
  sessions: Session.Interface
  messageID: MessageID
  callID: string
  patch: object | (() => object)
}) {
  const attempt = Effect.gen(function* () {
    const part = (yield* MessageV2.parts(input.messageID)).find(
      (item): item is SessionV1.ToolPart => item.type === "tool" && item.callID === input.callID,
    )
    if (!part) return "missing" as const
    if (part.state.status !== "completed" && part.state.status !== "error") return "pending" as const
    const patch = typeof input.patch === "function" ? input.patch() : input.patch
    yield* input.sessions.updatePart({
      ...part,
      state: { ...part.state, metadata: merge(part.state.metadata, patch) },
    })
    return "done" as const
  })
  return Effect.gen(function* () {
    for (let index = 0; index < PART_ATTEMPTS; index++) {
      if ((yield* attempt) !== "pending") return
      yield* Effect.sleep(PART_RETRY)
    }
  }).pipe(
    Effect.catchCause(() => Effect.void),
    Effect.withSpan("SubagentLifecycle.patchPart"),
  )
}

export * as SubagentLifecycle from "./subagent-lifecycle"
