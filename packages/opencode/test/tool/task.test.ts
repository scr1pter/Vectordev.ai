import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(layer())
const background = testEffect(layer({ experimentalBackgroundSubagents: true }))

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

function taskContext(input: { sessionID: SessionID; messageID: MessageID; promptOps: TaskPromptOps; callID?: string }) {
  return {
    sessionID: input.sessionID,
    messageID: input.messageID,
    ...(input.callID ? { callID: input.callID } : {}),
    agent: "build",
    abort: new AbortController().signal,
    extra: { promptOps: input.promptOps },
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

const childUsage = {
  cost: 0.5,
  tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 2 } },
  total: 137,
  toolUses: 1,
  steps: 1,
}

// Records one model step with one tool call in a child session, the way the processor would.
function spend(sessions: Session.Interface, sessionID: SessionID) {
  return Effect.gen(function* () {
    const message = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID,
      mode: "general",
      agent: "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    } satisfies SessionV1.Assistant)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: message.id,
      sessionID,
      type: "tool",
      callID: "call_child_read",
      tool: "read",
      state: {
        status: "completed",
        input: {},
        output: "",
        title: "read",
        metadata: {},
        time: { start: Date.now(), end: Date.now() },
      },
    } satisfies SessionV1.ToolPart)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: message.id,
      sessionID,
      type: "step-finish",
      reason: "stop",
      cost: childUsage.cost,
      tokens: childUsage.tokens,
    } satisfies SessionV1.StepFinishPart)
  })
}

describe("tool.task", () => {
  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf("- alpha: Alpha agent")
        const debug = first.indexOf("- debug:")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const review = first.indexOf("- review:")
        const security = first.indexOf("- security:")
        const test = first.indexOf("- test:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(debug).toBeGreaterThan(alpha)
        expect(explore).toBeGreaterThan(debug)
        expect(general).toBeGreaterThan(explore)
        expect(review).toBeGreaterThan(general)
        expect(security).toBeGreaterThan(review)
        expect(test).toBeGreaterThan(security)
        expect(zebra).toBeGreaterThan(test)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.variant).toBe("xhigh")
      expect((yield* sessions.get(child.id)).metadata?.subagent).toMatchObject({
        status: "completed",
        agent: "general",
        parentMessageID: assistant.id,
      })
    }),
  )

  it.instance("execute resumes a task with no subagent_type as the agent it ran", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child", agent: "explore" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps({ text: "resumed" })

      const result = yield* def.execute(
        {
          description: "keep digging",
          prompt: "look further into the cache key path",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.sessionId).toBe(child.id)
      expect((yield* sessions.get(child.id)).metadata?.subagent).toMatchObject({
        agent: "explore",
        kind: "specialist",
      })
    }),
  )

  it.instance("a run whose child ended on an error is reported to the model as an error", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      // The child's loop stores a provider error on its last message and returns normally.
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          sessions
            .updateMessage({
              id: MessageID.ascending(),
              role: "assistant",
              parentID: MessageID.ascending(),
              sessionID: input.sessionID,
              mode: "general",
              agent: "general",
              cost: 0,
              path: { cwd: "/tmp", root: "/tmp" },
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: ref.modelID,
              providerID: ref.providerID,
              time: { created: Date.now() },
              error: { name: "UnknownError", data: { message: "rate limited" } },
            } as SessionV1.Assistant)
            .pipe(Effect.as(reply(input, "partial notes"))),
      }

      const result = yield* def.execute(
        { description: "inspect bug", prompt: "look into the cache key path" },
        taskContext({ sessionID: chat.id, messageID: assistant.id, promptOps }),
      )

      expect(result.output).toContain(`state="error"`)
      expect(result.output).toContain("<task_error>")
      expect(result.output).toContain("rate limited")
      expect(result.metadata).toMatchObject({ status: "error", error: "rate limited" })
    }),
  )

  it.instance("stopping a foreground subagent returns the cancelled note", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const started = yield* Deferred.make<string>()
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => Deferred.succeed(started, input.sessionID).pipe(Effect.andThen(Effect.never)),
      }

      const fiber = yield* def
        .execute(
          { description: "inspect bug", prompt: "look into the cache key path" },
          taskContext({ sessionID: chat.id, messageID: assistant.id, promptOps }),
        )
        .pipe(Effect.forkChild)
      const child = yield* Deferred.await(started)
      yield* jobs.cancel(child)

      const result = yield* Fiber.join(fiber)
      expect(result.output).toContain(`state="cancelled"`)
      expect(result.output).toContain("stopped before it finished")
      expect(result.metadata).toMatchObject({ status: "cancelled" })
    }),
  )

  it.instance(
    "execute with no subagent_type names the permitted types when general is denied",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const exit = yield* Effect.exit(
          def.execute(
            {
              description: "look around",
              prompt: "map the auth middleware",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps({}) },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          ),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const message = Cause.pretty(exit.cause)
          expect(message).toContain("The general Subagent is not available to the build agent")
          expect(message).toContain("explore")
          expect(message).not.toMatch(/one of: [^\n]*\bgeneral\b/)
        }
        expect(yield* sessions.children(chat.id)).toHaveLength(0)
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            general: "deny",
          },
        },
      },
    },
  )

  it.instance("inherits the parent BYOK model and variant in a child session", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined

      const result = yield* def.execute(
        {
          description: "verify implementation",
          prompt: "inspect the implementation and report any issues",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: stubOps({ onPrompt: (input) => (seen = input) }),
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.parentSessionId).toBe(chat.id)
      expect(result.metadata.sessionId).not.toBe(chat.id)
      expect(result.metadata.model).toEqual({ ...ref, variant: "xhigh" })
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
      expect(seen?.model).toEqual(ref)
      expect(seen?.variant).toBe("xhigh")
      expect(seen?.agent).toBe("general")
    }),
  )

  it.instance("passes ownership and success criteria into the child assignment", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined

      const result = yield* def.execute(
        {
          description: "build auth flow",
          prompt: "Implement the requested authentication flow.",
          subagent_type: "general",
          owned_paths: ["./src/auth/", "src/auth"],
          success_criteria: ["Auth tests pass", "No secrets are logged"],
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.ownedPaths).toEqual(["src/auth"])
      expect(result.metadata.successCriteria).toEqual(["Auth tests pass", "No secrets are logged"])
      const assignment = seen?.parts.find((part) => part.type === "text")
      expect(assignment?.type === "text" ? assignment.text : "").toContain("You own only these repository paths")
      expect(assignment?.type === "text" ? assignment.text : "").toContain("Auth tests pass")
    }),
  )

  background.instance("waits for declared dependencies before starting a subagent", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const dependency = "task-foundation"

      yield* jobs.start({
        id: dependency,
        type: "task",
        title: "Build foundation",
        metadata: { parentSessionId: chat.id },
        run: Effect.succeed("foundation ready"),
      })

      const result = yield* def.execute(
        {
          description: "integrate feature",
          prompt: "Integrate the feature after its foundation is ready.",
          subagent_type: "general",
          depends_on: [dependency],
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.dependsOn).toEqual([dependency])
      expect(result.output).toContain('state="completed"')
    }),
  )

  background.instance("registers a dependent background task before its dependency finishes", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const dependencyDone = yield* Deferred.make<void>()
      let prompted = false

      yield* jobs.start({
        id: "task-foundation-running",
        type: "task",
        title: "Build foundation",
        metadata: { parentSessionId: chat.id },
        run: Deferred.await(dependencyDone).pipe(Effect.as("foundation ready")),
      })

      const result = yield* def.execute(
        {
          description: "integrate feature",
          prompt: "Integrate the feature after its foundation is ready.",
          subagent_type: "general",
          depends_on: ["task-foundation-running"],
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: stubOps({
              onPrompt: () => {
                prompted = true
              },
            }),
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.background).toBe(true)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
      expect(prompted).toBe(false)

      yield* Deferred.succeed(dependencyDone, undefined)
      expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.status).toBe("completed")
      expect(prompted).toBe(true)
    }),
  )

  background.instance("allows sequential ownership when the active owner is a declared dependency", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const dependencyDone = yield* Deferred.make<void>()

      const upstream = yield* def.execute(
        {
          description: "edit auth module",
          prompt: "Refactor the authentication module.",
          subagent_type: "general",
          owned_paths: ["src/auth"],
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: (input: SessionPrompt.PromptInput) =>
                Deferred.await(dependencyDone).pipe(Effect.as(reply(input, "auth ready"))),
            },
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const downstream = yield* def.execute(
        {
          description: "finish login view",
          prompt: "Finish the login view after the auth module is ready.",
          subagent_type: "general",
          depends_on: [upstream.metadata.sessionId],
          owned_paths: ["src/auth/login.tsx"],
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(downstream.metadata.dependsOn).toEqual([upstream.metadata.sessionId])
      expect(downstream.output).toContain('state="running"')
      yield* Deferred.succeed(dependencyDone, undefined)
    }),
  )

  background.instance("rejects dependencies from another parent session", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const first = yield* seed("First")
      const second = yield* seed("Second")
      const tool = yield* TaskTool
      const def = yield* tool.init()

      yield* jobs.start({
        id: "task-other-parent",
        type: "task",
        title: "Other work",
        metadata: { parentSessionId: first.chat.id },
        run: Effect.succeed("done"),
      })

      const exit = yield* Effect.exit(
        def.execute(
          {
            description: "reuse foreign task",
            prompt: "Depend on work from another task.",
            subagent_type: "general",
            depends_on: ["task-other-parent"],
          },
          {
            sessionID: second.chat.id,
            messageID: second.assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        ),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("does not belong")
    }),
  )

  background.instance("rejects owned paths outside the repository", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const exit = yield* Effect.exit(
        def.execute(
          {
            description: "edit outside repo",
            prompt: "Edit a file outside the repository.",
            subagent_type: "general",
            owned_paths: ["../secrets"],
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        ),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("cannot leave the repository")
    }),
  )

  background.instance("rejects overlapping ownership across active sibling subagents", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      yield* def.execute(
        {
          description: "edit auth module",
          prompt: "Refactor the authentication module.",
          subagent_type: "general",
          owned_paths: ["src/auth"],
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: { ...stubOps(), prompt: () => Effect.never } },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const exit = yield* Effect.exit(
        def.execute(
          {
            description: "edit login view",
            prompt: "Update the login view.",
            subagent_type: "general",
            owned_paths: ["src/auth/login.tsx"],
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        ),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("ownership overlaps")
    }),
  )

  it.instance("native specialists use the same child-session and BYOK inheritance path", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      for (const subagent of ["review", "judge", "debug", "test", "security", "performance", "migration"] as const) {
        let seen: SessionPrompt.PromptInput | undefined
        const result = yield* def.execute(
          {
            description: `${subagent} implementation`,
            prompt: `Perform a focused ${subagent} pass and report the result`,
            subagent_type: subagent,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: stubOps({ onPrompt: (input) => (seen = input) }),
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(result.metadata.parentSessionId).toBe(chat.id)
        expect(result.metadata.sessionId).not.toBe(chat.id)
        expect(result.metadata.model).toEqual({ ...ref, variant: "xhigh" })
        expect(seen?.sessionID).toBe(result.metadata.sessionId)
        expect(seen?.model).toEqual(ref)
        expect(seen?.variant).toBe("xhigh")
        expect(seen?.agent).toBe(subagent)
      }
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`<task id="${result.metadata.sessionId}" state="completed">`)
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        expect(child.permission).toEqual([
          {
            permission: "todowrite",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "bash",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "read",
            pattern: "*",
            action: "deny",
          },
        ])
        expect(seen?.tools).toBeUndefined()
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  it.instance("rejects background execution when the experiment is disabled", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("promotes a running foreground task without restarting it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      let runs = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Effect.gen(function* () {
            runs += 1
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(done)
            return reply(input, "background done")
          })
        },
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      const job = (yield* jobs.list())[0]
      expect(job).toBeDefined()
      if (!job) throw new Error("task job not found")
      expect(job.metadata?.parentSessionId).toBe(chat.id)
      yield* jobs.promote(job.id)

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
      expect(runs).toBe(1)

      yield* Deferred.succeed(done, undefined)
      expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.output).toBe("background done")
      expect((yield* Deferred.await(injected)).parts[0]?.type).toBe("text")
      expect(runs).toBe(1)
    }),
  )

  background.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  background.instance("launches a seventeenth background subagent and says how many are running", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const launch = (index: number) =>
        def.execute(
          {
            description: `inspect ${index}`,
            prompt: `look at area ${index}`,
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: {
                ...stubOps(),
                prompt: () => Effect.never,
              } satisfies TaskPromptOps,
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

      for (let index = 1; index < 17; index++) yield* launch(index)
      const result = yield* launch(17)

      expect(result.output).toContain(`state="running"`)
      expect(result.output).toContain("17 subagents are now running")
    }),
  )

  background.instance("background task completion waits for running updates", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      const updated = defer<SessionPrompt.PromptInput>()
      const injected = defer<SessionPrompt.PromptInput>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            injected.resolve(input)
            return Effect.succeed(reply(input, "done"))
          }
          prompts++
          if (prompts === 1) return Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
          updated.resolve(input)
          return Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      const result = yield* def.execute(
        {
          description: "add investigation scope",
          prompt: "also inspect cancellation",
          subagent_type: "general",
          task_id: started.metadata.sessionId,
        },
        context,
      )

      expect(result.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("Background task updated")
      first.resolve()
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
      expect((yield* Effect.promise(() => updated.promise)).parts).toEqual([
        { type: "text", text: "also inspect cancellation" },
      ])

      second.resolve()
      const waited = yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("second done")
      const notification = yield* Effect.promise(() => injected.promise)
      expect(notification.variant).toBe("xhigh")
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("second done")
    }),
  )

  background.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  background.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.sessionID === chat.id ? Effect.never : Effect.succeed(reply(input, "background done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  background.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* runState.cancel(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a child run cancels its own pre-runner task job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })

      yield* runState.cancel(child.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("an omitted subagent_type launches the general Subagent with its prompt", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined

      const result = yield* def.execute(
        { description: "map auth", prompt: "Map the auth middleware and report its entry points." },
        taskContext({
          sessionID: chat.id,
          messageID: assistant.id,
          promptOps: stubOps({ onPrompt: (input) => (seen = input) }),
        }),
      )

      expect(seen?.agent).toBe("general")
      expect(seen?.system).toContain("You are a Vector Subagent")
      expect(result.metadata).toMatchObject({ agent: "general", kind: "subagent", custom: false })
    }),
  )

  it.instance("the general Subagent prompt is passed only to general", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined

      const result = yield* def.execute(
        { description: "find handlers", prompt: "Find the HTTP handlers.", subagent_type: "explore" },
        taskContext({
          sessionID: chat.id,
          messageID: assistant.id,
          promptOps: stubOps({ onPrompt: (input) => (seen = input) }),
        }),
      )

      expect(seen?.agent).toBe("explore")
      expect(seen?.system).toBeUndefined()
      expect(result.metadata).toMatchObject({ agent: "explore", kind: "specialist", custom: false })
    }),
  )

  it.instance("general-purpose is an alias for the general Subagent", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      let seen: SessionPrompt.PromptInput | undefined

      yield* def.execute(
        { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general-purpose" },
        {
          ...taskContext({
            sessionID: chat.id,
            messageID: assistant.id,
            promptOps: stubOps({ onPrompt: (input) => (seen = input) }),
          }),
          ask: (input) =>
            Effect.sync(() => {
              calls.push(input)
            }),
        },
      )

      expect(seen?.agent).toBe("general")
      expect(calls[0]).toMatchObject({ permission: "task", patterns: ["general"] })
    }),
  )

  it.instance(
    "a user agent named general-purpose is not shadowed by the alias",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined

        const result = yield* def.execute(
          { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general-purpose" },
          taskContext({
            sessionID: chat.id,
            messageID: assistant.id,
            promptOps: stubOps({ onPrompt: (input) => (seen = input) }),
          }),
        )

        expect(seen?.agent).toBe("general-purpose")
        expect(seen?.system).toBeUndefined()
        expect(result.metadata).toMatchObject({ agent: "general-purpose", kind: "specialist", custom: true })
      }),
    {
      config: {
        agent: {
          "general-purpose": {
            description: "A user agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("records the lifecycle on the child session and the task part", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        { description: "  inspect \n bug ", prompt: "look into the cache key path", subagent_type: "general" },
        taskContext({ sessionID: chat.id, messageID: assistant.id, callID: "call_inspect", promptOps: stubOps() }),
      )

      const child = yield* sessions.get(result.metadata.sessionId)
      const record = child.metadata?.subagent
      expect(child.title).toBe("inspect bug (@general subagent)")
      expect(record).toMatchObject({
        kind: "subagent",
        agent: "general",
        custom: false,
        title: "inspect bug",
        parentSessionID: chat.id,
        parentMessageID: assistant.id,
        callID: "call_inspect",
        model: { ...ref, variant: "xhigh" },
        background: false,
        status: "completed",
        usage: { cost: 0, total: 0, toolUses: 0, steps: 0 },
      })
      expect(typeof record.startedAt).toBe("number")
      expect(record.completedAt).toBeGreaterThanOrEqual(record.startedAt)
      expect(result.metadata).toMatchObject({
        kind: "subagent",
        agent: "general",
        title: "inspect bug",
        callID: "call_inspect",
        parentMessageId: assistant.id,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        status: "completed",
        model: { ...ref, variant: "xhigh" },
      })
    }),
  )

  background.instance("a subagent with depends_on stays queued until its dependency completes", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const dependencyDone = yield* Deferred.make<void>()
      const prompted = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      yield* jobs.start({
        id: "task-foundation-queued",
        type: "task",
        title: "Build foundation",
        metadata: { parentSessionId: chat.id },
        run: Deferred.await(dependencyDone).pipe(Effect.as("foundation ready")),
      })

      const result = yield* def.execute(
        {
          description: "integrate feature",
          prompt: "Integrate the feature after its foundation is ready.",
          depends_on: ["task-foundation-queued"],
          background: true,
        },
        taskContext({
          sessionID: chat.id,
          messageID: assistant.id,
          promptOps: {
            ...stubOps(),
            prompt: (input) =>
              Deferred.succeed(prompted, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(reply(input, "integrated")),
              ),
          },
        }),
      )
      const status = () =>
        sessions.get(result.metadata.sessionId).pipe(Effect.map((child) => child.metadata?.subagent?.status))

      expect(result.metadata.status).toBe("queued")
      expect(yield* status()).toBe("queued")

      yield* Deferred.succeed(dependencyDone, undefined)
      yield* awaitWithTimeout(Deferred.await(prompted), "the dependent subagent never started")
      expect(yield* status()).toBe("running")

      yield* Deferred.succeed(release, undefined)
      yield* pollWithTimeout(
        status().pipe(Effect.map((value) => (value === "completed" ? value : undefined))),
        "the child record never completed",
      )
    }),
  )

  background.instance("a background completion patches the parent task part and the child record", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const callID = "call_background"
      const release = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      const part = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: chat.id,
        type: "tool",
        callID,
        tool: "task",
        state: { status: "running", input: {}, time: { start: Date.now() } },
      } satisfies SessionV1.ToolPart)
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id)
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "noted")))
          return Effect.gen(function* () {
            yield* Deferred.await(release)
            yield* spend(sessions, input.sessionID)
            return reply(input, "background done")
          })
        },
      }

      const result = yield* def.execute(
        { description: "survey logging", prompt: "Survey the logging calls.", background: true },
        taskContext({ sessionID: chat.id, messageID: assistant.id, callID, promptOps }),
      )
      expect(result.metadata.status).toBe("running")

      // What the processor does once the tool call returns.
      yield* sessions.updatePart({
        ...part,
        state: {
          status: "completed",
          input: {},
          output: result.output,
          title: result.title,
          metadata: result.metadata,
          time: { start: part.state.time.start, end: Date.now() },
        },
      } satisfies SessionV1.ToolPart)
      yield* Deferred.succeed(release, undefined)

      const settled = yield* pollWithTimeout(
        sessions.messages({ sessionID: chat.id }).pipe(
          Effect.map((messages) => {
            const found = messages
              .flatMap((message) => message.parts)
              .find((item) => item.type === "tool" && item.callID === callID)
            if (found?.type !== "tool" || found.state.status !== "completed") return undefined
            return found.state.metadata.status === "completed" ? found.state.metadata : undefined
          }),
        ),
        "the task part never settled",
      )
      expect(settled).toMatchObject({
        sessionId: result.metadata.sessionId,
        jobId: result.metadata.sessionId,
        background: true,
        title: "survey logging",
        usage: childUsage,
      })
      expect(settled.completedAt).toBeGreaterThanOrEqual(settled.startedAt)
      expect((yield* sessions.get(result.metadata.sessionId)).metadata?.subagent).toMatchObject({
        status: "completed",
        background: true,
        usage: childUsage,
      })
      const notification = yield* awaitWithTimeout(Deferred.await(injected), "no completion notice")
      expect(notification.noReply).toBeUndefined()
      expect(notification.parts[0]?.type === "text" ? notification.parts[0].text : "").toContain("background done")
    }),
  )

  background.instance("a cancelled background subagent leaves a note without starting a parent turn", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()

      const result = yield* def.execute(
        { description: "long survey", prompt: "Survey everything.", background: true },
        taskContext({
          sessionID: chat.id,
          messageID: assistant.id,
          promptOps: {
            ...stubOps(),
            prompt: (input) =>
              input.sessionID === chat.id
                ? Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "noted")))
                : Effect.never,
          },
        }),
      )
      yield* jobs.cancel(result.metadata.sessionId)

      const note = yield* awaitWithTimeout(Deferred.await(injected), "no cancelled note")
      const text = note.parts[0]?.type === "text" ? note.parts[0].text : ""
      expect(note.noReply).toBe(true)
      expect(text).toContain('state="cancelled"')
      expect(text).toContain("Background task cancelled: long survey")
      expect((yield* sessions.get(result.metadata.sessionId)).metadata?.subagent?.status).toBe("cancelled")
    }),
  )

  it.instance("task calls in one message run at the same time", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const gate = yield* Deferred.make<void>()
      let started = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          Effect.sync(() => {
            started += 1
          }).pipe(Effect.andThen(Deferred.await(gate)), Effect.as(reply(input, "surveyed"))),
      }
      const launch = (area: string) =>
        def.execute(
          { description: `survey ${area}`, prompt: `Survey the ${area} package.` },
          taskContext({ sessionID: chat.id, messageID: assistant.id, callID: `call_${area}`, promptOps }),
        )

      const fiber = yield* Effect.all([launch("api"), launch("web")], { concurrency: "unbounded" }).pipe(
        Effect.forkChild,
      )
      yield* pollWithTimeout(
        Effect.sync(() => (started === 2 ? true : undefined)),
        "both subagents should start before either finishes",
      )
      yield* Deferred.succeed(gate, undefined)

      const results = yield* Fiber.join(fiber)
      expect(results.map((item) => item.metadata.status)).toEqual(["completed", "completed"])
      expect(new Set(results.map((item) => item.metadata.sessionId)).size).toBe(2)
    }),
  )

  background.instance("a foreground launch past six running siblings says how many were running", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      for (let index = 1; index <= 6; index++) {
        yield* def.execute(
          { description: `inspect ${index}`, prompt: `look at area ${index}`, background: true },
          taskContext({
            sessionID: chat.id,
            messageID: assistant.id,
            promptOps: { ...stubOps(), prompt: () => Effect.never },
          }),
        )
      }
      const result = yield* def.execute(
        { description: "inspect 7", prompt: "look at area 7" },
        taskContext({ sessionID: chat.id, messageID: assistant.id, promptOps: stubOps() }),
      )

      expect(result.output).toContain('state="completed"')
      expect(result.output).toContain("7 subagents were running for this task when this one started")
    }),
  )
})
