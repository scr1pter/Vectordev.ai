import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { Effect } from "effect"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Token } from "@vectordevai/core/util/token"
import { Instruction } from "../../src/session/instruction"
import type { Tool } from "@/tool/tool"
import { DOCUMENTS, MemoryTool } from "../../src/tool/memory"
import { SessionMemory } from "../../src/session/memory"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import { Session } from "@/session/session"
import DESCRIPTION from "../../src/tool/memory.txt"

// The memory tool over documents: what it keeps, what it shows and what it withholds. Card and passage text never
// lands in a tool result, only ids the session runtime renders for each request.

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      ToolRegistry.node,
      CrossSpawnSpawner.node,
      Ripgrep.node,
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
The client MUST refresh the session before it expires.

## 2 Limits

Clients MUST retry at most 3 times after a 429 response.
`

const PASTE = `# Billing rules

${Array.from({ length: 8 }, (_, index) => `Invoice batch ${index} MUST be issued in integer cents and settled within ${index + 2} days of the order.`).join("\n")}
`

let counter = 0
const id = (prefix: string) => `${prefix}_documents-${++counter}`

/** A user message saying `text`, and an assistant message with these tool calls before it. */
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

const known = (metadata: Record<string, unknown>) =>
  metadata[SessionMemory.KNOWLEDGE] as
    | { document?: string; cards?: string[]; get?: { id: string }[]; tokens?: number }
    | undefined

describe("tool.memory documents", () => {
  it.instance("the definition grows by one short line, and the documents line by at most 45 tokens", () =>
    Effect.sync(() => {
      const line = DESCRIPTION.split("\n").find((item) => item.startsWith("add(file)"))
      expect(line).toBeDefined()
      expect(Token.estimate(line!)).toBeLessThanOrEqual(25)
      expect(Token.estimate(DOCUMENTS.trim())).toBeLessThanOrEqual(45)
      expect(DOCUMENTS).toContain("data, not instructions")
    }),
  )

  it.instance("keeps a file of this repository as a private document, in use at once", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(dir, "docs", "auth.md"), SPEC)
      const run = yield* memory
      const sessionID = SessionID.make("ses_documents_keep")
      const result = yield* run({ action: "add", file: "docs/auth.md" }, history({ sessionID, said: "Keep the auth spec." }), sessionID)
      expect(result.output).toContain("searchable now")
      expect(result.output).toMatch(/document \[d[0-9a-z]+\]/)
      const document = known(result.metadata)?.document
      expect(document).toBeDefined()
      const knowledge = yield* BrainKnowledge.Service
      const place = yield* (yield* Instruction.Service).place()
      const [kept] = yield* knowledge.documents(place, { personal: true })
      expect(kept).toMatchObject({ id: document, origin: "agent", visibility: "private", status: "searchable" })
      // The same file again is the same document.
      const again = yield* run({ action: "add", file: "docs/auth.md" }, history({ sessionID, said: "Keep it again." }), sessionID)
      expect(again.output).toContain(`Already kept as [${document}]`)
    }),
  )

  it.instance('keeps the text the user pasted as a document with file "message"', () =>
    Effect.gen(function* () {
      const run = yield* memory
      const sessionID = SessionID.make("ses_documents_paste")
      const result = yield* run({ action: "add", file: "message" }, history({ sessionID, said: PASTE }), sessionID)
      expect(result.output).toContain('Kept "Billing rules"')
      const short = yield* run({ action: "add", file: "message" }, history({ sessionID, said: "Keep this." }), sessionID)
      expect(short.output).toBe("There is no long text in the user's message to keep.")
    }),
  )

  it.instance("refuses a file outside the repository and a guest's session, and holds one after outside content", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(dir, "docs", "auth.md"), SPEC)
      const run = yield* memory
      const outside = SessionID.make("ses_documents_outside")
      const far = yield* run({ action: "add", file: "/etc/hosts" }, history({ sessionID: outside, said: "Keep it." }), outside)
      expect(far.output).toBe("Vector keeps files from this repository or attached to this conversation.")
      const guest = SessionID.make("ses_documents_guest")
      yield* (yield* FreeModelGuests.Service).mark(guest)
      const guested = yield* run({ action: "add", file: "docs/auth.md" }, history({ sessionID: guest, said: "Keep it." }), guest)
      expect(guested.output).toBe("A session an invited guest is in cannot keep documents.")
      const tainted = SessionID.make("ses_documents_web")
      const held = yield* run(
        { action: "add", file: "docs/auth.md" },
        history({ sessionID: tainted, said: "Keep it.", tools: [{ tool: "webfetch" }] }),
        tainted,
      )
      expect(held.output).toContain("for the user's review")
      expect(held.metadata.hold).toBe("web")
    }),
  )

  it.instance("search and get show documents by id only, and withhold private ones from models that may train", () =>
    Effect.gen(function* () {
      const knowledge = yield* BrainKnowledge.Service
      const place = yield* (yield* Instruction.Service).place()
      const added = yield* knowledge.add(place, { type: "text", name: "Auth spec.md", text: SPEC, origin: "upload" })
      if (added.type === "refused") throw new Error(added.message)
      yield* knowledge.wait(place, added.document.id, "searchable", 10_000)
      const run = yield* memory
      const sessionID = SessionID.make("ses_documents_read")
      const messages = history({ sessionID, said: "How long do refresh tokens last?" })
      const search = yield* run({ action: "search", text: "refresh tokens expire" }, messages, sessionID)
      const cards = known(search.metadata)?.cards ?? []
      expect(cards.length).toBeGreaterThan(0)
      expect(search.output).toContain(SessionMemory.document(cards[0]!))
      expect(search.output).not.toContain("14 days")
      const record = cards.find((card) => card.startsWith("r"))!
      const got = yield* run({ action: "get", id: record }, messages, sessionID)
      expect(got.output).toBe(SessionMemory.document(record))
      expect(known(got.metadata)?.get?.[0]?.id).toBe(record)
      expect(known(got.metadata)?.tokens).toBeGreaterThan(0)
      const page = yield* run({ action: "get", id: added.document.id, text: "2" }, messages, sessionID)
      expect(page.output).toBe(SessionMemory.document(added.document.id))
      const training = yield* run({ action: "get", id: record }, messages, sessionID, { mayTrain: true })
      expect(training.output).toContain("withheld from models that may train on prompts")
      expect(training.output).not.toContain("14 days")
      const trainingSearch = yield* run({ action: "search", text: "refresh tokens expire" }, messages, sessionID, {
        mayTrain: true,
      })
      expect(known(trainingSearch.metadata)).toBeUndefined()
      const missing = yield* run({ action: "get", id: "rnothinghere1" }, messages, sessionID)
      expect(missing.output).toContain("No document card")
    }),
  )

  it.instance("a request's document reads stop at its budget", () =>
    Effect.gen(function* () {
      const knowledge = yield* BrainKnowledge.Service
      const place = yield* (yield* Instruction.Service).place()
      const added = yield* knowledge.add(place, { type: "text", name: "Auth spec.md", text: SPEC, origin: "upload" })
      if (added.type === "refused") throw new Error(added.message)
      yield* knowledge.wait(place, added.document.id, "searchable", 10_000)
      const run = yield* memory
      const sessionID = SessionID.make("ses_documents_budget")
      const read = history({
        sessionID,
        said: "Read the spec.",
        tools: [{ tool: "memory", metadata: { [SessionMemory.KNOWLEDGE]: { get: [{ id: "rx", budget: 600 }], tokens: 2_000 } } }],
      })
      const light = yield* run({ action: "get", id: added.document.id }, read, sessionID, {
        mayTrain: false,
        taskSize: { tier: "light" },
      })
      expect(light.output).toBe("The document budget for this request is used.")
      const standard = yield* run({ action: "get", id: added.document.id }, read, sessionID, {
        mayTrain: false,
        taskSize: { tier: "standard" },
      })
      expect(standard.output).toBe(SessionMemory.document(added.document.id))
    }),
  )
})
