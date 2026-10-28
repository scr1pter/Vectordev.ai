import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { TaskManager } from "@/task/manager"
import { DesktopTasks } from "@/task/desktop"
import { TaskBridge } from "@vectordevai/schema/task-bridge"
import type { Task } from "@vectordevai/schema/task"
import type { TaskPromptOps } from "@/tool/task"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { SessionID } from "@/session/schema"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Worktree } from "@/worktree"
import { Effect, Option, Schema } from "effect"
import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { freeModelMayTrain, FREE_MODEL_TRAINING_OWNER_ONLY } from "@vectordevai/core/free-model-choice"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  SessionListQuery,
  SessionStopInput,
  TaskBackgroundInput,
  ToolListQuery,
  WorktreeApiError,
  TaskApiError,
  TaskListQuery,
  TaskMessageInput,
  TaskResumeInput,
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

type TaskResult = { readonly task?: Task.Info; readonly tasks?: readonly Task.Info[] }

// A task result without any helper's absolute isolation directory.
function withoutDirectories<T extends TaskResult>(result: T): T {
  const hide = (task: Task.Info): Task.Info =>
    task.isolation?.directory === undefined
      ? task
      : { ...task, isolation: SubagentLifecycle.withoutDirectory(task.isolation) }
  return {
    ...result,
    ...(result.task ? { task: hide(result.task) } : {}),
    ...(result.tasks ? { tasks: result.tasks.map(hide) } : {}),
  }
}

export const experimentalHandlers = HttpApiBuilder.group(InstanceHttpApi, "experimental", (handlers) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const mcp = yield* MCP.Service
    const project = yield* Project.Service
    const registry = yield* ToolRegistry.Service
    const worktreeSvc = yield* Worktree.Service
    const sessions = yield* Session.Service
    const flags = yield* RuntimeFlags.Service
    const tasks = yield* TaskManager.Service
    const desktop = yield* DesktopTasks.Service
    const prompts = yield* SessionPrompt.Service
    // The server provides it to every handler; a test that builds these handlers alone may leave it out.
    const provider = yield* Effect.serviceOption(Provider.Service)
    const taskPrompts: TaskPromptOps = {
      cancel: prompts.cancel,
      resolvePromptParts: prompts.resolvePromptParts,
      prompt: (input) => prompts.prompt(input).pipe(Effect.orDie),
    }
    // A guest's work must not reach a free model that may train through the owner's acceptance.
    const guestPrompts: TaskPromptOps = {
      ...taskPrompts,
      prompt: (input) => prompts.prompt(input, { refuseTrainingFreeModels: true }).pipe(Effect.orDie),
    }

    const access = Effect.fn("ExperimentalHttpApi.taskAccess")(function* (sessionID: SessionID, control = false) {
      const principal = yield* RequestPrincipal
      // Workspace visibility does not grant control over another participant's workers.
      if (control ? allowsSession(principal, sessionID) : yield* allowsSessionID(sessions, principal, sessionID)) return
      return yield* new ForbiddenError({ message: "This session's tasks are outside your authorized sessions" })
    })
    const taskError = <A, R>(effect: Effect.Effect<A, TaskManager.Error, R>) =>
      effect.pipe(Effect.mapError((error) => new TaskApiError({ code: error.code, message: error.message })))
    // A helper's absolute isolation directory goes only to the owner or a principal in control of the session (I19).
    const shown = <T extends TaskResult>(sessionID: SessionID, result: T) =>
      Effect.map(RequestPrincipal, (principal) => (allowsSession(principal, sessionID) ? result : withoutDirectories(result)))

    const taskList = Effect.fn("ExperimentalHttpApi.taskList")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof TaskListQuery.Type
    }) {
      yield* access(ctx.params.sessionID)
      const result = yield* taskError(
        tasks.list({
          sessionID: ctx.params.sessionID,
          descendants: ctx.query.descendants,
          limit: ctx.query.limit,
          active: ctx.query.active,
        }),
      )
      // The limits line carries the owner's configured limits, which only the owner sees (I19).
      const { limits, ...rest } = result
      const owner = (yield* RequestPrincipal).kind === "owner"
      return yield* shown(ctx.params.sessionID, owner && limits ? { ...rest, limits } : rest)
    })

    const taskInspect = Effect.fn("ExperimentalHttpApi.taskInspect")(function* (ctx: {
      params: { sessionID: SessionID; taskID: string }
    }) {
      yield* access(ctx.params.sessionID)
      return yield* shown(ctx.params.sessionID, yield* taskError(tasks.inspect(ctx.params)))
    })

    const taskMessage = Effect.fn("ExperimentalHttpApi.taskMessage")(function* (ctx: {
      params: { sessionID: SessionID; taskID: string }
      payload: typeof TaskMessageInput.Type
    }) {
      yield* access(ctx.params.sessionID, true)
      const guest = (yield* RequestPrincipal).kind !== "owner"
      return yield* taskError(tasks.message({ ...ctx.params, ...ctx.payload }, guest ? guestPrompts : taskPrompts))
    })

    // Resume (D.3): the user continues stopped, failed or interrupted helpers. A guest's resume runs under the guest
    // limits and budget, and is refused at once for a helper on a free model that may train.
    const taskResume = Effect.fn("ExperimentalHttpApi.taskResume")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof TaskResumeInput.Type
    }) {
      yield* access(ctx.params.sessionID, true)
      const guest = (yield* RequestPrincipal).kind !== "owner"
      if (guest && Option.isSome(provider))
        for (const taskID of new Set(ctx.payload.taskIDs)) {
          const id = Schema.decodeUnknownOption(SessionID)(taskID)
          const record = Option.isNone(id)
            ? undefined
            : yield* sessions.get(id.value).pipe(
                Effect.map(SubagentLifecycle.read),
                Effect.catchCause(() => Effect.succeed(undefined)),
              )
          const model =
            record &&
            (yield* provider.value
              .getModel(ProviderV2.ID.make(record.model.providerID), ModelV2.ID.make(record.model.modelID))
              .pipe(Effect.catchCause(() => Effect.succeed(undefined))))
          if (model && freeModelMayTrain(model))
            return yield* new TaskApiError({ code: "forbidden", message: FREE_MODEL_TRAINING_OWNER_ONLY })
        }
      return yield* shown(
        ctx.params.sessionID,
        yield* taskError(
          tasks.resume(
            { sessionID: ctx.params.sessionID, ...ctx.payload, origin: "user", guest },
            guest ? guestPrompts : taskPrompts,
          ),
        ),
      )
    })

    const taskStop = Effect.fn("ExperimentalHttpApi.taskStop")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof TaskStopInput.Type
    }) {
      yield* access(ctx.params.sessionID, true)
      return yield* shown(
        ctx.params.sessionID,
        yield* taskError(tasks.stop({ ...ctx.params, ...ctx.payload, origin: "user" }, taskPrompts)),
      )
    })

    // "Stop including helpers" (5.D.1). Plain abort stays as it was, so revert, undo and halt never stop helpers.
    const sessionStop = Effect.fn("ExperimentalHttpApi.sessionStop")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SessionStopInput.Type
    }) {
      yield* access(ctx.params.sessionID, true)
      return yield* shown(
        ctx.params.sessionID,
        yield* taskError(tasks.interrupt({ sessionID: ctx.params.sessionID, ...ctx.payload }, taskPrompts)),
      )
    })

    // Move to background (5.D.2): the session's running foreground subagents, or the selected ones.
    const taskBackground = Effect.fn("ExperimentalHttpApi.taskBackground")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: void | typeof TaskBackgroundInput.Type
    }) {
      yield* access(ctx.params.sessionID, true)
      return yield* shown(
        ctx.params.sessionID,
        yield* taskError(tasks.promote({ sessionID: ctx.params.sessionID, taskIDs: ctx.payload?.taskIDs })),
      )
    })

    const taskWait = Effect.fn("ExperimentalHttpApi.taskWait")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof TaskWaitInput.Type
    }) {
      yield* access(ctx.params.sessionID)
      return yield* shown(ctx.params.sessionID, yield* taskError(tasks.wait({ ...ctx.params, ...ctx.payload })))
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
      return {
        backgroundSubagents: flags.backgroundSubagents,
        subagentLimits: true,
        workDelegation: true,
        sessionStop: true,
        taskPromote: true,
        taskResume: true,
        taskAttention: true,
      }
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
      yield* access(ctx.params.sessionID, true)
      // The older form of the task background route: whether anything moved, and false for a session it cannot reach.
      const result = yield* tasks
        .promote({ sessionID: ctx.params.sessionID })
        .pipe(Effect.catchTag("TaskManager.Error", () => Effect.succeed({ tasks: [] })))
      return result.tasks.length > 0
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
      .handle("sessionStop", sessionStop)
      .handle("taskList", taskList)
      .handle("taskInspect", taskInspect)
      .handle("taskMessage", taskMessage)
      .handle("taskStop", taskStop)
      .handle("taskWait", taskWait)
      .handle("taskBackground", taskBackground)
      .handle("taskResume", taskResume)
      .handle("taskBridgeRegister", taskBridgeRegister)
      .handle("taskBridgePoll", taskBridgePoll)
      .handle("taskBridgeReceipt", taskBridgeReceipt)
      .handle("resource", resource)
  }),
)
