import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Fiber, Layer, Stream } from "effect"
import { LLMEvent, Usage } from "@vectordevai/llm"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { SessionV1 } from "@vectordevai/core/v1/session"
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

const replacements = [
  [SessionSummary.node, summary],
  [LSP.node, lsp],
  [MCP.node, mcp],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
] as const
const it = testEffect(LayerNode.compile(root, replacements))

const TIMEOUT = 30_000
const ref = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("test-model") }
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
    model: { ...ref, context: 100_000, costKind: "priced" },
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
    if (cost) provider.provider.lmstudio.models["test-model"].cost = cost
    yield* fs.writeWithDirs(
      path.join(test.directory, "vector.json"),
      JSON.stringify({ $schema: "https://vectordev.ai/config.json", ...provider }),
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

// Exercise the processor's real partial-usage persistence. This boundary fixture reports a numeric started total,
// then fails or interrupts before completion; HTTP fixtures above cover the regular full-stream path.
for (const reason of ["error", "abort", "reduced"] as const) {
  const partial = testEffect(
    LayerNode.compile(root, [
      ...replacements,
      [
        LLM.node,
        Layer.succeed(
          LLM.Service,
          LLM.Service.of({
            stream: (input) =>
              Stream.suspend(() => {
                const text = JSON.stringify(input.messages.at(-1) ?? {})
                if (input.agent.name === "security" && !text.includes("Stop investigating")) {
                  input.started?.(
                    reason === "reduced"
                      ? { inputTokens: 40_000, outputTokens: 100, totalTokens: 40_100 }
                      : { inputTokens: 1_000, outputTokens: 1, totalTokens: 1_001 },
                  )
                  return Stream.make(
                    LLMEvent.stepStart({ index: 0 }),
                    LLMEvent.textStart({ id: "partial" }),
                    LLMEvent.textDelta({ id: "partial", text: "Investigating" }),
                  ).pipe(
                    Stream.concat(
                      reason === "reduced"
                        ? Stream.make(
                            LLMEvent.stepFinish({
                              index: 0,
                              reason: "error",
                              usage: new Usage({ inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 }),
                            }),
                            LLMEvent.finish({ reason: "error" }),
                          )
                        : reason === "error"
                          ? Stream.fail(new Error("stream failed"))
                          : Stream.fromEffect(Effect.interrupt),
                    ),
                  )
                }
                const verify = text.includes("You are checking candidate findings")
                return Stream.make(
                  LLMEvent.stepStart({ index: 0 }),
                  LLMEvent.textStart({ id: "answer" }),
                  LLMEvent.textDelta({
                    id: "answer",
                    text: JSON.stringify(
                      verify ? { results: [] } : report(input.agent.name === "review" ? [finding()] : []),
                    ),
                  }),
                  LLMEvent.textEnd({ id: "answer" }),
                  LLMEvent.stepFinish({
                    index: 0,
                    reason: "stop",
                    usage: new Usage(
                      input.agent.name === "review"
                        ? { inputTokens: 30_000, outputTokens: 100, totalTokens: 30_100 }
                        : { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                    ),
                  }),
                  LLMEvent.finish({ reason: "stop" }),
                )
              }),
          }),
        ),
      ],
    ]),
  )
  partial.instance(
    `retains incomplete ${reason} usage even when its started report includes a numeric total`,
    () =>
      Effect.gen(function* () {
        const { directory } = yield* useServer(PRICE)
        const outcome = yield* Review.run(
          input(directory, {
            model: priced,
            config: config({ maxCostUsd: reason === "reduced" ? 0.8 : 0.57, security: "always", verify: "blocking" }),
          }),
        )
        expect(outcome.specialists.at(-1)).toEqual({ name: "verify", status: "skipped", steps: 0, detail: "budget" })
        expect(outcome.sessions).toHaveLength(2)
        expect(outcome.cost?.costUsd).toBeCloseTo(reason === "reduced" ? 0.312 : 0.31101, 6)
        const sessions = yield* Session.Service
        const messages = yield* sessions.messages({ sessionID: SessionID.make(outcome.sessions[1]!) })
        expect(messages.flatMap((message) => message.parts)).toContainEqual(
          expect.objectContaining({
            type: "step-finish",
            reason: reason === "reduced" ? "error" : reason,
            tokens: expect.objectContaining({ total: reason === "reduced" ? 1_100 : 1_001 }),
          }),
        )
        expect(outcome.notes).toContain(
          "Reported cost may be incomplete; work with uncertain usage retained its estimated budget exposure for this review.",
        )
      }),
    TIMEOUT,
  )
}

describe("Review.run", () => {
  it.instance(
    "refuses an unaffordable initial request without starting the provider and keeps plan reviews uncapped",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const limited = input(directory, { model: priced, config: config({ maxCostUsd: 0.00001 }) })
        const stopped = yield* Review.run(limited)
        expect(yield* llm.hits).toHaveLength(0)
        expect(stopped.specialists).toEqual([{ name: "review", status: "stopped", steps: 0, detail: "budget" }])
        expect(stopped.partial).toBe("budget")
        expect(stopped.unreviewed).toEqual(["src/list.ts"])
        expect(stopped.cost).toMatchObject({ costUsd: 0, kind: "priced" })

        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()).usage({ input: 1_000, output: 100 }))
        const plan = yield* Review.run({ ...limited, model: { ...priced, costKind: "plan" } })
        expect(plan.specialists).toEqual([{ name: "review", status: "ok", steps: 1 }])
        expect(yield* llm.hits).toHaveLength(1)
      }),
    TIMEOUT,
  )

  it.instance(
    "reserves initial turns across specialists instead of admitting both against the same remainder",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const release = Promise.withResolvers<void>()
        yield* llm.push(
          reply().wait(release.promise).tool("StructuredOutput", report()).usage({ input: 1_000, output: 100 }),
        )
        const [outcome] = yield* Effect.all(
          [
            Review.run(
              input(directory, {
                model: priced,
                files: AUTH,
                anchors: AUTH,
                rules: "Check boundary conditions. ".repeat(1_000),
                config: config({ maxCostUsd: 0.35 }),
              }),
            ),
            llm.wait(1).pipe(Effect.tap(() => Effect.sync(() => release.resolve()))),
          ],
          { concurrency: 2 },
        ).pipe(Effect.ensuring(Effect.sync(() => release.resolve())))
        expect(yield* llm.hits).toHaveLength(1)
        expect(outcome.specialists.map((item) => item.status).toSorted()).toEqual(["ok", "stopped"])
        expect(outcome.specialists.find((item) => item.status === "stopped")).toMatchObject({
          steps: 0,
          detail: "budget",
        })
        expect(outcome.partial).toBe("budget")
        expect(outcome.unreviewed).toEqual(["src/auth/session.ts"])
      }),
    TIMEOUT,
  )

  it.instance(
    "keeps affordable initial requests parallel and reserves a running finalizer against the other specialist",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const review = Promise.withResolvers<void>()
        const security = Promise.withResolvers<void>()
        const finalize = Promise.withResolvers<void>()
        const stopped = Promise.withResolvers<void>()
        const costs: number[] = []
        const read = { filePath: path.join(directory, "src/list.ts") }
        yield* llm.pushMatch(
          REVIEW,
          reply().wait(review.promise).tool("read", read).usage({ input: 30_000, output: 100 }),
        )
        yield* llm.pushMatch(
          SECURITY,
          reply().wait(security.promise).tool("read", read).usage({ input: 30_000, output: 100 }),
        )
        yield* llm.pushMatch(
          FINALIZE,
          reply().wait(finalize.promise).tool("StructuredOutput", report()).usage({ input: 1_000, output: 100 }),
        )
        const [outcome] = yield* Effect.all(
          [
            Review.run(
              input(directory, {
                model: priced,
                files: AUTH,
                anchors: AUTH,
                config: config({ maxCostUsd: 1 }),
                onProgress(event) {
                  if (event.type === "cost") costs.push(event.costUsd)
                  if (event.type === "specialist" && event.name === "security" && event.status === "stopped")
                    stopped.resolve()
                },
              }),
            ),
            Effect.gen(function* () {
              // Both requests must start before either response is released.
              yield* llm.wait(2)
              review.resolve()
              yield* llm.wait(3)
              expect((yield* llm.hits).filter(FINALIZE)).toHaveLength(1)
              security.resolve()
              yield* Effect.promise(() => stopped.promise)
              finalize.resolve()
            }),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.timeout("20 seconds"),
          Effect.ensuring(
            Effect.sync(() => {
              review.resolve()
              security.resolve()
              finalize.resolve()
            }),
          ),
        )
        expect(yield* llm.hits).toHaveLength(3)
        expect(outcome.specialists).toEqual([
          { name: "review", status: "stopped", steps: 2, detail: "budget" },
          { name: "security", status: "stopped", steps: 1, detail: "budget" },
        ])
        expect(outcome.cost?.costUsd).toBeCloseTo(0.613, 6)
        expect(costs).toEqual([...costs].sort((a, b) => a - b))
        expect(costs.at(-1)).toBeCloseTo(0.613, 6)
        expect(outcome.partial).toBe("budget")
      }),
    TIMEOUT,
  )

  it.instance(
    "blocks sibling admission using already observed excess before the expensive stream finishes",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const events = yield* EventV2Bridge.Service
        const review = Promise.withResolvers<void>()
        const security = Promise.withResolvers<void>()
        const observed = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const stopped = Promise.withResolvers<void>()
        const off = yield* events.listen((event) => {
          if (event.type !== SessionV1.Event.PartUpdated.type) return Effect.void
          const part = (event.data as typeof SessionV1.Event.PartUpdated.data.Type).part
          if (part.type !== "step-finish" || part.cost <= 0.4) return Effect.void
          observed.resolve()
          // Hold before Review's listener and before the processor can finish its snapshot/stream. Admission must
          // already include this known charge, even though terminal lease settlement has not happened yet.
          return Effect.promise(() => release.promise)
        })
        const unlock = Effect.sync(() => {
          review.resolve()
          security.resolve()
          release.resolve()
        })
        yield* llm.pushMatch(
          REVIEW,
          reply()
            .wait(review.promise)
            .tool("read", { filePath: path.join(directory, "src/list.ts") })
            .usage({ input: 40_000, output: 100 }),
        )
        yield* llm.pushMatch(
          SECURITY,
          reply()
            .wait(security.promise)
            .tool("read", { filePath: path.join(directory, "src/list.ts") })
            .usage({ input: 1_000, output: 100 }),
        )
        const [outcome] = yield* Effect.all(
          [
            Review.run(
              input(directory, {
                model: priced,
                config: config({ maxCostUsd: 0.4, security: "always" }),
                onProgress(event) {
                  if (event.type === "specialist" && event.name === "security" && event.status === "stopped")
                    stopped.resolve()
                },
              }),
            ),
            Effect.gen(function* () {
              yield* llm.wait(2)
              review.resolve()
              yield* Effect.promise(() => observed.promise)
              security.resolve()
              const next = yield* Effect.raceFirst(
                Effect.promise(() => stopped.promise).pipe(Effect.as("stopped")),
                llm.wait(3).pipe(Effect.as("unexpected provider request")),
              )
              expect(next).toBe("stopped")
              release.resolve()
            }).pipe(Effect.ensuring(unlock)),
          ],
          { concurrency: 2 },
        ).pipe(Effect.timeout("20 seconds"), Effect.ensuring(unlock), Effect.ensuring(off))
        expect(yield* modelRequests(llm)).toHaveLength(2)
        expect((yield* llm.hits).filter(FINALIZE)).toHaveLength(0)
        expect(outcome.specialists).toEqual([
          { name: "review", status: "stopped", steps: 1, detail: "budget" },
          { name: "security", status: "stopped", steps: 1, detail: "budget" },
        ])
        expect(outcome.cost?.costUsd).toBeCloseTo(0.412, 6)
        expect(outcome.partial).toBe("budget")
        expect(outcome.unreviewed).toEqual(["src/list.ts"])
      }),
    TIMEOUT,
  )

  it.instance(
    "settles output that exceeds its reservation without refunding it or starting an unaffordable finalizer",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        yield* llm.pushMatch(
          REVIEW,
          reply()
            .tool("read", { filePath: path.join(directory, "src/list.ts") })
            .usage({ input: 40_000, output: 100 }),
        )
        const outcome = yield* Review.run(input(directory, { model: priced, config: config({ maxCostUsd: 0.8 }) }))
        expect(yield* llm.hits).toHaveLength(1)
        expect(outcome.specialists).toEqual([{ name: "review", status: "stopped", steps: 1, detail: "budget" }])
        expect(outcome.cost?.costUsd).toBeCloseTo(0.401, 6)
        expect(outcome.unreviewed).toEqual(["src/list.ts"])
      }),
    TIMEOUT,
  )

  it.instance(
    "does not reuse a failed finalizer's unreported usage estimate for verification",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const reviewed = Promise.withResolvers<void>()
        yield* llm.pushMatch(
          REVIEW,
          reply()
            .tool("StructuredOutput", report([finding({ path: "src/auth/session.ts", line: 2 })]))
            .usage({ input: 1_000, output: 100 }),
        )
        yield* llm.pushMatch(
          SECURITY,
          reply()
            .wait(reviewed.promise)
            .tool("read", { filePath: path.join(directory, "src/list.ts") })
            .usage({ input: 25_000, output: 100 }),
        )
        yield* llm.pushMatch(FINALIZE, reply().text("The review could not be completed.").stop())
        const outcome = yield* Review.run(
          input(directory, {
            model: priced,
            files: AUTH,
            anchors: AUTH,
            config: config({ maxCostUsd: 0.58, verify: "blocking" }),
            onProgress(event) {
              if (event.type === "specialist" && event.name === "review" && event.status === "ok") reviewed.resolve()
            },
          }),
        ).pipe(Effect.ensuring(Effect.sync(() => reviewed.resolve())))
        expect(outcome.specialists.map((item) => [item.name, item.status])).toEqual([
          ["review", "ok"],
          ["security", "failed"],
          ["verify", "skipped"],
        ])
        expect((yield* llm.hits).filter(VERIFY)).toHaveLength(0)
        expect(outcome.cost?.costUsd).toBeCloseTo(0.262, 6)
        expect(outcome.notes).toContain(
          "Reported cost may be incomplete; work with uncertain usage retained its estimated budget exposure for this review.",
        )
      }),
    TIMEOUT,
  )

  it.instance(
    "retains uncertain usage from a successful report but releases explicitly reported zero usage",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const review = input(directory, {
          model: priced,
          config: config({ maxCostUsd: 0.55, security: "always", verify: "blocking" }),
        })
        yield* llm.pushMatch(
          REVIEW,
          reply()
            .tool("StructuredOutput", report([finding()]))
            .usage({ input: 0, output: 0 }),
        )
        yield* llm.pushMatch(SECURITY, reply().tool("StructuredOutput", report()).usage({ input: 30_000, output: 100 }))
        yield* llm.pushMatch(
          VERIFY,
          reply().tool("StructuredOutput", { results: [] }).usage({ input: 1_000, output: 100 }),
        )
        const known = yield* Review.run(review)
        expect(known.specialists.at(-1)).toMatchObject({ name: "verify", status: "ok" })
        expect(known.notes).toEqual([])

        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([finding()])))
        yield* llm.pushMatch(SECURITY, reply().tool("StructuredOutput", report()).usage({ input: 30_000, output: 100 }))
        const unknown = yield* Review.run(review)
        expect(unknown.specialists).toEqual([
          { name: "review", status: "ok", steps: 1 },
          { name: "security", status: "ok", steps: 1 },
          { name: "verify", status: "skipped", steps: 0, detail: "budget" },
        ])
        expect((yield* llm.hits).filter(VERIFY)).toHaveLength(1)
        expect(unknown.cost?.costUsd).toBeCloseTo(0.301, 6)
        expect(unknown.notes).toContain(
          "Reported cost may be incomplete; work with uncertain usage retained its estimated budget exposure for this review.",
        )
      }),
    TIMEOUT,
  )

  it.instance(
    "releases unused finalization reservations after both reports complete before admitting verification",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        yield* llm.pushMatch(
          REVIEW,
          reply()
            .tool("StructuredOutput", report([finding({ path: "src/auth/session.ts", line: 2 })]))
            .usage({ input: 30_000, output: 100 }),
        )
        yield* llm.pushMatch(SECURITY, reply().tool("StructuredOutput", report()).usage({ input: 30_000, output: 100 }))
        yield* llm.pushMatch(
          VERIFY,
          reply().tool("StructuredOutput", { results: [] }).usage({ input: 1_000, output: 100 }),
        )
        const outcome = yield* Review.run(
          input(directory, {
            model: priced,
            files: AUTH,
            anchors: AUTH,
            config: config({ maxCostUsd: 1, verify: "blocking" }),
          }),
        )
        expect(outcome.specialists.map((item) => [item.name, item.status])).toEqual([
          ["review", "ok"],
          ["security", "ok"],
          ["verify", "ok"],
        ])
        expect(yield* llm.hits).toHaveLength(3)
        expect(outcome.cost?.costUsd).toBeCloseTo(0.613, 6)
        expect(outcome.notes).toEqual([])
      }),
    TIMEOUT,
  )

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
        expect(outcome.cost?.kind).toBe("unknown")
        expect(outcome.cost?.usageMissing).toBe(true)
        expect(outcome.cost?.model).toBe("lmstudio/test-model")
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
        expect(outcome.cost?.kind).toBe("priced")
        expect(outcome.cost?.usageMissing).toBeUndefined()
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
        expect((yield* llm.hits).filter(REVIEW)).toHaveLength(2)
        expect((yield* llm.inputs).filter((body) => FINALIZE({ body })).map(toolNames)).toEqual([["StructuredOutput"]])
      }),
    TIMEOUT,
  )

  it.instance(
    "counts failed provider attempts before retries and allows only one finalizer attempt",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        yield* llm.pushMatch(REVIEW, httpError(503, { error: "temporary failure" }))
        yield* llm.pushMatch(FINALIZE, httpError(503, { error: "temporary finalizer failure" }))
        const outcome = yield* Review.run(input(directory, { config: config({ maxSteps: 1 }) }))
        expect((yield* llm.hits).filter(REVIEW)).toHaveLength(1)
        expect((yield* llm.hits).filter(FINALIZE)).toHaveLength(1)
        expect(outcome.specialists).toEqual([{ name: "review", status: "stopped", steps: 0, detail: "steps" }])
        expect(outcome.partial).toBe("steps")
        expect(outcome.unreviewed).toContain("src/list.ts")
        expect((yield* llm.inputs).filter((body) => FINALIZE({ body })).map(toolNames)).toEqual([["StructuredOutput"]])
      }),
    TIMEOUT,
  )

  it.instance(
    "denies compaction at the attempt boundary without looping or spending the finalizer on a summary",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        yield* llm.pushMatch(REVIEW, httpError(400, { type: "error", error: { code: "context_length_exceeded" } }))
        yield* llm.pushMatch(FINALIZE, reply().tool("StructuredOutput", report()))
        const outcome = yield* Review.run(input(directory, { config: config({ maxSteps: 1 }) }))
        expect((yield* llm.hits).filter(REVIEW)).toHaveLength(1)
        expect(yield* modelRequests(llm)).toHaveLength(1)
        expect(outcome.specialists[0]).toMatchObject({ name: "review", status: "stopped", detail: "steps" })
        expect(outcome.partial).toBe("steps")
        expect(outcome.unreviewed).toContain("src/list.ts")
        expect((yield* llm.inputs).filter((body) => FINALIZE({ body })).map(toolNames)).toEqual([])
      }),
    TIMEOUT,
  )

  it.instance(
    "keeps coverage incomplete when one specialist exhausts attempts without a report",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()))
        yield* llm.pushMatch(SECURITY, httpError(503, { error: "temporary failure" }))
        yield* llm.pushMatch(FINALIZE, httpError(503, { error: "temporary finalizer failure" }))
        const outcome = yield* Review.run(input(directory, { config: config({ maxSteps: 1, security: "always" }) }))
        expect(outcome.specialists).toEqual([
          { name: "review", status: "ok", steps: 1 },
          { name: "security", status: "stopped", steps: 0, detail: "steps" },
        ])
        expect(yield* modelRequests(llm)).toHaveLength(3)
        expect(outcome.partial).toBe("steps")
        expect(outcome.unreviewed).toEqual(["src/list.ts"])
      }),
    TIMEOUT,
  )

  it.instance(
    "times out a hung model without hanging and finalizes",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        // A first review loads the instance's config, providers and tools, so the short deadline below is spent
        // waiting on the hung model rather than racing a cold start that can end before the model is ever asked.
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()))
        expect((yield* Review.run(input(directory))).specialists[0]).toMatchObject({ name: "review", status: "ok" })
        yield* llm.pushMatch(REVIEW, reply().hang())
        yield* llm.pushMatch(
          FINALIZE,
          reply()
            .tool("StructuredOutput", report([finding()]))
            .usage({ input: 1_000, output: 100 }),
        )
        const started = Date.now()

        const outcome = yield* Review.run(input(directory, { model: priced, config: config({ timeoutMinutes: 0.02 }) }))

        expect(outcome.specialists[0]).toMatchObject({ name: "review", status: "timeout", detail: "timeout" })
        expect(outcome.partial).toBe("timeout")
        expect(outcome.report.findings).toHaveLength(1)
        expect(outcome.cost?.costUsd).toBeCloseTo(0.011, 6)
        // The deadline ended a request the model never answered: the warm-up review and the hung one.
        expect((yield* llm.hits).filter(REVIEW)).toHaveLength(2)
        expect(Date.now() - started).toBeLessThan(20_000)
      }),
    TIMEOUT,
  )

  it.instance(
    "cancels the owned runner before releasing an externally interrupted review",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const status = yield* SessionStatus.Service
        yield* llm.pushMatch(REVIEW, reply().hang())
        const fiber = yield* Review.run(input(directory, { model: priced })).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* Fiber.interrupt(fiber)
        expect((yield* status.list()).size).toBe(0)
        expect(yield* modelRequests(llm)).toHaveLength(1)
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()).usage({ input: 10, output: 1 }))
        const outcome = yield* Review.run(input(directory, { model: priced }))
        expect(outcome.specialists).toEqual([{ name: "review", status: "ok", steps: 1 }])
        expect(yield* modelRequests(llm)).toHaveLength(2)
        expect((yield* llm.hits).filter(FINALIZE)).toHaveLength(0)
      }),
    TIMEOUT,
  )

  // Interrupting the first prompt on an instance while its config and providers are still loading must not leave
  // the interruption cached (the per-instance ScopedCache, and the global config and model catalog loaders).
  it.instance(
    "a review after an interrupted cold start still reaches the model",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        // A 5 ms deadline ends the first review while the instance is still loading.
        yield* Review.run(input(directory, { config: config({ timeoutMinutes: 5 / 60_000 }) }))
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()))

        const outcome = yield* Review.run(input(directory))

        expect(outcome.specialists[0]).toMatchObject({ name: "review", status: "ok" })
        expect((yield* llm.hits).filter(REVIEW).length).toBeGreaterThan(0)
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
        const { llm, directory } = yield* useServer(PRICE)
        yield* llm.pushMatch(
          REVIEW,
          reply()
            .tool("StructuredOutput", report([finding({ path: "src/auth/session.ts", line: 2 })]))
            .usage({ input: 1_000, output: 100 }),
        )
        yield* llm.pushMatch(SECURITY, reply().tool("StructuredOutput", report()).usage({ input: 1_000, output: 100 }))
        yield* llm.pushMatch(
          VERIFY,
          reply().tool("StructuredOutput", { results: [] }).usage({ input: 1_000, output: 100 }),
        )
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
        expect(saved.every((spent) => spent.kind === "priced" && spent.model === "lmstudio/test-model")).toBe(true)
        expect(saved.every((spent) => spent.costUsd > 0)).toBe(true)
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
