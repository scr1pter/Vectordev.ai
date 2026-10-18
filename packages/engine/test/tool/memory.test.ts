import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { Effect } from "effect"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import type { Tool } from "@/tool/tool"
import { MemoryTool } from "../../src/tool/memory"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(LayerNode.compile(LayerNode.group([ToolRegistry.node, CrossSpawnSpawner.node, Ripgrep.node])))

const model = { providerID: ProviderV2.ID.make("anthropic"), modelID: ModelV2.ID.make("claude-sonnet-4-20250514") }

let counter = 0
const id = (prefix: string) => `${prefix}_memory-${++counter}`

/** A user message saying `text`, and an assistant message whose tool calls ran, in that order. */
function history(input: {
  readonly sessionID: SessionID
  readonly said: string
  readonly tools?: ReadonlyArray<{ readonly tool: string; readonly input?: Record<string, unknown>; readonly exit?: number }>
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
          input: call.input ?? {},
          output: "",
          title: call.tool,
          metadata: call.exit === undefined ? {} : { exit: call.exit },
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
  return (params: Record<string, unknown>, messages: SessionV1.WithParts[], sessionID: SessionID) =>
    tool.execute(params, {
      sessionID,
      messageID: MessageID.make(id("msg")),
      callID: id("call"),
      agent: "build",
      abort: AbortSignal.any([]),
      messages,
      metadata: () => Effect.void,
      ask: () => Effect.void,
    } satisfies Tool.Context)
})

describe("tool.memory", () => {
  it.instance("the description and schema stay small, because every Work request carries them", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tool = (yield* registry.tools({
        providerID: ProviderV2.ID.openai,
        modelID: ModelV2.ID.make("gpt-5"),
        agent: { name: "build", mode: "primary" as const, permission: [], options: {} },
      })).find((item) => item.id === MemoryTool.id)
      expect(tool).toBeDefined()
      expect(Math.round((tool?.description.length ?? 0) / 4)).toBeLessThan(200)
    }),
  )

  it.instance("the user's own words make a memory active; words they never said leave a proposal", () =>
    Effect.gen(function* () {
      const run = yield* memory
      const sessionID = SessionID.make("ses_memory_words")
      const messages = history({ sessionID, said: "From now on we use pnpm for installs in this repository." })
      const said = yield* run(
        { action: "add", kind: "decision", text: "Installs use pnpm.", quote: "we use pnpm for installs" },
        messages,
        sessionID,
      )
      expect(said.metadata.result).toBe("added")
      const invented = yield* run(
        { action: "add", kind: "preference", text: "Prefers yarn workspaces.", quote: "I love yarn workspaces a lot" },
        messages,
        sessionID,
      )
      expect(invented.metadata.result).toBe("proposed")
      const found = yield* run({ action: "search", text: "which package manager installs" }, messages, sessionID)
      expect(found.output).toContain("Installs use pnpm.")
      expect(found.output).not.toContain("yarn")
    }),
  )

  it.instance("a check that failed and then passed is evidence for a lesson", () =>
    Effect.gen(function* () {
      const run = yield* memory
      const sessionID = SessionID.make("ses_memory_check")
      const messages = history({
        sessionID,
        said: "fix the failing engine tests",
        tools: [
          { tool: "bash", input: { command: "bun test test/session/prompt.test.ts" }, exit: 1 },
          { tool: "edit", input: {} },
          { tool: "bash", input: { command: "bun test --isolate test/session/prompt.test.ts" }, exit: 0 },
        ],
      })
      const passed = yield* run(
        {
          action: "add",
          kind: "lesson",
          text: "prompt.test.ts needs bun test --isolate because mock.module leaks between files.",
          command: "bun test --isolate test/session/prompt.test.ts",
        },
        messages,
        sessionID,
      )
      // Only ever passing proves nothing was learned.
      const never = yield* run(
        { action: "add", kind: "lesson", text: "Lint with bun run lint before committing.", command: "bun run lint" },
        history({ sessionID, said: "lint it", tools: [{ tool: "bash", input: { command: "bun run lint" }, exit: 0 }] }),
        sessionID,
      )
      expect(passed.metadata.result).toBe("added")
      expect(never.metadata.result).toBe("proposed")
    }),
  )

  it.instance("a memory learned after reading the web waits for the user", () =>
    Effect.gen(function* () {
      const run = yield* memory
      const sessionID = SessionID.make("ses_memory_web")
      const messages = history({
        sessionID,
        said: "read the docs page and set this up",
        tools: [{ tool: "webfetch", input: { url: "https://example.com" } }],
      })
      const result = yield* run(
        { action: "add", kind: "fact", text: "The service listens on port 4096.", quote: "read the docs page and set this up" },
        messages,
        sessionID,
      )
      expect(result.metadata.result).toBe("held")
      expect(result.metadata.hold).toBe("web")
      expect(result.output).toContain("not used until they approve it")
      const found = yield* run({ action: "search", text: "service port" }, messages, sessionID)
      expect(found.output).not.toContain("4096")
      // Nor may that session put memory away.
      const forget = yield* run({ action: "forget", id: "m00000" }, messages, sessionID)
      expect(forget.metadata.result).toBe("refused")
    }),
  )

  it.instance("a secret is never saved", () =>
    Effect.gen(function* () {
      const run = yield* memory
      const sessionID = SessionID.make("ses_memory_secret")
      const result = yield* run(
        { action: "add", kind: "fact", text: "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB" },
        history({ sessionID, said: "save the token" }),
        sessionID,
      )
      expect(result.metadata.result).toBe("refused")
      expect(result.output).toContain("never stores secrets")
    }),
  )

  it.instance("a file quote is checked against the file, and personal scope needs the user's words", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() => Bun.write(path.join(dir, "src", "auth.ts"), "export function verifyToken() {}\n"))
      const run = yield* memory
      const sessionID = SessionID.make("ses_memory_file")
      const messages = history({ sessionID, said: "where are tokens verified?" })
      const found = yield* run(
        {
          action: "add",
          kind: "fact",
          scope: "personal",
          text: "Tokens are verified in src/auth.ts.",
          file: "src/auth.ts",
          quote: "export function verifyToken",
        },
        messages,
        sessionID,
      )
      expect(found.metadata.result).toBe("added")
      const got = yield* run({ action: "get", id: found.metadata.id }, messages, sessionID)
      expect(got.output).toContain("src/auth.ts")
      expect(got.output).toContain("evidence")
      const missing = yield* run(
        { action: "add", kind: "fact", text: "Sessions are stored in src/session.ts.", file: "src/session.ts", quote: "sessions" },
        messages,
        sessionID,
      )
      expect(missing.metadata.result).toBe("proposed")
    }),
  )

  it.instance("the agent puts an entry away instead of deleting it, and cannot touch a person's rules", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* Effect.promise(() => Bun.write(path.join(dir, ".vector", "RULES.md"), "- Money is integer cents.\n"))
      const run = yield* memory
      const sessionID = SessionID.make("ses_memory_forget")
      const messages = history({ sessionID, said: "Remember: the staging database is reset every Monday morning." })
      const added = yield* run(
        {
          action: "add",
          kind: "fact",
          text: "The staging database is reset every Monday morning.",
          quote: "the staging database is reset every Monday morning",
        },
        messages,
        sessionID,
      )
      const forgot = yield* run({ action: "forget", id: added.metadata.id }, messages, sessionID)
      expect(forgot.output).toContain("Put away")
      const found = yield* run({ action: "search", text: "staging database reset" }, messages, sessionID)
      expect(found.output).not.toContain("Monday")
      const rules = yield* run({ action: "search", text: "money integer cents" }, messages, sessionID)
      const rule = /\[(f\w+)\]/.exec(rules.output)?.[1]
      expect(rule).toBeDefined()
      const changed = yield* run({ action: "update", id: rule, text: "Money is a float." }, messages, sessionID)
      expect(changed.metadata.result).toBe("refused")
    }),
  )
})
