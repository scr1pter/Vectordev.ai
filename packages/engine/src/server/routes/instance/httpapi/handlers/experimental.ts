import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { TaskManager } from "@/task/manager"
import { DesktopTasks } from "@/task/desktop"
import { TaskBridge } from "@vectordevai/schema/task-bridge"
import type { TaskPromptOps } from "@/tool/task"
import type { SessionID } from "@/session/schema"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Worktree } from "@/worktree"
import { Effect, Option } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  SessionListQuery,
  ToolListQuery,
  WorktreeApiError,
  TaskApiError,
  TaskListQuery,
  TaskMessageInput,
  TaskStopInput,
  TaskWaitInput,
} from "../groups/experimental"
import { RequestPrincipal, allowsSession } from "@vectordevai/protocol/middleware/authorization"
import { ForbiddenError } from "@vectordevai/protocol/errors"
import { allowsSessionID } from "./session-access"

function mapWorktreeError<A, R>(self: Effect.Effect<A, Worktree.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => new WorktreeApiError({ name: error._tag, data: { message: error.message } })),
  )
}

export const experimentalHandlers = HttpApiBuilder.group(InstanceHttpApi, "experimental", (handlers) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const mcp = yield* MCP.Service
    const project = yield* Project.Service
    const registry = yield* ToolRegistry.Service
    const worktreeSvc = yield* Worktree.Service
    const sessions = yield* Session.Service
    const background = yield* BackgroundJob.Service
    const flags = yield* RuntimeFlags.Service
    const tasks = yield* TaskManager.Service
    const desktop = yield* DesktopTasks.Service
    const prompts = yield* SessionPrompt.Service
    const taskPrompts: TaskPromptOps = {
      cancel: prompts.cancel,
      resolvePromptParts: prompts.resolvePromptParts,
      prompt: (input) => prompts.prompt(input).pipe(Effect.orDie),
    }

    const access = Effect.fn("ExperimentalHttpApi.taskAccess")(function* (sessionID: SessionID, control = false) {
      const principal = yield* RequestPrincipal
      // Workspace visibility does not grant control over another participant's workers.
      if (control ? allowsSession(principal, sessionID) : yield* allowsSessionID(sessions, principal, sessionID)) return
      return yield* new ForbiddenError({ message: "This session's tasks are outside your authorized sessions" })
    })
    const taskError = <A, R>(effect: Effect.Effect<A, TaskManager.Error, R>) =>
      effect.pipe(Effect.mapError((error) => new TaskApiError({ code: error.code, message: error.message })))

    const taskList = Effect.fn("ExperimentalHttpApi.taskList")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof TaskListQuery.Type
    }) {
      yield* access(ctx.params.sessionID)
      return yield* taskError(
        tasks.list({ sessionID: ctx.params.sessionID, descendants: ctx.query.descendants, limit: ctx.query.limit }),
      )
    })

    const taskInspect = Effect.fn("ExperimentalHttpApi.taskInspect")(function* (ctx: {
      params: { sessionID: SessionID; taskID: string }
    }) {
      yield* access(ctx.params.sessionID)
      return yield* taskError(tasks.inspect(ctx.params))
    })

    const taskMessage = Effect.fn("ExperimentalHttpApi.taskMessage")(function* (ctx: {
      params: { sessionID: SessionID; taskID: string }
      payload: typeof TaskMessageInput.Type
    }) {
      yield* access(ctx.params.sessionID, true)
      // A guest's message to a worker must not reach a free model that may train through the owner's acceptance.
      const guest = (yield* RequestPrincipal).kind !== "owner"
      return yield* taskError(
        tasks.message(
          { ...ctx.params, ...ctx.payload },
          guest
            ? {
                ...taskPrompts,
                prompt: (input) => prompts.prompt(input, { refuseTrainingFreeModels: true }).pipe(Effect.orDie),
              }
            : taskPrompts,
        ),
      )
    })

    const taskStop = Effect.fn("ExperimentalHttpApi.taskStop")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof TaskStopInput.Type
    }) {
      yield* access(ctx.params.sessionID, true)
      return yield* taskError(tasks.stop({ ...ctx.params, ...ctx.payload }, taskPrompts))
    })

    const taskWait = Effect.fn("ExperimentalHttpApi.taskWait")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof TaskWaitInput.Type
    }) {
      yield* access(ctx.params.sessionID)
      return yield* taskError(tasks.wait({ ...ctx.params, ...ctx.payload }))
    })

    const owner = Effect.gen(function* () {
      if ((yield* RequestPrincipal).kind !== "owner")
        return yield* new ForbiddenError({
          message: "Desktop task connections require the authenticated server owner.",
        })
    })
    const taskBridgeRegister = Effect.fn("ExperimentalHttpApi.taskBridgeRegister")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof TaskBridge.RegisterInput.Type
    }) {
      yield* owner
      return yield* desktop
        .register({ ...ctx.params, ...ctx.payload })
        .pipe(Effect.mapError((error) => new TaskApiError({ code: error.code, message: error.message })))
    })
    const taskBridgePoll = Effect.fn("ExperimentalHttpApi.taskBridgePoll")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof TaskBridge.PollInput.Type
    }) {
      yield* owner
      return yield* desktop
        .poll({ ...ctx.params, ...ctx.payload })
        .pipe(Effect.mapError((error) => new TaskApiError({ code: error.code, message: error.message })))
    })
    const taskBridgeReceipt = Effect.fn("ExperimentalHttpApi.taskBridgeReceipt")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof TaskBridge.ReceiptInput.Type
    }) {
      yield* owner
      return yield* desktop
        .receipt({ ...ctx.params, ...ctx.payload })
        .pipe(Effect.mapError((error) => new TaskApiError({ code: error.code, message: error.message })))
    })

    const capabilities = Effect.fn("ExperimentalHttpApi.capabilities")(function* () {
      return { backgroundSubagents: flags.backgroundSubagents }
    })

    const tool = Effect.fn("ExperimentalHttpApi.tool")(function* (ctx: { query: typeof ToolListQuery.Type }) {
      const list = yield* registry.tools({
        providerID: ctx.query.provider,
        modelID: ctx.query.model,
        agent: yield* agents.defaultInfo(),
      })
      return list.map((item) => ({
        id: item.id,
        description: item.description,
        parameters: ToolJsonSchema.fromTool(item),
      }))
    })

    const toolIDs = Effect.fn("ExperimentalHttpApi.toolIDs")(function* () {
      return yield* registry.ids()
    })

    const worktree = Effect.fn("ExperimentalHttpApi.worktree")(function* () {
      const ctx = yield* InstanceState.context
      return yield* project.sandboxes(ctx.project.id)
    })

    const worktreeCreate = Effect.fn("ExperimentalHttpApi.worktreeCreate")(function* (ctx: {
      payload: typeof Worktree.CreateInput.Type | void
    }) {
      return yield* mapWorktreeError(worktreeSvc.create(ctx.payload ?? undefined))
    })

    const worktreeRemove = Effect.fn("ExperimentalHttpApi.worktreeRemove")(function* (input: {
      payload: Worktree.RemoveInput
    }) {
      const ctx = yield* InstanceState.context
      yield* mapWorktreeError(worktreeSvc.remove(input.payload))
      yield* project.removeSandbox(ctx.project.id, input.payload.directory)
      return true
    })

    const worktreeReset = Effect.fn("ExperimentalHttpApi.worktreeReset")(function* (ctx: {
      payload: Worktree.ResetInput
    }) {
      yield* mapWorktreeError(worktreeSvc.reset(ctx.payload))
      return true
    })

    const session = Effect.fn("ExperimentalHttpApi.session")(function* (ctx: { query: typeof SessionListQuery.Type }) {
      const limit = ctx.query.limit ?? 100
      // This list spans every project on the server; a guest's is narrowed to the workspace it was invited to, where
      // the routing already placed this request.
      const scoped = ctx.query.directory || (yield* RequestPrincipal).kind !== "owner"
      const directory = scoped ? yield* InstanceState.directory : undefined
      const all = yield* sessions.listGlobal({
        directory,
        roots: ctx.query.roots,
        internal: ctx.query.internal,
        start: ctx.query.start,
        cursor: ctx.query.cursor,
        search: ctx.query.search,
        limit: limit + 1,
        archived: ctx.query.archived,
      })
      const list = all.length > limit ? all.slice(0, limit) : all
      return HttpServerResponse.jsonUnsafe(list, {
        headers:
          all.length > limit && list.length > 0
            ? { "x-next-cursor": String(list[list.length - 1].time.updated) }
            : undefined,
      })
    })

    const sessionUsage = Effect.fn("ExperimentalHttpApi.sessionUsage")(function* () {
      // The owner's usage spans every project; a guest sees only the workspace it was invited to, as with the list.
      if ((yield* RequestPrincipal).kind === "owner") return yield* sessions.usage()
      return yield* sessions.usage({ directory: yield* InstanceState.directory })
    })

    const sessionBackground = Effect.fn("ExperimentalHttpApi.sessionBackground")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      if (!flags.backgroundSubagents) return false
      // A subagent's own tasks stay in the foreground, as the task tool keeps them: a background result would start a
      // turn of the subagent after its run ended, which no one reads and stopping the root cannot reach.
      const session = yield* sessions.get(ctx.params.sessionID).pipe(Effect.option)
      if (Option.isNone(session) || session.value.parentID) return false
      const jobs = (yield* background.list()).filter(
        (job) =>
          job.type === "task" &&
          job.status === "running" &&
          job.metadata?.parentSessionId === ctx.params.sessionID &&
          job.metadata.background !== true,
      )
      const promoted = yield* Effect.forEach(jobs, (job) => background.promote(job.id), { concurrency: "unbounded" })
      return promoted.some((job) => job !== undefined)
    })

    const resource = Effect.fn("ExperimentalHttpApi.resource")(function* () {
      return yield* mcp.resources()
    })

    return handlers
      .handle("capabilities", capabilities)
      .handle("tool", tool)
      .handle("toolIDs", toolIDs)
      .handle("worktree", worktree)
      .handle("worktreeCreate", worktreeCreate)
      .handle("worktreeRemove", worktreeRemove)
      .handle("worktreeReset", worktreeReset)
      .handle("session", session)
      .handle("sessionUsage", sessionUsage)
      .handle("sessionBackground", sessionBackground)
      .handle("taskList", taskList)
      .handle("taskInspect", taskInspect)
      .handle("taskMessage", taskMessage)
      .handle("taskStop", taskStop)
      .handle("taskWait", taskWait)
      .handle("taskBridgeRegister", taskBridgeRegister)
      .handle("taskBridgePoll", taskBridgePoll)
      .handle("taskBridgeReceipt", taskBridgeReceipt)
      .handle("resource", resource)
  }),
)
