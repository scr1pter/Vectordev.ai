import { expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { NotFoundError } from "@/storage/storage"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Session.node, SessionSummary.node, SessionProjector.node, MessageV2.node])),
)

const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }

const addUser = Effect.fn("test.addUser")(function* (sessionID: SessionID, summary?: SessionV1.User["summary"]) {
  const sessions = yield* Session.Service
  const id = MessageID.ascending()
  yield* sessions.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model,
    summary,
  })
  return id
})

it.instance("summary diff returns the selected user's stored diffs and metadata", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const summary = yield* SessionSummary.Service
    const session = yield* sessions.create({})
    const diffs = [{ file: "selected.ts", patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1 }]
    const messageID = yield* addUser(session.id, { title: "Selected", diffs })
    yield* addUser(session.id, { diffs: [{ file: "other.ts", additions: 2, deletions: 0 }] })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: session.id,
      messageID,
      type: "text",
      text: "Message body is separate from summary metadata.",
    })

    expect(yield* summary.diff({ sessionID: session.id, messageID })).toEqual(diffs)
    const info = yield* MessageV2.getInfo({ sessionID: session.id, messageID })
    expect(info).toMatchObject({
      id: messageID,
      sessionID: session.id,
      role: "user",
      summary: { title: "Selected", diffs },
    })
    expect(info).not.toHaveProperty("parts")
    const message = yield* MessageV2.get({ sessionID: session.id, messageID })
    expect(message.info).toEqual(info)
    expect(message.parts).toEqual([
      expect.objectContaining({ type: "text", text: "Message body is separate from summary metadata." }),
    ])
  }),
)

it.instance("summary diff returns empty for omitted, missing, and unsummarized messages", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const summary = yield* SessionSummary.Service
    const session = yield* sessions.create({})
    const messageID = yield* addUser(session.id)

    expect(yield* summary.diff({ sessionID: session.id })).toEqual([])
    expect(yield* summary.diff({ sessionID: session.id, messageID: MessageID.ascending() })).toEqual([])
    expect(yield* summary.diff({ sessionID: session.id, messageID })).toEqual([])
    expect(yield* summary.diff({ sessionID: SessionID.make("ses_missing") })).toEqual([])
  }),
)

it.instance("summary diff returns empty for assistant and cross-session message IDs", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const summary = yield* SessionSummary.Service
    const session = yield* sessions.create({})
    const other = yield* sessions.create({})
    const messageID = yield* addUser(session.id, { diffs: [{ file: "private.ts", additions: 1, deletions: 0 }] })
    const assistant = MessageID.ascending()
    yield* sessions.updateMessage({
      id: assistant,
      sessionID: session.id,
      role: "assistant",
      parentID: messageID,
      time: { created: Date.now() },
      modelID: model.modelID,
      providerID: model.providerID,
      mode: "build",
      agent: "build",
      path: { cwd: session.directory, root: session.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })

    expect(yield* summary.diff({ sessionID: session.id, messageID: assistant })).toEqual([])
    expect(yield* summary.diff({ sessionID: other.id, messageID })).toEqual([])
    const error = yield* Effect.flip(MessageV2.getInfo({ sessionID: other.id, messageID }))
    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.message).toBe(`Message not found: ${messageID}`)
  }),
)

it.instance("summary diff preserves the missing-session error", () =>
  Effect.gen(function* () {
    const summary = yield* SessionSummary.Service
    const sessionID = SessionID.make("ses_missing")
    const result = yield* summary.diff({ sessionID, messageID: MessageID.ascending() }).pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(Cause.squash(result.cause)).toBeInstanceOf(NotFoundError)
      expect(Cause.squash(result.cause)).toMatchObject({ message: `Session not found: ${sessionID}` })
    }
  }),
)

it.instance("summary diff decodes quoted Git paths without changing stored metadata", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const summary = yield* SessionSummary.Service
    const session = yield* sessions.create({})
    const diffs = [
      { file: '"caf\\303\\251\\t\\"quoted\\".ts"', additions: 1, deletions: 0 },
      { file: "plain.ts", patch: "unchanged patch", additions: 2, deletions: 1 },
      { additions: 3, deletions: 2 },
    ]
    const messageID = yield* addUser(session.id, { diffs })

    expect(yield* summary.diff({ sessionID: session.id, messageID })).toEqual([
      { file: 'café\t"quoted".ts', additions: 1, deletions: 0 },
      diffs[1],
      diffs[2],
    ])
    expect(yield* MessageV2.getInfo({ sessionID: session.id, messageID })).toMatchObject({ summary: { diffs } })
  }),
)
