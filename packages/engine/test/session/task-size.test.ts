import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { Global } from "@vectordevai/core/global"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Database } from "@vectordevai/core/database/database"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { MessageV2 } from "../../src/session/message-v2"
import type { SessionID } from "../../src/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

// What a request costs by its size, measured against a fake model server: how many requests it makes, which tools it
// offers and which reasoning effort it sends. No paid model is called.

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
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

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionPrompt.node,
      Session.node,
      Ripgrep.node,
      FSUtil.node,
      Database.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [MCP.node, mcp],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    ],
  ),
)

// A model that can reason or not, like the free North Mini Code: its efforts are "none" and "high".
const ref = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("north-mini-code") }

// A model whose provider caches the prompt prefix behind breakpoints, as Claude does.
const cached = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("claude-test") }

function providerConfig(url: string, extra: Partial<ConfigV1.Info> = {}): Partial<ConfigV1.Info> {
  return {
    formatter: false,
    lsp: false,
    provider: {
      lmstudio: {
        name: "Test",
        id: "lmstudio",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "north-mini-code": {
            id: "cohere/north-mini-code",
            name: "North Mini Code",
            attachment: false,
            reasoning: true,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
          "claude-test": {
            id: "claude-test",
            name: "Claude Test",
            attachment: false,
            reasoning: true,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: url },
      },
    },
    ...extra,
  }
}

const setup = Effect.fn("test.setup")(function* (extra: Partial<ConfigV1.Info> = {}) {
  const { directory } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  const file = path.join(directory, "vector.json")
  yield* fs.writeWithDirs(file, JSON.stringify(providerConfig(llm.url, extra)))
  const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(directory, [file]))
  yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
  return {
    directory,
    llm,
    fs,
    prompt: yield* SessionPrompt.Service,
    sessions: yield* Session.Service,
  }
})

const isTitle = (body: Record<string, unknown>) =>
  JSON.stringify(body).includes("Generate a title for this conversation")

function toolNames(body: Record<string, unknown> | undefined) {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  return tools
    .map((item) =>
      item && typeof item === "object" && "function" in item ? (item.function as { name: string }).name : "",
    )
    .toSorted()
}

function systemText(body: Record<string, unknown> | undefined) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  return messages
    .filter((message) => message && typeof message === "object" && "role" in message && message.role === "system")
    .map((message) => String((message as { content: unknown }).content))
    .join("\n")
}

const send = (prompt: SessionPrompt.Interface, sessionID: SessionID, text: string, extra = {}) =>
  prompt.prompt({ sessionID, agent: "build", model: ref, parts: [{ type: "text", text }], ...extra })

describe("task sizing", () => {
  it.instance(
    "hi is one direct request: no tools, no title request, no reasoning, no subagents or judge",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const chat = yield* sessions.create({})
        yield* llm.text("Hi! What would you like to work on?")

        // The judge is on, and a greeting still never brings it in.
        const result = yield* send(prompt, chat.id, "hi", { judge: "changes" })
        yield* prompt.awaitTitles()

        const bodies = yield* llm.inputs
        expect(bodies).toHaveLength(1)
        const [body] = bodies
        expect(toolNames(body)).toEqual([])
        expect(body?.reasoning_effort).toBe("none")
        // The quick lane: the newest message only, no repository context.
        const messages = ((body?.messages ?? []) as { role: string }[]).filter((message) => message.role !== "system")
        expect(messages).toHaveLength(1)
        expect(systemText(body)).not.toContain("<env>")
        expect(systemText(body)).not.toContain("subagent")
        expect(result.info.role === "assistant" && result.info.size).toBe("chat")
        // The first line is the title, with no model request for it.
        expect((yield* sessions.get(chat.id)).title).toBe("hi")
        expect((yield* sessions.children(chat.id)).length).toBe(0)
      }),
    { git: true },
  )

  it.instance(
    "greeting variants and questions about Vector take the same lane",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        for (const text of ["hii", "hey vector", "hello :)", "thanks!", "what can you do?"]) {
          const chat = yield* sessions.create({ title: "Pinned" })
          yield* llm.text("Hello!")
          yield* send(prompt, chat.id, text)
        }
        const bodies = yield* llm.inputs
        expect(bodies).toHaveLength(5)
        for (const body of bodies) expect(toolNames(body)).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "a light task is simply done with the basic tools: no subagents, to-do list or judge, low effort",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, fs, directory } = yield* setup()
        yield* fs.writeWithDirs(path.join(directory, "README.md"), "# Teh project\n")
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("read", { filePath: path.join(directory, "README.md") })
        yield* llm.text("The typo is in the heading; it should read 'The'.")

        const result = yield* send(prompt, chat.id, "fix the typo in README.md", { judge: "thorough" })

        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        expect(bodies).toHaveLength(2)
        const tools = toolNames(bodies[0])
        expect(tools).toEqual(expect.arrayContaining(["bash", "edit", "escalate", "glob", "grep", "read", "write"]))
        for (const absent of ["task", "task_manage", "todowrite", "question", "vector_cloud"])
          expect(tools).not.toContain(absent)
        // Light runs at the model's lowest effort; this model's lowest is "none".
        expect(bodies[0]?.reasoning_effort).toBe("none")
        expect(systemText(bodies[0])).not.toContain("<completion_policy>")
        expect(systemText(bodies[0])).toContain("No subagents are available")
        expect(JSON.stringify(bodies[0]?.messages)).toContain("Light request")
        expect(result.info.role === "assistant" && result.info.size).toBe("light")
        expect((yield* sessions.children(chat.id)).length).toBe(0)
      }),
    { git: true },
  )

  it.instance(
    "a complex task gets subagents, the to-do list and high effort",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("Here is the migration plan.")

        const result = yield* send(prompt, chat.id, "migrate the app to the new router across 40 files")

        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        expect(bodies).toHaveLength(1)
        const tools = toolNames(bodies[0])
        expect(tools).toEqual(expect.arrayContaining(["task", "task_manage", "todowrite", "question", "read", "edit"]))
        expect(tools).not.toContain("escalate")
        expect(bodies[0]?.reasoning_effort).toBe("high")
        expect(systemText(bodies[0])).toContain("<subagent_policy>")
        expect(systemText(bodies[0])).toContain("<completion_policy>")
        expect(result.info.role === "assistant" && result.info.size).toBe("thorough")
      }),
    { git: true },
  )

  it.instance(
    "a standard task gets the to-do list but no subagents, at the provider's default effort",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("Done.")
        yield* send(prompt, chat.id, "add OAuth login with tests")
        const [body] = (yield* llm.inputs).filter((item) => !isTitle(item))
        const tools = toolNames(body)
        expect(tools).toEqual(expect.arrayContaining(["todowrite", "question", "escalate"]))
        expect(tools).not.toContain("task")
        expect(body?.reasoning_effort).toBeUndefined()
      }),
    { git: true },
  )

  it.instance(
    "escalate raises a light request one step from the next step, once",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("escalate", { reason: "the rename touches every route" })
        yield* llm.tool("escalate", { reason: "and more" })
        yield* llm.text("Renamed.")

        yield* send(prompt, chat.id, "rename getUser to fetchUser")

        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        expect(bodies).toHaveLength(3)
        expect(toolNames(bodies[0])).not.toContain("todowrite")
        // Standard from the next step: the to-do list, still no subagents.
        expect(toolNames(bodies[1])).toEqual(expect.arrayContaining(["todowrite", "question", "escalate"]))
        expect(toolNames(bodies[1])).not.toContain("task")
        // A second raise in the same request is refused, so a light task never reaches subagents on its own.
        expect(toolNames(bodies[2])).not.toContain("task")
        const messages = yield* MessageV2.filterCompactedEffect(chat.id)
        const outputs = messages.flatMap((message) =>
          message.parts.flatMap((part) =>
            part.type === "tool" && part.tool === "escalate" && part.state.status === "completed"
              ? [part.state.output]
              : [],
          ),
        )
        expect(outputs[0]).toContain("now Standard")
        expect(outputs[1]).toContain("Already raised")
      }),
    { git: true },
  )

  it.instance(
    "a yes to the agent's question continues the request it answers",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("I can publish a preview. Shall I deploy?")
        yield* send(prompt, chat.id, "ship to vercel")
        yield* llm.text("Published.")
        yield* send(prompt, chat.id, "yes")
        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        expect(bodies).toHaveLength(2)
        // Not the history-free quick lane: the answer goes on with the light request's tools and history.
        expect(toolNames(bodies[1])).toContain("read")
        expect(JSON.stringify(bodies[1]?.messages)).toContain("ship to vercel")
      }),
    { git: true },
  )

  it.instance(
    "Vector runs the judge itself after a thorough run that changed files",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup()
        const chat = yield* sessions.create({ title: "Pinned" })
        const target = path.join(directory, "router.ts")
        yield* llm.tool("write", { filePath: target, content: "export const router = 1\n" })
        yield* llm.text("Migrated the router.")
        // The judge subagent's own request.
        yield* llm.push(
          reply().text("Checked the diff.\n\nVERDICT: PASS\nSCORES: requirement 4/4, correctness 4/4").stop(),
        )

        yield* send(prompt, chat.id, "be thorough: migrate the app to the new router", { judge: "thorough" })

        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        // Two requests for the work and one for the judge; no request asks the model to launch a judge.
        expect(bodies).toHaveLength(3)
        expect(systemText(bodies[2])).toContain("independent completion judge")
        for (const body of bodies.slice(0, 2))
          expect(JSON.stringify(body?.messages)).not.toContain("<vector_verified_completion>")
        const messages = yield* MessageV2.filterCompactedEffect(chat.id)
        const judged = messages.flatMap((message) =>
          message.parts.flatMap((part) => (part.type === "tool" && part.metadata?.judge ? [part] : [])),
        )
        expect(judged).toHaveLength(1)
        expect(judged[0]?.metadata?.judge).toEqual({ round: 1, verdict: "PASS" })
      }),
    { git: true },
  )

  it.instance(
    "a judge FAIL goes back for repair, and the judge looks again",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup()
        const chat = yield* sessions.create({ title: "Pinned" })
        const target = path.join(directory, "router.ts")
        yield* llm.tool("write", { filePath: target, content: "export const router = 1\n" })
        yield* llm.text("Migrated the router.")
        yield* llm.text("VERDICT: FAIL\nBLOCKERS:\n- router.ts exports a number")
        yield* llm.tool("write", { filePath: target, content: "export const router = () => {}\n" })
        yield* llm.text("Repaired the export.")
        yield* llm.text("VERDICT: PASS")

        yield* send(prompt, chat.id, "be thorough: migrate the app to the new router", { judge: "thorough" })

        const messages = yield* MessageV2.filterCompactedEffect(chat.id)
        const verdicts = messages.flatMap((message) =>
          message.parts.flatMap((part) => (part.type === "tool" && part.metadata?.judge ? [part.metadata.judge] : [])),
        )
        expect(verdicts).toEqual([
          { round: 1, verdict: "FAIL" },
          { round: 2, verdict: "PASS" },
        ])
        expect((yield* llm.inputs).filter((body) => !isTitle(body))).toHaveLength(6)
      }),
    { git: true },
  )

  it.instance(
    "the judge setting never judges a light task, and judges every change in its 'changes' mode",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup()
        const first = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("write", { filePath: path.join(directory, "a.txt"), content: "a\n" })
        yield* llm.text("Wrote a.txt.")
        yield* send(prompt, first.id, "write a.txt", { judge: "thorough" })
        expect((yield* sessions.children(first.id)).length).toBe(0)

        const second = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("write", { filePath: path.join(directory, "b.txt"), content: "b\n" })
        yield* llm.text("Wrote b.txt.")
        yield* llm.text("VERDICT: PASS")
        yield* send(prompt, second.id, "write b.txt", { judge: "changes" })
        expect((yield* sessions.children(second.id)).length).toBe(1)
      }),
    { git: true },
  )

  it.instance(
    "an older client's hidden judge policy turns the judge on and never reaches the model",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup()
        const policy = "<vector_verified_completion>LLM-as-a-judge is enabled. Then delegate to the judge subagent."
        const legacy = (text: string) => [
          { type: "text" as const, text },
          { type: "text" as const, text: policy, synthetic: true },
        ]
        const greeting = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("Hello!")
        yield* prompt.prompt({ sessionID: greeting.id, agent: "build", model: ref, parts: legacy("hi") })
        const [hello] = yield* llm.inputs
        expect(toolNames(hello)).toEqual([])
        expect(JSON.stringify(hello)).not.toContain("vector_verified_completion")

        const work = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export {}\n" })
        yield* llm.text("Migrated.")
        yield* llm.text("VERDICT: PASS")
        yield* prompt.prompt({
          sessionID: work.id,
          agent: "build",
          model: ref,
          parts: legacy("migrate the app to the new router across 40 files"),
        })
        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        for (const body of bodies) expect(JSON.stringify(body)).not.toContain("delegate to the judge subagent")
        expect((yield* sessions.children(work.id)).length).toBe(1)
      }),
    { git: true },
  )

  it.instance(
    "on a caching provider a light follow-up keeps the cached tools, but cannot launch a subagent",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("Plan ready.")
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: cached,
          parts: [{ type: "text", text: "migrate the app to the new router across 40 files" }],
        })
        yield* llm.tool("task", { description: "fix it", prompt: "fix the typo", subagent_type: "general" })
        yield* llm.text("Fixed it myself.")
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: cached,
          parts: [{ type: "text", text: "fix the typo in README.md" }],
        })
        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        expect(bodies).toHaveLength(3)
        // The same tool definitions as the cached prefix, so the provider reads it instead of writing a new one.
        expect(toolNames(bodies[1])).toEqual(toolNames(bodies[0]))
        expect((yield* sessions.children(chat.id)).length).toBe(0)
        const messages = yield* MessageV2.filterCompactedEffect(chat.id)
        const refused = messages.flatMap((message) =>
          message.parts.flatMap((part) =>
            part.type === "tool" && part.tool === "task" && part.state.status === "error" ? [part.state.error] : [],
          ),
        )
        expect(refused[0]).toContain("Subagents are not offered for this request")
      }),
    { git: true },
  )

  it.instance(
    "the off switch gives every request the full harness",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup({ sizing: { auto: false } })
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("Hello.")
        yield* send(prompt, chat.id, "hi")
        const [body] = (yield* llm.inputs).filter((item) => !isTitle(item))
        expect(toolNames(body)).toContain("task")
      }),
    { git: true },
  )

  it.instance(
    "the sender's size wins",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("Hello.")
        yield* send(prompt, chat.id, "hi", { size: "thorough" })
        const [body] = (yield* llm.inputs).filter((item) => !isTitle(item))
        expect(toolNames(body)).toContain("task")
      }),
    { git: true },
  )
})
