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
import { Effect, Fiber, Layer } from "effect"
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

// North Mini Code with a small context, so one large step compacts the history.
const small = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("tiny-context") }

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
          "tiny-context": {
            id: "tiny-context",
            name: "Tiny Context",
            attachment: false,
            reasoning: true,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 20_000, output: 2_000 },
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

const conversation = (body: Record<string, unknown> | undefined) =>
  ((body?.messages ?? []) as { role: string }[]).filter((message) => message.role !== "system")

// The judge's own request: the subagent's system prompt names it.
const isJudge = (body: Record<string, unknown>) => systemText(body).includes("independent completion judge")

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
        // escalate can be called again, so the note no longer says to call it once.
        expect(JSON.stringify(body?.messages)).toContain("call escalate with your reason")
        expect(JSON.stringify(body?.messages)).not.toContain("escalate once")
      }),
    { git: true },
  )

  it.instance(
    "questions about the code, reviews and debugging start at standard, at the provider's own effort",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const asks = [
          "what does the classify function in task-size.ts do?",
          "review this codebase for security issues",
          "make the tests pass",
          "getting a 500 on /api/login",
        ]
        for (const text of asks) {
          const chat = yield* sessions.create({ title: "Pinned" })
          yield* llm.text("Here is what I found.")
          const result = yield* send(prompt, chat.id, text)
          expect(result.info.role === "assistant" && result.info.size, text).toBe("standard")
        }
        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        expect(bodies).toHaveLength(asks.length)
        for (const body of bodies) {
          expect(toolNames(body)).toEqual(expect.arrayContaining(["todowrite", "question", "escalate", "read"]))
          expect(toolNames(body)).not.toContain("task")
          // Neither reasoning off nor low.
          expect(body?.reasoning_effort).toBeUndefined()
        }
      }),
    { git: true },
  )

  it.instance(
    "a mention of subagents or the judge is not an ask for them",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        for (const text of ["fix the bug with subagents not starting", "llm as a judge launches on hi, fix it"]) {
          const chat = yield* sessions.create({ title: "Pinned" })
          yield* llm.tool("write", { filePath: path.join(directory, "fix.ts"), content: "export {}\n" })
          yield* llm.text("Fixed.")
          const result = yield* send(prompt, chat.id, text)
          expect(result.info.role === "assistant" && result.info.size, text).toBe("standard")
          expect((yield* sessions.children(chat.id)).length, text).toBe(0)
        }
        for (const body of (yield* llm.inputs).filter((body) => !isTitle(body))) {
          expect(toolNames(body)).not.toContain("task")
          expect(body?.reasoning_effort).toBeUndefined()
        }
      }),
    { git: true },
  )

  it.instance(
    "telling Vector to run the judge runs it, even with the setting off",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup()
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export {}\n" })
        yield* llm.text("Migrated the router.")
        yield* llm.text("VERDICT: PASS")
        yield* send(prompt, chat.id, "migrate the router, then run the judge")
        expect((yield* llm.inputs).filter(isJudge)).toHaveLength(1)
        expect((yield* sessions.children(chat.id)).length).toBe(1)
      }),
    { git: true },
  )

  it.instance(
    "escalate raises a light request from the next step, and a second raise reaches subagents",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("escalate", { reason: "the rename touches every route" })
        yield* llm.tool("escalate", { reason: "every package has its own copy" })
        yield* llm.text("Renamed.")

        yield* send(prompt, chat.id, "rename getUser to fetchUser")

        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        expect(bodies).toHaveLength(3)
        expect(toolNames(bodies[0])).not.toContain("todowrite")
        // Standard from the next step: the to-do list, still no subagents.
        expect(toolNames(bodies[1])).toEqual(expect.arrayContaining(["todowrite", "question", "escalate"]))
        expect(toolNames(bodies[1])).not.toContain("task")
        // A misjudged light task can still reach subagents through a second raise.
        expect(toolNames(bodies[2])).toEqual(expect.arrayContaining(["task", "task_manage", "todowrite"]))
        expect(bodies[2]?.reasoning_effort).toBe("high")
        const messages = yield* MessageV2.filterCompactedEffect(chat.id)
        const outputs = messages.flatMap((message) =>
          message.parts.flatMap((part) =>
            part.type === "tool" && part.tool === "escalate" && part.state.status === "completed"
              ? [part.state.output]
              : [],
          ),
        )
        expect(outputs[0]).toContain("now Standard")
        expect(outputs[1]).toContain("now Thorough")
        // The Light note stays as it was for the cache, and the result says it no longer applies.
        expect(outputs[1]).toContain("replaces the size note")
      }),
    { git: true },
  )

  it.instance(
    "escalate with to: thorough takes a light request to subagents in one call, and never lowers a size",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("escalate", { reason: "this spans the whole backend", to: "thorough" })
        yield* llm.text("Planned.")
        yield* send(prompt, chat.id, "rename getUser to fetchUser")
        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        expect(bodies).toHaveLength(2)
        expect(toolNames(bodies[1])).toEqual(expect.arrayContaining(["task", "task_manage"]))

        const standard = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("escalate", { reason: "needs a list", to: "standard" })
        yield* llm.text("Added.")
        yield* send(prompt, standard.id, "add OAuth login with tests")
        const messages = yield* MessageV2.filterCompactedEffect(standard.id)
        const output = messages.flatMap((message) =>
          message.parts.flatMap((part) =>
            part.type === "tool" && part.tool === "escalate" && part.state.status === "completed"
              ? [part.state.output]
              : [],
          ),
        )[0]
        expect(output).toContain("already Standard")
      }),
    { git: true },
  )

  it.instance(
    "a rewrite of a whole system is thorough: the to-do list, subagents and high effort",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        for (const text of ["rewrite the entire backend in Rust", "port the TUI to the new renderer"]) {
          const chat = yield* sessions.create({ title: "Pinned" })
          yield* llm.text("Here is the plan.")
          const result = yield* send(prompt, chat.id, text)
          expect(result.info.role === "assistant" && result.info.size, text).toBe("thorough")
        }
        for (const body of (yield* llm.inputs).filter((item) => !isTitle(item))) {
          expect(toolNames(body)).toEqual(expect.arrayContaining(["todowrite", "question", "task", "task_manage"]))
          expect(body?.reasoning_effort).toBe("high")
          expect(systemText(body)).toContain("<completion_policy>")
        }
      }),
    { git: true },
  )

  it.instance(
    "a question about a hard failure runs at the provider's own effort, with the to-do list",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("The two drains share one lock.")
        yield* send(prompt, chat.id, "why does the session runner deadlock when two prompts arrive at once?")
        const [body] = (yield* llm.inputs).filter((item) => !isTitle(item))
        expect(toolNames(body)).toEqual(expect.arrayContaining(["todowrite", "question", "read"]))
        expect(toolNames(body)).not.toContain("task")
        // Neither reasoning off nor low: the provider's default.
        expect(body?.reasoning_effort).toBeUndefined()
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
    "a sure to an offer without a question mark continues the work with its tools and history",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("Migrated the router. I can also add tests for this if you want.")
        yield* send(prompt, chat.id, "migrate the app to the new router across 40 files")
        yield* llm.text("Added the tests.")
        yield* send(prompt, chat.id, "sure")
        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        expect(bodies).toHaveLength(2)
        expect(toolNames(bodies[1])).toEqual(expect.arrayContaining(["read", "todowrite", "task"]))
        expect(JSON.stringify(bodies[1]?.messages)).toContain("new router across 40 files")
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
        expect(judged[0]?.metadata?.judge).toEqual({ round: 1, size: "thorough", verdict: "PASS" })
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
          { round: 1, size: "thorough", verdict: "FAIL" },
          { round: 2, size: "thorough", verdict: "PASS" },
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
    "a thorough judged run that compacts is still judged, and a continue afterwards keeps tools and history",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        const chat = yield* sessions.create({ title: "Pinned" })
        // The write step fills the small context, so Vector compacts before the next step.
        yield* llm.push(
          reply()
            .tool("write", { filePath: path.join(directory, "router.ts"), content: "export {}\n" })
            .usage({ input: 19_000, output: 100 }),
        )
        yield* llm.text("Summary of the work so far.")
        yield* llm.text("Migrated the router.")
        yield* llm.text("VERDICT: PASS")
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: small,
          parts: [{ type: "text", text: "migrate the app to the new router across 40 files" }],
        })

        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        expect(bodies).toHaveLength(4)
        // After the summary the request is still Thorough: its tools, its effort and its note.
        expect(toolNames(bodies[2])).toEqual(expect.arrayContaining(["task", "todowrite"]))
        expect(bodies[2]?.reasoning_effort).toBe("high")
        expect(JSON.stringify(bodies[2]?.messages)).toContain("Thorough request")
        // And it is judged, on the user's own words and the file the summarised step wrote.
        expect(isJudge(bodies[3]!)).toBe(true)
        expect(JSON.stringify(bodies[3]?.messages)).toContain("new router across 40 files")
        expect(JSON.stringify(bodies[3]?.messages)).toContain("router.ts")
        expect((yield* sessions.children(chat.id)).length).toBe(1)

        yield* llm.text("All routes are migrated.")
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: small,
          parts: [{ type: "text", text: "continue" }],
        })
        const after = (yield* llm.inputs).filter((body) => !isTitle(body)).at(-1)
        // Not the quick lane: the work's tools and the history, summary included.
        expect(toolNames(after)).toEqual(expect.arrayContaining(["read", "task"]))
        expect(conversation(after).length).toBeGreaterThan(1)
        expect(JSON.stringify(after?.messages)).toContain("Summary of the work so far.")
      }),
    { git: true },
  )

  it.instance(
    "a message sent during a thorough run's final step does not leave the thorough work unjudged",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        const chat = yield* sessions.create({ title: "Pinned" })
        const { promise: gate, resolve: release } = Promise.withResolvers<void>()
        yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export {}\n" })
        yield* llm.hold("Migrated the router.", gate)
        yield* llm.text("Fixed the typo.")
        yield* llm.text("VERDICT: PASS")

        const first = yield* send(prompt, chat.id, "migrate the app to the new router across 40 files").pipe(
          Effect.forkChild,
        )
        yield* llm.wait(2)
        const second = yield* send(prompt, chat.id, "also fix the typo in README").pipe(Effect.forkChild)
        yield* Effect.sleep("300 millis")
        release()
        yield* Fiber.join(first)
        yield* Fiber.join(second)

        const judged = (yield* llm.inputs).filter(isJudge)
        expect(judged).toHaveLength(1)
        expect(JSON.stringify(judged[0]?.messages)).toContain("new router across 40 files")
        expect(JSON.stringify(judged[0]?.messages)).toContain("router.ts")
        expect((yield* sessions.children(chat.id)).length).toBe(1)
      }),
    { git: true },
  )

  it.instance(
    "the judge waits while the agent asks the user something, and a yes takes the work to the judge",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export {}\n" })
        yield* llm.text("Migrated 30 routes. Should I also migrate the tests?")
        yield* send(prompt, chat.id, "migrate the app to the new router across 40 files")
        // No judge, and no repair that would carry on without the user's answer.
        expect((yield* sessions.children(chat.id)).length).toBe(0)
        expect((yield* llm.inputs).filter((body) => !isTitle(body))).toHaveLength(2)

        yield* llm.tool("write", { filePath: path.join(directory, "router.test.ts"), content: "test()\n" })
        yield* llm.text("Migrated the tests.")
        yield* llm.text("VERDICT: PASS")
        yield* send(prompt, chat.id, "yes")
        const judged = (yield* llm.inputs).filter(isJudge)
        expect(judged).toHaveLength(1)
        expect(JSON.stringify(judged[0]?.messages)).toContain("router.ts")
        expect(JSON.stringify(judged[0]?.messages)).toContain("router.test.ts")
      }),
    { git: true },
  )

  it.instance(
    "a thorough plan that asks a question keeps its size, subagents and judge when the user answers in a sentence",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        const answers = ["yes, start with phase 1", "proceed with all phases", "option 2", "continue where you left off"]
        for (const answer of answers) {
          const chat = yield* sessions.create({ title: "Pinned" })
          yield* llm.text("Here is the plan in three phases. Should I start with phase 1?")
          yield* send(prompt, chat.id, "migrate the app to the new router across 40 files")
          const before = (yield* llm.inputs).length
          yield* llm.tool("write", { filePath: path.join(directory, "r.ts"), content: "export {}\n" })
          yield* llm.text("Phase 1 is done.")
          yield* llm.text("VERDICT: PASS")
          const result = yield* send(prompt, chat.id, answer)
          const bodies = (yield* llm.inputs).slice(before).filter((body) => !isTitle(body))
          // The implementation runs with the plan's harness: subagents, the to-do list and high effort.
          expect(toolNames(bodies[0]), answer).toEqual(expect.arrayContaining(["task", "task_manage", "todowrite"]))
          expect(bodies[0]?.reasoning_effort, answer).toBe("high")
          expect(JSON.stringify(bodies[0]?.messages), answer).toContain("new router across 40 files")
          expect(result.info.role === "assistant" && result.info.size, answer).toBe("thorough")
          // And the judge checks it.
          const judged = bodies.filter(isJudge)
          expect(judged, answer).toHaveLength(1)
          expect(JSON.stringify(judged[0]?.messages), answer).toContain("r.ts")
          expect((yield* sessions.children(chat.id)).length, answer).toBe(1)
        }
      }),
    { git: true },
  )

  it.instance(
    "a judged large task that ended with an offer is judged once the user declines it or says thanks",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        const offer = "Migrated all 40 routes and the tests pass. Want me to also update the docs?"

        // A plain decline leaves nothing to do, so it is a direct reply on the quick lane, and the judge follows. The
        // judge reads the offer and the decline, and the work's own report.
        const declined = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export {}\n" })
        yield* llm.text(offer)
        yield* send(prompt, declined.id, "migrate the app to the new router across 40 files")
        expect((yield* sessions.children(declined.id)).length).toBe(0)
        const start = (yield* llm.inputs).length
        yield* llm.text("Okay, I will leave the docs.")
        yield* llm.text("VERDICT: PASS")
        yield* send(prompt, declined.id, "no thanks")
        const replies = (yield* llm.inputs).slice(start).filter((body) => !isTitle(body))
        expect(replies).toHaveLength(2)
        expect(toolNames(replies[0])).toEqual([])
        expect(replies[0]?.reasoning_effort).toBe("none")
        expect(conversation(replies[0])).toHaveLength(1)
        expect(isJudge(replies[1]!)).toBe(true)
        const declinedBrief = JSON.stringify(replies[1]?.messages)
        expect(declinedBrief).toContain("Want me to also update the docs?")
        expect(declinedBrief).toContain("no thanks")
        expect(declinedBrief).toContain("out of scope")
        expect(declinedBrief).toContain("Migrated all 40 routes and the tests pass")
        expect((yield* sessions.children(declined.id)).length).toBe(1)

        // A thanks is a direct reply, and the judge still checks the work it thanks for. A FAIL is repaired with the
        // work's own tools, not the quick lane's.
        const thanked = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export const a = 1\n" })
        yield* llm.text(offer)
        yield* send(prompt, thanked.id, "migrate the app to the new router across 40 files")
        const before = (yield* llm.inputs).length
        yield* llm.text("You're welcome!")
        yield* llm.text("VERDICT: FAIL\nBLOCKERS:\n- router.ts exports a number")
        yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export const a = () => {}\n" })
        yield* llm.text("Repaired the export.")
        yield* llm.text("VERDICT: PASS")
        yield* send(prompt, thanked.id, "thanks")
        const bodies = (yield* llm.inputs).slice(before).filter((body) => !isTitle(body))
        expect(toolNames(bodies[0])).toEqual([])
        expect(bodies[0]?.reasoning_effort).toBe("none")
        expect(isJudge(bodies[1]!)).toBe(true)
        expect(JSON.stringify(bodies[1]?.messages)).toContain("new router across 40 files")
        expect(JSON.stringify(bodies[1]?.messages)).toContain("router.ts")
        expect(toolNames(bodies[2])).toEqual(expect.arrayContaining(["write", "task", "todowrite"]))
        expect(bodies[2]?.reasoning_effort).toBe("high")
        expect(bodies.filter(isJudge)).toHaveLength(2)
        expect((yield* sessions.children(thanked.id)).length).toBe(2)
      }),
    { git: true },
  )

  it.instance(
    "a thanks the app sends on the quick lane after a judged large task's offer still brings in the judge",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export const a = 1\n" })
        yield* llm.text("Migrated all 40 routes and the tests pass. Want me to also update the docs?")
        yield* send(prompt, chat.id, "migrate the app to the new router across 40 files")
        expect((yield* sessions.children(chat.id)).length).toBe(0)
        const before = (yield* llm.inputs).length
        yield* llm.text("You're welcome!")
        yield* llm.text("VERDICT: FAIL\nBLOCKERS:\n- router.ts exports a number")
        yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export const a = () => {}\n" })
        yield* llm.text("Repaired the export.")
        yield* llm.text("VERDICT: PASS")
        // The desktop app sends a thanks with the quick agent.
        yield* send(prompt, chat.id, "thanks", { agent: "quick" })
        const bodies = (yield* llm.inputs).slice(before).filter((body) => !isTitle(body))
        expect(toolNames(bodies[0])).toEqual([])
        expect(isJudge(bodies[1]!)).toBe(true)
        // The judge checks the work's own report, not the quick lane's "You're welcome!".
        expect(JSON.stringify(bodies[1]?.messages)).toContain("Migrated all 40 routes")
        expect(JSON.stringify(bodies[1]?.messages)).not.toContain("You're welcome!")
        // A FAIL is repaired on the build agent with the work's tools, then judged again.
        expect(toolNames(bodies[2])).toEqual(expect.arrayContaining(["write", "task", "todowrite"]))
        expect(bodies[2]?.reasoning_effort).toBe("high")
        expect(bodies.filter(isJudge)).toHaveLength(2)
        expect((yield* sessions.children(chat.id)).length).toBe(2)
        // A quick-lane greeting afterwards has nothing to judge.
        yield* llm.text("Hi!")
        yield* send(prompt, chat.id, "hi", { agent: "quick" })
        expect((yield* sessions.children(chat.id)).length).toBe(2)
      }),
    { git: true },
  )

  it.instance(
    "after a real question a no is answered inside the work, and the judge is told the user's answer",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export {}\n" })
        yield* llm.text("Migrated 20 of 40 routes to the new router. Should I convert them to the new loader API?")
        yield* send(prompt, chat.id, "migrate the app to the new router across 40 files")
        // Not judged while it waits on the answer.
        expect((yield* sessions.children(chat.id)).length).toBe(0)
        const before = (yield* llm.inputs).length
        yield* llm.text("Understood: the routes keep the current loader API.")
        yield* llm.text("VERDICT: PASS")
        yield* send(prompt, chat.id, "no")
        const bodies = (yield* llm.inputs).slice(before).filter((body) => !isTitle(body))
        // The answer runs with the work's harness, since the work goes on without the loader API.
        expect(toolNames(bodies[0])).toEqual(expect.arrayContaining(["task", "todowrite"]))
        expect(isJudge(bodies[1]!)).toBe(true)
        // The judge reads the question, the user's "no" and that declined work is out of scope, so it does not send
        // the loader API back as a repair.
        const brief = JSON.stringify(bodies[1]?.messages)
        expect(brief).toContain("Should I convert them to the new loader API?")
        expect(brief).toContain("<user>\\nno\\n</user>")
        expect(brief).toContain("Work they declined, or that the agent only offered, is out of scope")
        expect((yield* sessions.children(chat.id)).length).toBe(1)
      }),
    { git: true },
  )

  it.instance(
    "a thorough plan that asked nothing is carried out at its size when the user says build it, and judged",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        for (const answer of ["build it", "implement the plan", "looks good, build it", "go with option b"]) {
          const chat = yield* sessions.create({ title: "Pinned" })
          yield* llm.text("Here is the plan in three phases: the renderer, the input layer, then the views.")
          yield* send(prompt, chat.id, "plan how to port the TUI to Rust")
          const before = (yield* llm.inputs).length
          yield* llm.tool("write", { filePath: path.join(directory, "tui.rs"), content: "fn main() {}\n" })
          yield* llm.text("Ported the renderer.")
          yield* llm.text("VERDICT: PASS")
          const result = yield* send(prompt, chat.id, answer)
          const bodies = (yield* llm.inputs).slice(before).filter((body) => !isTitle(body))
          expect(toolNames(bodies[0]), answer).toEqual(expect.arrayContaining(["task", "task_manage", "todowrite"]))
          expect(bodies[0]?.reasoning_effort, answer).toBe("high")
          expect(result.info.role === "assistant" && result.info.size, answer).toBe("thorough")
          const judged = bodies.filter(isJudge)
          expect(judged, answer).toHaveLength(1)
          expect(JSON.stringify(judged[0]?.messages), answer).toContain("port the TUI to Rust")
          expect((yield* sessions.children(chat.id)).length, answer).toBe(1)
        }
      }),
    { git: true },
  )

  it.instance(
    "building something new or deploying new infrastructure is standard, not light",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const asks = ["build this app with next.js", "build it in rust", "deploy a new microservice for billing"]
        for (const text of asks) {
          const chat = yield* sessions.create({ title: "Pinned" })
          yield* llm.text("Done.")
          const result = yield* send(prompt, chat.id, text)
          expect(result.info.role === "assistant" && result.info.size, text).toBe("standard")
        }
        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        expect(bodies).toHaveLength(asks.length)
        for (const [index, body] of bodies.entries()) {
          expect(toolNames(body), asks[index]).toEqual(expect.arrayContaining(["todowrite", "question", "escalate"]))
          expect(body?.reasoning_effort, asks[index]).toBeUndefined()
        }
      }),
    { git: true },
  )

  it.instance(
    "a thanks with a few more words and a question about Vector are one direct request",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const texts = ["thanks for the help", "what is vector?", "thanks, that worked!", "hello again", "who made vector?"]
        for (const text of texts) {
          const chat = yield* sessions.create({ title: "Pinned" })
          yield* llm.text("Glad to help!")
          yield* send(prompt, chat.id, text)
        }
        const bodies = yield* llm.inputs
        expect(bodies).toHaveLength(texts.length)
        for (const [index, body] of bodies.entries()) {
          expect(toolNames(body), texts[index]).toEqual([])
          expect(body?.reasoning_effort, texts[index]).toBe("none")
          expect(conversation(body), texts[index]).toHaveLength(1)
        }
      }),
    { git: true },
  )

  it.instance(
    "a yes to a greeting reply's offer gets the history and the work's tools",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const chat = yield* sessions.create({})
        yield* llm.text("Hi! Should I take a look at the failing tests in this repository?")
        yield* send(prompt, chat.id, "hi")
        yield* llm.text("Looking at them now.")
        yield* send(prompt, chat.id, "yes")
        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        expect(bodies).toHaveLength(2)
        expect(toolNames(bodies[0])).toEqual([])
        expect(toolNames(bodies[1])).toEqual(expect.arrayContaining(["read", "todowrite", "question"]))
        expect(conversation(bodies[1]).length).toBeGreaterThan(1)
        expect(JSON.stringify(bodies[1]?.messages)).toContain("failing tests in this repository")
      }),
    { git: true },
  )

  it.instance(
    "/init runs at standard: the to-do list and questions, no subagents, the provider's own effort",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("Wrote AGENTS.md.")
        const result = yield* prompt.command({
          sessionID: chat.id,
          command: "init",
          arguments: "",
          model: "lmstudio/north-mini-code",
        })
        const [body] = (yield* llm.inputs).filter((item) => !isTitle(item))
        expect(toolNames(body)).toEqual(expect.arrayContaining(["todowrite", "question"]))
        expect(toolNames(body)).not.toContain("task")
        expect(body?.reasoning_effort).toBeUndefined()
        expect(result.info.role === "assistant" && result.info.size).toBe("standard")
      }),
    { git: true },
  )

  it.instance(
    "a command is sized from what its template asks for",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup({
          command: {
            tidy: { template: "fix the typo in README.md" },
            port: { template: "port the app to Svelte" },
            careful: { template: "Be thorough and use subagents. Explain $ARGUMENTS" },
          },
        })
        const tidy = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("Fixed.")
        yield* prompt.command({ sessionID: tidy.id, command: "tidy", arguments: "", model: "lmstudio/north-mini-code" })
        const port = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("Ported.")
        yield* prompt.command({ sessionID: port.id, command: "port", arguments: "", model: "lmstudio/north-mini-code" })
        // A template's force words are its author's text, not the user's ask; the user's own arguments are.
        const careful = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("Explained.")
        yield* prompt.command({
          sessionID: careful.id,
          command: "careful",
          arguments: "the parser",
          model: "lmstudio/north-mini-code",
        })
        const asked = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("Fixed.")
        yield* prompt.command({
          sessionID: asked.id,
          command: "tidy",
          arguments: "be thorough",
          model: "lmstudio/north-mini-code",
        })
        const [light, large, template, argument] = (yield* llm.inputs).filter((body) => !isTitle(body))
        expect(toolNames(light)).not.toContain("todowrite")
        expect(light?.reasoning_effort).toBe("none")
        expect(toolNames(large)).toEqual(expect.arrayContaining(["task", "todowrite"]))
        expect(large?.reasoning_effort).toBe("high")
        expect(toolNames(template)).not.toContain("task")
        expect(template?.reasoning_effort).toBeUndefined()
        expect(toolNames(argument)).toEqual(expect.arrayContaining(["task", "todowrite"]))
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
