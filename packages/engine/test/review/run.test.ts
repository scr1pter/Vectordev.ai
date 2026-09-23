import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { FSUtil } from "@vectordevai/core/fs-util"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { parseUnifiedDiff } from "@vectordevai/core/review/diff"
import { noteVerifySkipped } from "@vectordevai/core/review/format"
import {
  DEFAULT_REVIEW_CONFIG,
  type ModelFinding,
  type ReviewConfig,
  type ReviewCost,
} from "@vectordevai/core/review/types"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "@/provider/provider"
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
import { Review } from "../../src/review/run"
import { SessionID } from "../../src/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpError, reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

// Review.run against the fake LLM. Requests are matched by the prompt they answer, since the review and security
// sessions run in parallel.

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
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    remove: () => Effect.void,
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in review tests"),
    authenticate: () => Effect.die("unexpected MCP auth in review tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in review tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
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
  Agent.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  Provider.node,
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
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])

const it = testEffect(
  LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

const TIMEOUT = 30_000
const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const PRICE = { input: 10, output: 10 } // USD per million tokens

const LIST_SOURCE = "export function last(items: number[]) {\n  const index = items.length\n  return items[index]\n}\n"
const LIST = parseUnifiedDiff(
  [
    "diff --git a/src/list.ts b/src/list.ts",
    "--- a/src/list.ts",
    "+++ b/src/list.ts",
    "@@ -1,3 +1,4 @@",
    " export function last(items: number[]) {",
    "-  return items[items.length - 1]",
    "+  const index = items.length",
    "+  return items[index]",
    " }",
  ].join("\n"),
)
const AUTH = parseUnifiedDiff(
  [
    "diff --git a/src/auth/session.ts b/src/auth/session.ts",
    "--- a/src/auth/session.ts",
    "+++ b/src/auth/session.ts",
    "@@ -1,3 +1,3 @@",
    " export function token(input: string) {",
    "-  return verify(input)",
    "+  return input",
    " }",
  ].join("\n"),
)

const finding = (overrides: Partial<ModelFinding> = {}): ModelFinding => ({
  path: "src/list.ts",
  line: 3,
  severity: "blocking",
  category: "bug",
  title: "Returns undefined for the last item",
  body: "items[items.length] is one past the end of the array.",
  confidence: 0.9,
  ...overrides,
})

const report = (findings: ModelFinding[] = [], summary = "Changes last() to index past the end.") => ({
  summary,
  risk: "medium",
  files: [{ path: "src/list.ts", note: "last() rewritten" }],
  findings,
})

const config = (overrides: Partial<ReviewConfig> = {}): ReviewConfig => ({
  ...DEFAULT_REVIEW_CONFIG,
  verify: "off",
  ...overrides,
})

function input(directory: string, overrides: Partial<Review.RunInput> = {}): Review.RunInput {
  return {
    directory,
    trigger: "local",
    trust: "trusted",
    base: "1".repeat(40),
    head: "2".repeat(40),
    mode: "full",
    files: LIST,
    anchors: LIST,
    skipped: [],
    context: {},
    prior: [],
    rules: "",
    config: config(),
    model: { ...ref, context: 100_000, costKind: "free" },
    knownPath: async () => true,
    ...overrides,
  }
}

const priced = { ...ref, context: 100_000, costKind: "priced" as const, price: PRICE }

const useServer = (cost?: typeof PRICE) =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const llm = yield* TestLLMServer
    const fs = yield* FSUtil.Service
    const provider = testProviderConfig(llm.url)
    if (cost) provider.provider.test.models["test-model"].cost = cost
    yield* fs.writeWithDirs(
      path.join(test.directory, "opencode.json"),
      JSON.stringify({ $schema: "https://opencode.ai/config.json", ...provider }),
    )
    yield* fs.writeWithDirs(path.join(test.directory, "src/list.ts"), LIST_SOURCE)
    return { llm, directory: test.directory }
  })

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

function lastUserText(body: Record<string, unknown>) {
  const messages: unknown[] = Array.isArray(body.messages) ? body.messages : []
  const user = messages.findLast((message) => isRecord(message) && message.role === "user")
  const content = isRecord(user) ? user.content : undefined
  if (typeof content === "string") return content
  const parts: unknown[] = Array.isArray(content) ? content : []
  return parts.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("\n")
}

const answering = (text: string) => (hit: { body: Record<string, unknown> }) => lastUserText(hit.body).includes(text)
const REVIEW = answering("You are Vector's code reviewer")
const SECURITY = answering("You are Vector's security reviewer")
const VERIFY = answering("You are checking candidate findings")
const FINALIZE = answering("Stop investigating")

function toolNames(body: Record<string, unknown>): string[] {
  const tools: unknown[] = Array.isArray(body.tools) ? body.tools : []
  return tools.flatMap((tool) => {
    const fn = isRecord(tool) && isRecord(tool.function) ? tool.function : undefined
    return typeof fn?.name === "string" ? [fn.name] : []
  })
}

const modelRequests = (llm: TestLLMServer["Service"]) =>
  llm.inputs.pipe(
    Effect.map((bodies) =>
      bodies.filter((body) => !JSON.stringify(body).includes("Generate a title for this conversation")),
    ),
  )

describe("Review.run", () => {
  it.instance(
    "keeps findings that clear the bar and drops the rest, with no shell in any request",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        yield* llm.pushMatch(
          REVIEW,
          reply().tool(
            "StructuredOutput",
            report([
              finding(),
              finding({ line: 1, title: "A hunch", confidence: 0.3 }),
              finding({ path: "bun.lock", line: 1, title: "Lockfile drift" }),
              finding({ path: "src/missing.ts", line: 4, title: "A file that does not exist" }),
              finding({ path: "src/other.ts", line: 10, severity: "concern", title: "A caller expects the old value" }),
            ]),
          ),
        )

        const outcome = yield* Review.run(
          input(directory, {
            skipped: [{ path: "bun.lock", reason: "lockfile" }],
            knownPath: async (file) => file === "src/other.ts",
          }),
        )

        expect(outcome.specialists).toEqual([{ name: "review", status: "ok", steps: 1 }])
        expect(outcome.selection.inline.map((item) => [item.path, item.anchor.line, item.source])).toEqual([
          ["src/list.ts", 3, "review"],
        ])
        expect(outcome.selection.outsideDiff.map((item) => [item.path, item.reason])).toEqual([
          ["src/other.ts", "file-not-in-diff"],
        ])
        expect(outcome.selection.dropped).toEqual([
          { reason: "low-confidence", count: 1 },
          { reason: "ignored-path", count: 1 },
          { reason: "unknown-path", count: 1 },
        ])
        expect(outcome.selection.risk).toBe("high")
        expect(outcome.report.summary).toBe("Changes last() to index past the end.")
        expect(outcome.partial).toBeUndefined()
        expect(outcome.unreviewed).toEqual([])
        expect(outcome.cost?.kind).toBe("free")
        expect(outcome.cost?.model).toBe("test/test-model")
        expect(outcome.sessions).toHaveLength(1)
        expect(outcome.stats).toEqual({ files: 1, additions: 2, deletions: 1 })
        const requests = yield* modelRequests(llm)
        expect(requests.length).toBeGreaterThan(0)
        for (const body of requests) {
          // The engine has no `list` tool today; the rules allow it for when it exists.
          expect(
            toolNames(body).filter((name) => !["StructuredOutput", "glob", "grep", "list", "read"].includes(name)),
          ).toEqual([])
          expect(toolNames(body)).toContain("StructuredOutput")
        }
      }),
    TIMEOUT,
  )

  it.instance(
    "stops before the next step would break the budget with a finalize reserved, then finalizes",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const file = path.join(directory, "src/list.ts")
        // $0.201, then $0.301: after the second step the next step and a finalize ($0.336 each) no longer fit in $1.
        yield* llm.pushMatch(REVIEW, reply().tool("read", { filePath: file }).usage({ input: 20_000, output: 100 }))
        yield* llm.pushMatch(REVIEW, reply().tool("read", { filePath: file }).usage({ input: 30_000, output: 100 }))
        yield* llm.pushMatch(
          FINALIZE,
          reply()
            .tool("StructuredOutput", report([finding()]))
            .usage({ input: 30_000, output: 100 }),
        )

        const outcome = yield* Review.run(input(directory, { model: priced, config: config({ maxCostUsd: 1 }) }))

        expect(outcome.specialists[0]).toMatchObject({ name: "review", status: "stopped", detail: "budget" })
        expect(outcome.partial).toBe("budget")
        expect(outcome.report.findings).toHaveLength(1)
        expect(outcome.selection.inline).toHaveLength(1)
        // Every step is counted, the finalize included, and the total stays within the cap plus one step.
        expect(outcome.cost?.costUsd).toBeCloseTo(0.201 + 0.301 + 0.301, 6)
        expect(outcome.cost!.costUsd).toBeLessThanOrEqual(1 + 0.301)
        expect((yield* llm.hits).filter(FINALIZE)).toHaveLength(1)
      }),
    TIMEOUT,
  )

  it.instance(
    "stops at the step cap, then finalizes",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const file = path.join(directory, "src/list.ts")
        yield* llm.pushMatch(REVIEW, reply().tool("read", { filePath: file }))
        yield* llm.pushMatch(REVIEW, reply().tool("read", { filePath: file }))
        yield* llm.pushMatch(FINALIZE, reply().tool("StructuredOutput", report([finding()])))

        const outcome = yield* Review.run(input(directory, { config: config({ maxSteps: 2 }) }))

        expect(outcome.specialists[0]).toMatchObject({ name: "review", status: "stopped", detail: "steps" })
        expect(outcome.partial).toBe("steps")
        expect(outcome.report.findings).toHaveLength(1)
        expect((yield* llm.hits).filter(REVIEW).length).toBeLessThanOrEqual(3)
      }),
    TIMEOUT,
  )

  it.instance(
    "times out a hung model without hanging and finalizes",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        yield* llm.pushMatch(REVIEW, reply().hang())
        yield* llm.pushMatch(FINALIZE, reply().tool("StructuredOutput", report([finding()])))
        const started = Date.now()

        const outcome = yield* Review.run(input(directory, { config: config({ timeoutMinutes: 0.02 }) }))

        expect(outcome.specialists[0]).toMatchObject({ name: "review", status: "timeout" })
        expect(outcome.partial).toBe("timeout")
        expect(outcome.report.findings).toHaveLength(1)
        expect(Date.now() - started).toBeLessThan(20_000)
      }),
    TIMEOUT,
  )

  it.instance(
    "falls back to JSON in the reply text",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        yield* llm.pushMatch(
          REVIEW,
          reply()
            .text("Here is the review.\n```json\n" + JSON.stringify(report([finding()])) + "\n```")
            .stop(),
        )

        const outcome = yield* Review.run(input(directory))

        expect(outcome.specialists[0]).toMatchObject({ name: "review", status: "ok" })
        expect(outcome.selection.inline).toHaveLength(1)
        expect((yield* llm.hits).filter(FINALIZE)).toHaveLength(0)
      }),
    TIMEOUT,
  )

  it.instance(
    "runs the security reviewer only when a sensitive path changed",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()))
        const plain = yield* Review.run(input(directory))
        expect(plain.specialists.map((entry) => entry.name)).toEqual(["review"])
        expect((yield* llm.hits).filter(SECURITY)).toHaveLength(0)

        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()))
        yield* llm.pushMatch(
          SECURITY,
          reply().tool(
            "StructuredOutput",
            report(
              [
                finding({
                  path: "src/auth/session.ts",
                  line: 2,
                  category: "security",
                  title: "The token is no longer verified",
                }),
              ],
              "",
            ),
          ),
        )
        const sensitive = yield* Review.run(input(directory, { files: AUTH, anchors: AUTH }))

        expect(sensitive.specialists.map((entry) => entry.name).toSorted()).toEqual(["review", "security"])
        expect(sensitive.sessions).toHaveLength(2)
        expect(sensitive.selection.inline.map((item) => [item.path, item.source])).toEqual([
          ["src/auth/session.ts", "security"],
        ])
        expect(sensitive.report.summary).toBe("Changes last() to index past the end.")
      }),
    TIMEOUT,
  )

  it.instance(
    "drops findings the verify pass rejects, marks confirmed ones, and counts verify in the cost",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const kept = finding()
        const rejected = finding({ line: 2, title: "The index variable shadows nothing", confidence: 0.95 })
        const [keptID, rejectedID] = Review.normalizeFindings([kept, rejected], "review", LIST).map((item) => item.id)
        yield* llm.pushMatch(
          REVIEW,
          reply()
            .tool("StructuredOutput", report([kept, rejected]))
            .usage({ input: 1_000, output: 10 }),
        )
        yield* llm.pushMatch(
          VERIFY,
          reply()
            .tool("StructuredOutput", {
              results: [
                { id: keptID, verdict: "confirmed", reason: "Reproduced with a one-item array." },
                { id: rejectedID, verdict: "rejected", reason: "Not a defect." },
              ],
            })
            .usage({ input: 2_000, output: 20 }),
        )

        const outcome = yield* Review.run(
          input(directory, { model: priced, config: config({ verify: "blocking", maxCostUsd: 100 }) }),
        )

        expect(outcome.specialists.map((entry) => [entry.name, entry.status])).toEqual([
          ["review", "ok"],
          ["verify", "ok"],
        ])
        expect(outcome.selection.inline.map((item) => [item.id, item.verified])).toEqual([[keptID, true]])
        expect(outcome.selection.dropped).toEqual([{ reason: "rejected-by-verify", count: 1 }])
        expect(outcome.cost?.costUsd).toBeCloseTo(((1_000 + 10) * 10 + (2_000 + 20) * 10) / 1_000_000, 8)
      }),
    TIMEOUT,
  )

  it.instance(
    "skips verify when the budget is too low for it, and says so",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        yield* llm.pushMatch(
          REVIEW,
          reply()
            .tool("StructuredOutput", report([finding()]))
            .usage({ input: 50_000, output: 100 }),
        )

        const outcome = yield* Review.run(
          input(directory, { model: priced, config: config({ verify: "blocking", maxCostUsd: 0.6 }) }),
        )

        expect(outcome.specialists).toEqual([
          { name: "review", status: "ok", steps: 1 },
          { name: "verify", status: "skipped", steps: 0, detail: "budget" },
        ])
        expect(outcome.partial).toBeUndefined()
        expect(outcome.notes).toEqual([noteVerifySkipped()])
        expect(outcome.selection.inline).toHaveLength(1)
        expect((yield* llm.hits).filter(VERIFY)).toHaveLength(0)
      }),
    TIMEOUT,
  )

  it.instance(
    "checkpoints the spend after each session",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        yield* llm.pushMatch(
          REVIEW,
          reply().tool("StructuredOutput", report([finding({ path: "src/auth/session.ts", line: 2 })])),
        )
        yield* llm.pushMatch(SECURITY, reply().tool("StructuredOutput", report()))
        yield* llm.pushMatch(VERIFY, reply().tool("StructuredOutput", { results: [] }))
        const saved: ReviewCost[] = []

        const outcome = yield* Review.run(
          input(directory, {
            files: AUTH,
            anchors: AUTH,
            config: config({ verify: "blocking" }),
            onCheckpoint: async (spent) => {
              saved.push(spent)
            },
          }),
        )

        expect(outcome.sessions).toHaveLength(3)
        expect(saved).toHaveLength(3)
        expect(saved.every((spent) => spent.kind === "free" && spent.model === "test/test-model")).toBe(true)
      }),
    TIMEOUT,
  )

  it.instance(
    "answers a call to bash or a denied read with a tool error and carries on, asking nobody",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const fs = yield* FSUtil.Service
        yield* fs.writeWithDirs(path.join(directory, ".env"), "TOKEN=placeholder-not-a-secret\n")
        yield* llm.pushMatch(REVIEW, reply().tool("bash", { command: "cat .env", description: "Read the environment" }))
        yield* llm.pushMatch(REVIEW, reply().tool("read", { filePath: path.join(directory, ".env") }))
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()))

        const outcome = yield* Review.run(input(directory))

        expect(outcome.specialists).toEqual([{ name: "review", status: "ok", steps: 3 }])
        const sessions = yield* Session.Service
        const tools = (yield* sessions.messages({ sessionID: SessionID.make(outcome.sessions[0]!) }))
          .flatMap((message) => message.parts)
          .flatMap((part) => (part.type === "tool" ? [part] : []))
        expect(tools.find((part) => part.tool === "read")?.state.status).toBe("error")
        expect(
          tools
            .filter((part) => part.tool !== "read" && part.tool !== "StructuredOutput")
            .map((part) => part.state.status),
        ).toEqual(["error"])
        expect(JSON.stringify(tools)).not.toContain("placeholder-not-a-secret")
        const permission = yield* Permission.Service
        expect(yield* permission.list()).toEqual([])
        for (const body of yield* modelRequests(llm)) expect(toolNames(body)).not.toContain("bash")
      }),
    TIMEOUT,
  )

  it.instance(
    "marks a run whose model fails as a model error and leaves every file unreviewed",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        yield* llm.pushMatch(REVIEW, httpError(400, { error: { message: "bad request" } }))
        yield* llm.pushMatch(FINALIZE, httpError(400, { error: { message: "bad request" } }))

        const outcome = yield* Review.run(input(directory))

        expect(outcome.specialists[0]).toMatchObject({ name: "review", status: "failed" })
        expect(outcome.partial).toBe("model-error")
        expect(outcome.unreviewed).toEqual(["src/list.ts"])
        expect(outcome.selection.inline).toEqual([])
      }),
    TIMEOUT,
  )
})
