import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Instruction } from "../../src/session/instruction"
import type { Tool } from "@/tool/tool"
import { MemoryTool } from "../../src/tool/memory"
import { SessionMemory } from "../../src/session/memory"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import { Session } from "@/session/session"

// What the agent keeps and learns from documents. The owner's rule is to learn freely with Undo: a file the agent keeps
// and a memory it learns from a card are in use at once, with an Undo line in the session, and wait for the user only
// after outside content. What is learned from a document is as private as the document, and a document quote counts as
// evidence only in its passage's own words.

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      ToolRegistry.node,
      CrossSpawnSpawner.node,
      Ripgrep.node,
      BrainDatabase.node,
      Brain.node,
      BrainKnowledge.node,
      Instruction.node,
      Session.node,
      FreeModelGuests.node,
      FSUtil.node,
    ]),
  ),
)

const model = { providerID: ProviderV2.ID.make("anthropic"), modelID: ModelV2.ID.make("claude-sonnet-4-20250514") }

const SPEC = `# Auth spec

## 1 Sessions

Refresh tokens expire after 14 days.

## 2 Limits

Clients MUST retry at most 3 times after a 429 response.
`

let counter = 0
const id = (prefix: string) => `${prefix}_retain-${++counter}`

function history(input: {
  readonly sessionID: SessionID
  readonly said: string
  readonly tools?: ReadonlyArray<{ readonly tool: string; readonly metadata?: Record<string, unknown> }>
}): SessionV1.WithParts[] {
  const user = MessageID.make(id("msg"))
  const assistant = MessageID.make(id("msg"))
  return [
    {
      info: { id: user, sessionID: input.sessionID, role: "user", time: { created: Date.now() - 1_000 }, agent: "build", model },
      parts: [{ id: PartID.make(id("prt")), messageID: user, sessionID: input.sessionID, type: "text", text: input.said }],
    },
    {
      info: {
        id: assistant,
        sessionID: input.sessionID,
        role: "assistant",
        parentID: user,
        mode: "build",
        agent: "build",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: model.modelID,
        providerID: model.providerID,
        time: { created: Date.now() - 500 },
      },
      parts: (input.tools ?? []).map((call) => ({
        id: PartID.make(id("prt")),
        messageID: assistant,
        sessionID: input.sessionID,
        type: "tool" as const,
        callID: id("call"),
        tool: call.tool,
        state: {
          status: "completed" as const,
          input: {},
          output: "",
          title: call.tool,
          metadata: call.metadata ?? {},
          time: { start: 0, end: 1 },
        },
      })),
    },
  ]
}

const memory = Effect.gen(function* () {
  const registry = yield* ToolRegistry.Service
  const tool = (yield* registry.tools({
    providerID: ProviderV2.ID.openai,
    modelID: ModelV2.ID.make("gpt-5"),
    agent: { name: "build", mode: "primary" as const, permission: [], options: {} },
  })).find((item) => item.id === MemoryTool.id)
  if (!tool) throw new Error("Memory tool not found")
  return (
    params: Record<string, unknown>,
    messages: SessionV1.WithParts[],
    sessionID: SessionID,
    extra: Record<string, unknown> = { mayTrain: false },
  ) =>
    tool.execute(params, {
      sessionID,
      messageID: MessageID.make(id("msg")),
      callID: id("call"),
      agent: "build",
      abort: AbortSignal.any([]),
      extra,
      messages,
      metadata: () => Effect.void,
      ask: () => Effect.void,
    } satisfies Tool.Context)
})

const spec = (origin: BrainKnowledge.Origin = "upload", hold?: "mcp") =>
  Effect.gen(function* () {
    const knowledge = yield* BrainKnowledge.Service
    const place = yield* (yield* Instruction.Service).place()
    const added = yield* knowledge.add(place, {
      type: "text",
      name: "Auth spec.md",
      text: SPEC,
      origin,
      ...(hold ? { hold } : {}),
    })
    if (added.type === "refused") throw new Error(added.message)
    yield* knowledge.wait(place, added.document.id, "searchable", 10_000)
    if (hold) yield* knowledge.update(place, added.document.id, { action: "approve" })
    const [record] = (yield* knowledge.records(place, { query: "retry 429", personal: true })).records
    return { knowledge, place, document: added.document.id, record: record! }
  })

describe("what the agent keeps", () => {
  it.instance("a file kept without the user's words is in use at once, with an Undo that forgets it for good", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(dir, "docs", "auth.md"), SPEC)
      const run = yield* memory
      const sessionID = SessionID.make("ses_retain_keep")
      // The user asked a question; nothing they said asks to keep anything.
      const kept = yield* run({ action: "add", file: "docs/auth.md" }, history({ sessionID, said: "How long do sessions last?" }), sessionID)
      expect(kept.output).toContain("searchable now")
      expect(kept.metadata.hold).toBeUndefined()
      const document = kept.metadata.id as string
      // The session shows it with Undo; a private document's title stays out of the transcript.
      expect(kept.metadata.learned).toEqual({ scope: "repository", document: true, private: true })
      const knowledge = yield* BrainKnowledge.Service
      const place = yield* (yield* Instruction.Service).place()
      expect((yield* knowledge.documents(place, { personal: true }))[0]).toMatchObject({ id: document, status: "searchable" })
      // Undo forgets it, and the agent does not keep it again on its own.
      expect(yield* knowledge.remove(place, document)).toBe("removed")
      const again = yield* run({ action: "add", file: "docs/auth.md" }, history({ sessionID, said: "Any news?" }), sessionID)
      expect(again.output).toContain("forgot this document")
      expect(again.metadata.learned).toBeUndefined()
    }),
  )

  it.instance("after outside content the file waits for the user, with no Undo line; a guest's session keeps none", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(dir, "docs", "auth.md"), SPEC)
      const run = yield* memory
      const tainted = SessionID.make("ses_retain_web")
      const held = yield* run(
        { action: "add", file: "docs/auth.md" },
        history({ sessionID: tainted, said: "Keep the auth spec.", tools: [{ tool: "webfetch" }] }),
        tainted,
      )
      expect(held.metadata.hold).toBe("web")
      expect(held.metadata.learned).toBeUndefined()
      const guest = SessionID.make("ses_retain_guest")
      yield* (yield* FreeModelGuests.Service).mark(guest)
      const refused = yield* run({ action: "add", file: "docs/auth.md" }, history({ sessionID: guest, said: "Keep it." }), guest)
      expect(refused.metadata.result).toBe("refused")
    }),
  )
})

describe("learning from a document quote", () => {
  it.instance("a quote that is not in the card's passage is refused, and nothing is learned", () =>
    Effect.gen(function* () {
      const { record } = yield* spec()
      const run = yield* memory
      const sessionID = SessionID.make("ses_retain_made_up")
      const write = yield* run(
        {
          action: "add",
          kind: "fact",
          text: "Clients retry at most 10 times after a 429 response.",
          file: record.id,
          quote: "Clients MUST retry at most 10 times after a 429 response.",
        },
        history({ sessionID, said: "How often may clients retry?" }),
        sessionID,
      )
      expect(write.metadata.result).toBe("refused")
      expect(write.output).toContain("not in")
      const brain = yield* Brain.Service
      const place = yield* (yield* Instruction.Service).place()
      expect(yield* brain.search(place, { query: "clients retry 429", personal: true })).toEqual([])
    }),
  )

  it.instance("a real quote is learned at once, as private as its document, derived from the card", () =>
    Effect.gen(function* () {
      const { record } = yield* spec()
      const run = yield* memory
      const sessionID = SessionID.make("ses_retain_quote")
      const write = yield* run(
        {
          action: "add",
          kind: "fact",
          text: "Clients retry at most 3 times after a 429 response.",
          file: record.id,
          quote: "Clients MUST retry at most 3 times after a 429 response.",
        },
        history({ sessionID, said: "How often may clients retry?" }),
        sessionID,
      )
      expect(write.metadata.result).toBe("added")
      expect(write.metadata.learned).toEqual({ scope: "repository", private: true })
      const brain = yield* Brain.Service
      const place = yield* (yield* Instruction.Service).place()
      const detail = yield* brain.get(place, write.metadata.id as string, { personal: true })
      expect(detail!.entry).toMatchObject({ status: "active", private: true, confidence: 0.8 })
      expect(detail!.evidence.at(-1)).toMatchObject({ type: "document", path: record.id })
      const db = (yield* BrainDatabase.Service).db
      const edges = yield* db.all<{ type: string; target: string }>(
        sql`SELECT type, target FROM brain_edge WHERE source = ${write.metadata.id as string}`,
      )
      expect(edges).toContainEqual({ type: "derived_from", target: record.id })
      // A model that may train cannot quote a private document at all.
      const training = yield* run(
        {
          action: "add",
          kind: "fact",
          text: "Refresh tokens expire after 14 days.",
          file: record.passage,
          quote: "Refresh tokens expire after 14 days.",
        },
        history({ sessionID, said: "How long do sessions last?" }),
        sessionID,
        { mayTrain: true },
      )
      expect(training.metadata.result).toBe("refused")
      expect(training.output).not.toContain("14 days")
    }),
  )

  it.instance("a quote from a document that came from outside is learned only for the user's review", () =>
    Effect.gen(function* () {
      const { record } = yield* spec("agent", "mcp")
      const run = yield* memory
      const sessionID = SessionID.make("ses_retain_outside")
      const write = yield* run(
        {
          action: "add",
          kind: "fact",
          text: "Clients retry at most 3 times after a 429 response.",
          file: record.id,
          quote: "Clients MUST retry at most 3 times after a 429 response.",
        },
        history({ sessionID, said: "How often may clients retry?" }),
        sessionID,
      )
      expect(write.metadata.result).toBe("held")
      expect(write.metadata.hold).toBe("mcp")
      expect(write.metadata.learned).toBeUndefined()
      expect(SessionMemory.taint(history({ sessionID, said: "How often may clients retry?" }))).toBeUndefined()
    }),
  )
})
