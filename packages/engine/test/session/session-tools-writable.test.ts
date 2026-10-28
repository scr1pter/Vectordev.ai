import { afterEach, describe, expect } from "bun:test"
import path from "node:path"
import { Cause, Effect, Exit, Schema } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Brain } from "@vectordevai/core/brain/brain"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { SessionTools } from "@/session/tools"
import { TaskClaims } from "@/task/claims"
import type { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      Brain.node,
      Config.node,
      EventV2Bridge.node,
      MCP.node,
      Permission.node,
      Plugin.node,
      Provider.node,
      Session.node,
      ToolRegistry.node,
      Truncate.node,
    ]),
  ),
)

const ref = { providerID: ProviderV2.ID.make("local-test"), modelID: ModelV2.ID.make("model") }
const options = {
  trusted: true,
  config: {
    provider: {
      "local-test": {
        npm: "@ai-sdk/openai-compatible",
        name: "Local test",
        options: { baseURL: "http://127.0.0.1:1/v1" },
        models: { model: { name: "Test", limit: { context: 16_384, output: 1_024 } } },
      },
    },
  },
}

afterEach(async () => {
  for (const claim of TaskClaims.claims) TaskClaims.release(claim)
  await disposeAllInstances()
})

const resolved = Effect.fn("SessionToolsWritableTest.resolve")(function* (execute: Tool.Def["execute"], allow = false) {
  const sessions = yield* Session.Service
  const registry = yield* ToolRegistry.Service
  const agents = yield* Agent.Service
  const provider = yield* Provider.Service
  const session = yield* sessions.create({ title: "Write check" })
  const model = yield* provider.getModel(ref.providerID, ref.modelID)
  const agent = yield* agents.get("build")
  if (!agent) throw new Error("Build agent unavailable")
  const message: SessionV1.Assistant = {
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "assistant",
    parentID: MessageID.ascending(),
    agent: "build",
    mode: "build",
    cost: 0,
    path: { cwd: "/", root: "/" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    providerID: ref.providerID,
    modelID: ref.modelID,
    time: { created: Date.now() },
  }
  // A test tool exercises the actual runtime context and permission wrapper without a model request or filesystem write.
  const probe: Tool.Def = { id: "probe", parameters: Schema.Struct({}), description: "Probe", execute }
  const tools = yield* SessionTools.resolve({
    agent: { ...agent, permission: [{ permission: "edit", pattern: "*", action: allow ? "allow" : "ask" }] },
    model,
    session,
    messages: [],
    invokedAgents: [],
    processor: { message, updateToolCall: () => Effect.succeed(undefined), completeToolCall: () => Effect.void },
    promptOps: {
      cancel: () => Effect.void,
      resolvePromptParts: () => Effect.succeed([]),
      prompt: () => Effect.die("Unexpected model request"),
    },
  }).pipe(Effect.provideService(ToolRegistry.Service, { ...registry, tools: () => Effect.succeed([probe]) }))
  return { tools, session }
})

describe("SessionTools writable context", () => {
  it.instance(
    "refused file writes emit no permission.asked event",
    () =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        const events = yield* EventV2Bridge.Service
        const permissions = yield* Permission.Service
        const asked: string[] = []
        const off = yield* events.listen((event) =>
          Effect.sync(() => {
            if (event.type === "permission.asked") asked.push(event.type)
          }),
        )
        yield* Effect.addFinalizer(() => off)
        const file = path.join(instance.directory, "owned.ts")
        const { tools, session } = yield* resolved((_args, ctx) =>
          Effect.gen(function* () {
            yield* ctx.ask({ permission: "edit", patterns: [file], always: [], metadata: {} })
            return { title: "Unexpected", output: "Unexpected", metadata: {} }
          }),
        )
        TaskClaims.reserve({
          tree: instance.worktree,
          directory: instance.directory,
          parentSessionID: session.id,
          taskID: "ses_owner",
          title: "Owner",
          paths: ["owned.ts"],
        })
        const exit = yield* Effect.tryPromise({
          try: async () =>
            tools.probe.execute!({}, { toolCallId: "probe", messages: [], abortSignal: new AbortController().signal }),
          catch: (error) => error,
        }).pipe(Effect.timeout("2 seconds"), Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("belongs to the running subagent")
        expect(asked).toEqual([])
        expect(yield* permissions.list()).toEqual([])
      }),
    options,
  )

  it.instance(
    "shell edit asks do not repeat the shell's own writable check",
    () =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        const file = path.join(instance.directory, "shell.ts")
        const { tools } = yield* resolved(
          (_args, ctx) =>
            Effect.gen(function* () {
              if (!ctx.assertWritable) throw new Error("Writable hook missing")
              yield* ctx.assertWritable({ files: [file], via: "shell" })
              // A claim arriving between the shell check and its permission ask detects an accidental second check.
              const claim = TaskClaims.reserve({
                tree: instance.worktree,
                directory: instance.directory,
                parentSessionID: ctx.sessionID,
                taskID: "ses_owner",
                title: "Owner",
                paths: ["shell.ts"],
              })
              yield* ctx
                .ask({ permission: "edit", patterns: [file], always: [], metadata: { command: "echo ok > shell.ts" } })
                .pipe(Effect.ensuring(Effect.sync(() => TaskClaims.release(claim))))
              return { title: "Allowed", output: "Allowed", metadata: {} }
            }),
          true,
        )
        const result = yield* Effect.promise(async () =>
          tools.probe.execute!(
            {},
            {
              toolCallId: "probe",
              messages: [],
              abortSignal: new AbortController().signal,
            },
          ),
        )
        expect(result).toMatchObject({ output: "Allowed" })
      }),
    options,
  )
})
