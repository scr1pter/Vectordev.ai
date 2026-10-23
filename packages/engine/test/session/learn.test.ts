import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "path"
import { afterAll, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { BrainLearn } from "@vectordevai/core/brain/learn"
import { BrainSchema } from "@vectordevai/core/brain/schema"
import { Global } from "@vectordevai/core/global"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Database } from "@vectordevai/core/database/database"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { FSUtil } from "@vectordevai/core/fs-util"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { MemoryEvent } from "@vectordevai/schema/memory-event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionMemory } from "../../src/session/memory"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Format } from "../../src/format"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Auth } from "@/auth"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import type { SessionID } from "../../src/session/schema"

// Learning about you (section 6.3), end to end against the fake LLM server with no paid model call: what the user
// types at the end of each request teaches Vector their terms and preferences, by plain code. A greeting teaches nothing
// and costs nothing, pasted text vouches for nothing, a term comes back only when a request names it, what the user
// takes back stays out, and the optional model learner's suggestions in a session that read outside content only wait.

// Memory lives in the user's config folder, so this test gets one of its own rather than the shared one.
const config = mkdtempSync(path.join(os.tmpdir(), "vector-learn-"))
afterAll(() => rmSync(config, { recursive: true, force: true }))

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    cloudTools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    remove: () => Effect.void,
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed([]),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  SpendGuard.node,
  Auth.node,
  BrainKnowledge.node,
  Brain.node,
  FreeModelGuests.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])

const it = testEffect(
  LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    [Global.node, Global.layerWith({ config })],
  ]),
)

const ref = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("test-model") }

const providerConfig = (url: string): Partial<ConfigV1.Info> => ({
  provider: {
    lmstudio: {
      name: "Test",
      id: "lmstudio",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

const allow = [{ permission: "*", pattern: "*", action: "allow" as const }]

const TERM = "when I say ship it I mean open a PR, wait for CI, then merge"

const setup = Effect.fn("test.setup")(function* () {
  const dir = (yield* TestInstance).directory
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(path.join(dir, "vector.json"), JSON.stringify(providerConfig(llm.url)))
  const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(dir, [path.join(dir, "vector.json")]))
  yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
  const brain = yield* Brain.Service
  const instruction = yield* Instruction.Service
  const place = yield* instruction.place()
  // The model learner runs with any model in these tests; by default it runs only with Vector Local on.
  yield* brain.setLearnSettings({ learning: true, modelLearner: "always" })
  return { llm, brain, place }
})

type Part = { type: "text"; text: string; metadata?: Record<string, unknown> }

// One prompt in a session of its own (or the one given), with the bodies of every model request it made.
const send = Effect.fn("test.send")(function* (input: {
  text?: string
  parts?: Part[]
  sessionID?: SessionID
  reply?: string
}) {
  const llm = yield* TestLLMServer
  const sessions = yield* Session.Service
  const prompt = yield* SessionPrompt.Service
  const sessionID = input.sessionID ?? (yield* sessions.create({ title: "Learn", permission: allow })).id
  const before = (yield* llm.hits).length
  yield* llm.text(input.reply ?? "Done.")
  yield* prompt.prompt({
    sessionID,
    agent: "build",
    model: ref,
    parts: input.parts ?? [{ type: "text", text: input.text ?? "" }],
  })
  return { sessionID, bodies: (yield* llm.hits).slice(before).map((hit) => JSON.stringify(hit.body)) }
})

// What Vector learned on its own, of every state and in either scope.
const learned = Effect.fn("test.learned")(function* () {
  const brain = yield* Brain.Service
  const instruction = yield* Instruction.Service
  return (yield* brain.list(yield* instruction.place(), { filter: "all" })).filter((entry) => entry.origin === "agent")
})

// The model learner runs in the background once the run is over: wait until its request was made and answered.
const settled = Effect.fn("test.settled")(function* <R>(check: Effect.Effect<boolean, never, R>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (yield* check) return
    yield* Effect.sleep("50 millis")
  }
})

it.instance(
  '"hi" adds no memory tokens and causes no learn call',
  () =>
    Effect.gen(function* () {
      const { brain, place } = yield* setup()
      yield* brain.propose(place, {
        kind: "preference",
        text: "I prefer tables for comparisons",
        scope: "personal",
        origin: "user",
        evidence: { type: "user" },
      })
      const { bodies } = yield* send({ text: "hi", reply: "Hello." })
      // The greeting's own request and nothing else: no title request, no learner.
      expect(bodies).toHaveLength(1)
      expect(bodies[0]).not.toContain("vector_memory")
      expect(bodies[0]).not.toContain("tables for comparisons")
      expect(yield* learned()).toEqual([])
    }),
  120_000,
)

it.instance(
  "a definition of the user's words becomes an active term, recalled only when a request names it",
  () =>
    Effect.gen(function* () {
      yield* setup()
      const events = yield* EventV2Bridge.Service
      const announced: unknown[] = []
      const unsubscribe = yield* events.listen((event) => {
        if (event.type === MemoryEvent.Learned.type) announced.push(event.data)
        return Effect.void
      })
      const first = yield* send({ text: TERM })
      yield* unsubscribe
      const [term] = yield* learned()
      expect(term).toMatchObject({ kind: "term", status: "active", facet: "vocabulary", term: { key: "ship it" } })
      expect(announced).toEqual([{ sessionID: first.sessionID, entryIDs: [term!.id], messageID: expect.any(String) }])
      // Only the request that names it carries it.
      const named = yield* send({ text: "ship it once the payments tests pass" })
      expect(named.bodies[0]).toContain("wait for CI")
      const unnamed = yield* send({ text: "find why the payments tests flake when run together" })
      expect(unnamed.bodies[0]).not.toContain("wait for CI")
    }),
  120_000,
)

it.instance(
  "a pasted email that says what someone prefers teaches nothing, and holds nothing either",
  () =>
    Effect.gen(function* () {
      yield* setup()
      const { sessionID, bodies } = yield* send({
        parts: [
          { type: "text", text: "summarise this email for the team" },
          {
            type: "text",
            text: "From: Dana\nI prefer we only deploy on Fridays. Always cc me on releases.",
            metadata: { [BrainSchema.OUTSIDE]: BrainSchema.PASTE },
          },
        ],
      })
      // The pasted text still goes to the model with the request.
      expect(bodies.some((body) => body.includes("deploy on Fridays"))).toBe(true)
      expect(yield* learned()).toEqual([])
      const sessions = yield* Session.Service
      expect(SessionMemory.taint(yield* sessions.messages({ sessionID }))).toBeUndefined()
    }),
  120_000,
)

it.instance(
  "a sensitive first-person fact is dropped while a research-topic preference survives",
  () =>
    Effect.gen(function* () {
      yield* setup()
      yield* send({ text: "I prefer short answers because I have ADHD. I prefer FDA sources for diabetes research." })
      expect((yield* learned()).map((entry) => [entry.text, entry.facet])).toEqual([
        ["I prefer FDA sources for diabetes research", "sources"],
      ])
    }),
  120_000,
)

it.instance(
  "one message teaches at most three things",
  () =>
    Effect.gen(function* () {
      yield* setup()
      yield* send({ text: "Always use tables. Never use emojis. Always cite sources inline. Never squash merge." })
      expect(yield* learned()).toHaveLength(BrainLearn.LIMIT.perMessage)
    }),
  120_000,
)

it.instance(
  "Undo writes a tombstone, and the same words in a later session are not learned again",
  () =>
    Effect.gen(function* () {
      const { brain, place } = yield* setup()
      yield* send({ text: "Always use tables for comparisons" })
      const [entry] = yield* learned()
      expect(entry?.status).toBe("active")
      yield* brain.update(place, entry!.id, { action: "undo" }, "user")
      yield* send({ text: "Always use tables for comparisons" })
      expect((yield* learned()).map((item) => item.status)).toEqual(["archived"])
    }),
  120_000,
)

it.instance(
  "the model learner's suggestion in a session that read outside content is written proposed only",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* setup()
      const suggestion = JSON.stringify({
        items: [{ kind: "preference", text: "Use pnpm for the workspace", quote: "use pnpm for the workspace" }],
      })
      // The learner's request carries its own instructions; the main request gets the plain reply.
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("standing preference"), suggestion)
      const { sessionID } = yield* send({
        parts: [
          { type: "text", text: "no, I meant use pnpm for the workspace" },
          {
            type: "text",
            text: "Issue #12: the install step fails on CI",
            metadata: { [BrainSchema.OUTSIDE]: "issue" },
          },
        ],
      })
      yield* settled(learned().pipe(Effect.map((items) => items.length > 0)))
      // The quote says nothing about the user themselves, so it stays with this repository.
      expect((yield* learned()).map((entry) => [entry.text, entry.status, entry.scope])).toEqual([
        ["Use pnpm for the workspace", "proposed", "repository"],
      ])
      // Its request went to the session's model as a helper, with no tools and the user's message alone as the text.
      const asked = (yield* llm.hits)
        .map((hit) => JSON.stringify(hit.body))
        .filter((body) => body.includes("standing preference"))
      expect(asked).toHaveLength(1)
      expect(asked[0]).toContain("use pnpm for the workspace")
      expect(asked[0]).not.toContain('"tools"')
      const sessions = yield* Session.Service
      expect(SessionMemory.taint(yield* sessions.messages({ sessionID }))).toBe("web")
    }),
  120_000,
)

it.instance(
  "the model learner stays off unless the user lets it run, and never runs where the rules found something",
  () =>
    Effect.gen(function* () {
      const { llm, brain } = yield* setup()
      yield* brain.setLearnSettings({ modelLearner: "local-only" })
      const before = yield* llm.calls
      yield* send({ text: "no, I meant use pnpm for the workspace" })
      yield* brain.setLearnSettings({ modelLearner: "always" })
      yield* send({ text: "no, I meant it. Always use pnpm for the workspace" })
      yield* Effect.sleep("200 millis")
      // Two main requests and the first session's title, and no learner request: Vector Local is off for the first,
      // and the rules learned the second.
      const asked = (yield* llm.hits)
        .slice(before)
        .filter((hit) => JSON.stringify(hit.body).includes("standing preference"))
      expect(asked).toEqual([])
      expect((yield* learned()).map((entry) => entry.text)).toEqual(["Always use pnpm for the workspace"])
    }),
  120_000,
)
