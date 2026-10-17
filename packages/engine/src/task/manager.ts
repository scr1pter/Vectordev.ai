import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { eq, sql } from "drizzle-orm"
import { Task } from "@vectordevai/schema/task"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Database } from "@vectordevai/core/database/database"
import { PartTable } from "@vectordevai/core/session/sql"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionID, MessageID } from "@/session/schema"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import type { TaskPromptOps } from "@/tool/task"
import { TaskMailbox } from "@vectordevai/core/task-mailbox"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"

export class Error extends Schema.TaggedErrorClass<Error>()("TaskManager.Error", {
  code: Schema.Literals(["not_found", "forbidden", "invalid", "finished", "rate_limited"]),
  message: Schema.String,
}) {}

export interface Interface {
  readonly list: (input: { sessionID: SessionID; descendants?: boolean; limit?: number }) => Effect.Effect<Task.ListResult, Error>
  readonly inspect: (input: { sessionID: SessionID; taskID: string }) => Effect.Effect<Task.InspectResult, Error>
  readonly message: (input: { sessionID: SessionID; taskID: string; text: string; delivery?: "steer" | "queue" }, ops: TaskPromptOps) => Effect.Effect<Task.MessageResult, Error>
  readonly stop: (input: { sessionID: SessionID; taskIDs?: readonly string[]; all?: boolean; reason?: string }, ops: TaskPromptOps) => Effect.Effect<Task.StopResult, Error>
  readonly wait: (input: { sessionID: SessionID; taskIDs: readonly string[]; mode?: "any" | "all"; timeout?: number }) => Effect.Effect<Task.WaitResult, Error>
}

export class Service extends Context.Service<Service, Interface>()("@vector/TaskManager") {}

const ACTIVE = new Set<Task.Status>(["queued", "running", "waiting_on_user"])
const MAX_TASKS = 200
const OUTPUT_LIMIT = 4096

const layer = Layer.effect(Service, Effect.gen(function* () {
  const sessions = yield* Session.Service
  const jobs = yield* BackgroundJob.Service
  const statuses = yield* SessionStatus.Service
  const permissions = yield* Permission.Service
  const questions = yield* Question.Service
  const database = yield* Database.Service
  const lock = Semaphore.makeUnsafe(1)
  const get = (id: SessionID) => sessions.get(id).pipe(Effect.mapError(() => new Error({ code: "not_found", message: "Task session was not found." })))

  const requireTask = Effect.fn("TaskManager.requireTask")(function* (sessionID: SessionID, taskID: string, peer = false) {
    const requester = yield* get(sessionID)
    const task = yield* get(SessionID.make(taskID))
    if (task.internal || !SubagentLifecycle.read(task)) return yield* new Error({ code: "not_found", message: "This session is not a visible delegated task." })
    if (peer && requester.parentID && requester.parentID === task.parentID && SubagentLifecycle.read(requester)) return task
    const seen = new Set<string>([task.id])
    let parentID = task.parentID
    while (parentID && seen.size <= MAX_TASKS) {
      if (parentID === sessionID) return task
      if (seen.has(parentID)) break
      seen.add(parentID)
      parentID = (yield* get(parentID)).parentID
    }
    return yield* new Error({ code: "forbidden", message: "The task does not belong to this session's descendants." })
  })

  const observe = Effect.fn("TaskManager.observe")(function* (initial: Session.Info): Effect.fn.Return<Task.Info, Error> {
    const record = SubagentLifecycle.read(initial)!
    const job = yield* jobs.get(initial.id)
    const live = (yield* statuses.get(initial.id)).type !== "idle"
    const abandoned = !job && !live && (record.status === "running" || record.status === "queued") && record.runtimeID !== SubagentLifecycle.RUNTIME_ID
    if (abandoned) yield* SubagentLifecycle.update(sessions, initial.id, {
      status: "cancelled", completedAt: Date.now(), reason: "Engine restarted; partial work was retained. Resume explicitly to continue.",
    }, record.attempt)
    const session = abandoned ? yield* get(initial.id) : initial
    const current = SubagentLifecycle.read(session)!
    const pending = [...yield* permissions.list(), ...yield* questions.list()].some((item) => item.sessionID === session.id)
    const status: Task.Status = abandoned || current.status === "cancelled" || job?.status === "cancelled"
      ? "stopped"
      : current.status === "error" || job?.status === "error"
        ? "failed"
        : current.status === "completed" || job?.status === "completed"
          ? "completed"
          : pending ? "waiting_on_user" : current.status === "queued" ? "queued" : "running"
    const recent = yield* sessions.messages({ sessionID: session.id, limit: 4 }).pipe(Effect.orDie)
    const tool = recent.flatMap((message) => message.parts).findLast((part) => part.type === "tool")
    const counts = yield* database.db.select({
      tools: sql<number>`coalesce(sum(case when json_extract(${PartTable.data}, '$.type') = 'tool' then 1 else 0 end), 0)`,
      steps: sql<number>`coalesce(sum(case when json_extract(${PartTable.data}, '$.type') = 'step-finish' then 1 else 0 end), 0)`,
    }).from(PartTable).where(eq(PartTable.session_id, session.id)).get().pipe(Effect.orDie)
    const tokens = session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    const completedAt = current.completedAt ?? job?.completed_at
    return {
      id: session.id, sessionID: session.id, parentSessionID: session.parentID!, source: "subagent",
      title: current.title, agent: current.agent, status, batchID: current.batchID,
      startedAt: current.startedAt, completedAt, elapsedMs: Math.max(0, (completedAt ?? Date.now()) - current.startedAt),
      currentStep: pending ? "Waiting for your answer or permission" : tool?.type === "tool" ? tool.state.status === "running" ? tool.state.title ?? tool.tool : tool.tool : undefined,
      lastTool: tool?.type === "tool" ? tool.tool : undefined,
      usage: { cost: session.cost ?? 0, tokens, total: tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write, toolUses: Number(counts?.tools ?? 0), steps: Number(counts?.steps ?? 0), unpricedSteps: session.unpricedSteps },
      ownedPaths: current.ownedPaths ?? [], dependsOn: current.dependsOn ?? [],
      resultAvailable: Boolean(current.resultRef || job?.output || recent.some((message) => message.info.role === "assistant" && message.parts.some((part) => part.type === "text" && !part.synthetic && part.text))),
      resultRef: current.resultRef ?? `session:${session.id}`, reason: current.reason ?? current.error ?? job?.error,
      attempt: current.attempt ?? 1, budget: current.budget,
      controls: { inspect: true, message: ACTIVE.has(status) && job?.status === "running", stop: ACTIVE.has(status) },
    }
  })

  const list: Interface["list"] = Effect.fn("TaskManager.list")(function* (input) {
    yield* get(input.sessionID)
    const limit = Math.min(MAX_TASKS, Math.max(1, Math.floor(input.limit ?? 100)))
    const queue = [input.sessionID]
    const seen = new Set<string>(queue)
    const found: Session.Info[] = []
    while (queue.length && found.length <= limit) {
      const children = (yield* sessions.children(queue.shift()!)).filter((item) => !item.internal && SubagentLifecycle.read(item))
      for (const child of children) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        found.push(child)
        if (input.descendants) queue.push(child.id)
      }
      if (!input.descendants) break
    }
    return { tasks: yield* Effect.forEach(found.slice(0, limit), observe, { concurrency: 4 }), truncated: found.length > limit || queue.length > 0 }
  })

  const inspect: Interface["inspect"] = Effect.fn("TaskManager.inspect")(function* (input) {
    const session = yield* requireTask(input.sessionID, input.taskID)
    const task = yield* observe(session)
    const messages = yield* sessions.messages({ sessionID: session.id, limit: 8 }).pipe(Effect.orDie)
    const parts = messages.flatMap((message) => message.parts)
    const steps = parts.flatMap((part) => part.type === "tool" ? [{ tool: part.tool, status: part.state.status, text: (part.state.status === "running" || part.state.status === "completed" ? part.state.title ?? part.tool : part.tool).slice(0, 240) }] : []).slice(-8)
    const text = parts.flatMap((part) => part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []).join("\n\n")
    return { task, steps, output: text.slice(-OUTPUT_LIMIT), truncated: messages.length >= 8 || text.length > OUTPUT_LIMIT || parts.filter((part) => part.type === "tool").length > 8 }
  })

  const message: Interface["message"] = Effect.fn("TaskManager.message")((input, ops) => lock.withPermits(1)(Effect.gen(function* () {
    const text = input.text.trim()
    const invalid = TaskMailbox.bodyError(text)
    if (invalid) return yield* new Error({ code: "invalid", message: invalid })
    const session = yield* requireTask(input.sessionID, input.taskID, true)
    const record = SubagentLifecycle.read(session)!
    if ((yield* jobs.get(session.id))?.status !== "running") return yield* new Error({ code: "finished", message: "The task has finished; no message was sent and no new run was started." })
    const now = Date.now()
    const mailbox = record.mailbox ?? []
    const limited = TaskMailbox.admissionError({ text, sentAt: mailbox.filter((item) => item.sender === input.sessionID).map((item) => item.createdAt), pending: mailbox.filter((item) => !item.deliveredAt).length, now })
    if (limited) return yield* new Error({ code: "rate_limited", message: limited })
    const entry = { id: MessageID.ascending(), sender: input.sessionID, text, delivery: input.delivery ?? "steer" as const, createdAt: now }
    yield* SubagentLifecycle.update(sessions, session.id, { mailbox: [...mailbox.filter((item) => !item.deliveredAt || item.createdAt > now - 60_000), entry] }, record.attempt)
    const accepted = yield* jobs.extend({
      id: session.id,
      concurrent: entry.delivery === "steer" && record.status !== "queued" && (yield* statuses.get(session.id)).type !== "idle",
      run: Effect.gen(function* () {
        const current = yield* get(session.id)
        const value = SubagentLifecycle.read(current)!
        if (value.attempt !== record.attempt) return ""
        yield* SubagentLifecycle.update(sessions, session.id, { mailbox: (value.mailbox ?? []).map((item) => item.id === entry.id ? { ...item, deliveredAt: Date.now() } : item) }, record.attempt)
        const result = yield* ops.prompt({
          sessionID: session.id, messageID: entry.id, agent: record.agent,
          model: { providerID: ProviderV2.ID.make(record.model.providerID), modelID: ModelV2.ID.make(record.model.modelID) }, variant: record.model.variant,
          parts: [{ type: "text", synthetic: true, text: TaskMailbox.envelope(text, { sender: input.sessionID, recipient: session.id }) }],
        })
        return result.parts.flatMap((part) => part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []).join("\n\n")
      }).pipe(Effect.onInterrupt(() => ops.cancel(session.id))),
    })
    if (!accepted) {
      yield* SubagentLifecycle.update(sessions, session.id, { mailbox }, record.attempt)
      return yield* new Error({ code: "finished", message: "The task finished during admission; no message was sent." })
    }
    return { taskID: session.id, messageID: entry.id, delivery: entry.delivery, accepted: true }
  })))

  const select = Effect.fn("TaskManager.select")(function* (sessionID: SessionID, ids: readonly string[]) {
    if (ids.length === 0 || ids.length > MAX_TASKS) return yield* new Error({ code: "invalid", message: "Choose 1–200 task IDs." })
    return yield* Effect.forEach([...new Set(ids)], (id) => requireTask(sessionID, id))
  })

  const stop: Interface["stop"] = Effect.fn("TaskManager.stop")(function* (input, ops) {
    if (input.all && input.taskIDs?.length) return yield* new Error({ code: "invalid", message: "Choose task IDs or all, not both." })
    if (input.reason && input.reason.length > 1000) return yield* new Error({ code: "invalid", message: "Stop reasons are limited to 1000 characters." })
    const board = yield* list({ sessionID: input.sessionID, descendants: true, limit: MAX_TASKS })
    if (board.truncated) return yield* new Error({ code: "invalid", message: "Too many descendants to stop atomically; select a narrower parent session." })
    const selected = input.all ? board.tasks.map((task) => task.id) : input.taskIDs ?? []
    if (input.all && selected.length === 0) return { tasks: [] }
    yield* select(input.sessionID, selected)
    const ids = new Set(selected)
    let changed = true
    while (changed) {
      changed = false
      board.tasks.forEach((task) => {
        if (ids.has(task.id) || (!ids.has(task.parentSessionID) && !task.dependsOn.some((id) => ids.has(id)))) return
        ids.add(task.id)
        changed = true
      })
    }
    const tasks = yield* Effect.forEach([...ids], (id) => requireTask(input.sessionID, id))
    yield* Effect.forEach(tasks, (task) => Effect.gen(function* () {
      if (!ACTIVE.has((yield* observe(task)).status)) return
      yield* SubagentLifecycle.update(sessions, task.id, { reason: input.reason?.trim() || "Stopped by the parent session; partial work was retained." }, SubagentLifecycle.read(task)?.attempt)
      yield* jobs.cancel(task.id)
      yield* ops.cancel(task.id)
      yield* SubagentLifecycle.settle(sessions, task.id, { status: "cancelled" })
    }), { concurrency: 4 })
    return { tasks: yield* Effect.forEach(tasks, (task) => get(task.id).pipe(Effect.flatMap(observe)), { concurrency: 4 }) }
  })

  const wait: Interface["wait"] = Effect.fn("TaskManager.wait")(function* (input) {
    if (!Number.isFinite(input.timeout ?? 30_000) || (input.timeout ?? 30_000) < 0 || (input.timeout ?? 30_000) > 60_000) return yield* new Error({ code: "invalid", message: "Wait timeout must be between 0 and 60000 milliseconds." })
    const selected = yield* select(input.sessionID, input.taskIDs)
    const before = yield* Effect.forEach(selected, observe, { concurrency: 4 })
    const settled = input.mode === "all" ? before.every((task) => !ACTIVE.has(task.status)) : before.some((task) => !ACTIVE.has(task.status))
    if (settled) return { tasks: before, timedOut: false }
    const waits = before.filter((task) => ACTIVE.has(task.status)).map((task) => jobs.wait({ id: task.id }).pipe(Effect.asVoid))
    const done = yield* (input.mode === "all" ? Effect.all(waits, { concurrency: "unbounded", discard: true }) : Effect.raceAll(waits)).pipe(Effect.timeoutOption(input.timeout ?? 30_000))
    return { tasks: yield* Effect.forEach(selected, (task) => get(task.id).pipe(Effect.flatMap(observe)), { concurrency: 4 }), timedOut: done._tag === "None" }
  })

  return Service.of({ list, inspect, message, stop, wait })
}))

export const node = LayerNode.make({ service: Service, layer, deps: [Session.node, BackgroundJob.node, SessionStatus.node, Permission.node, Question.node, Database.node] })
export * as TaskManager from "./manager"
