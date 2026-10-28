import { Context, Effect, Layer, Option, Schema } from "effect"
import { eq, sql } from "drizzle-orm"
import { Task } from "@vectordevai/schema/task"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Database } from "@vectordevai/core/database/database"
import { PartTable } from "@vectordevai/core/session/sql"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionID, MessageID } from "@/session/schema"
import { SessionTaskSize } from "@/session/task-size"
import type { SubagentRecord } from "@/agent/subagent-kind"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import type { TaskPromptOps } from "@/tool/task"
import { TaskMailbox } from "@vectordevai/core/task-mailbox"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { ModelV2 } from "@vectordevai/core/model"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { Config } from "@/config/config"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { InstanceState } from "@/effect/instance-state"
import { disposing } from "@/effect/instance-registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { DesktopTasks } from "./desktop"
import { TaskLimits } from "./limits"
import { TaskNotify } from "./notify"

export class Error extends Schema.TaggedErrorClass<Error>()("TaskManager.Error", {
  code: Schema.Literals([
    "not_found",
    "forbidden",
    "invalid",
    "finished",
    "rate_limited",
    "limit",
    "conflict",
    "running",
  ]),
  message: Schema.String,
}) {}

export interface Interface {
  readonly list: (input: {
    sessionID: SessionID
    descendants?: boolean
    limit?: number
    /** Only work in flight: finished children are walked through but never listed (5.D.1). */
    active?: boolean
  }) => Effect.Effect<Task.ListResult, Error>
  readonly inspect: (input: { sessionID: SessionID; taskID: string }) => Effect.Effect<Task.InspectResult, Error>
  readonly message: (
    input: { sessionID: SessionID; taskID: string; text: string; delivery?: "steer" | "queue" },
    ops: TaskPromptOps,
  ) => Effect.Effect<Task.MessageResult, Error>
  readonly stop: (
    input: {
      sessionID: SessionID
      taskIDs?: readonly string[]
      all?: boolean
      reason?: string
      /** Who stopped them, recorded as `stop.by` (default "agent"). */
      origin?: "agent" | "user"
    },
    ops: TaskPromptOps,
  ) => Effect.Effect<Task.StopResult, Error>
  /** Stops the session's main turn and, with `helpers`, every subagent working under it (5.D.1). */
  readonly interrupt: (
    input: { sessionID: SessionID; helpers: boolean; reason?: string },
    ops: TaskPromptOps,
  ) => Effect.Effect<Task.SessionStopResult, Error>
  /** Moves a root session's running foreground subagents, batch entries included, to the background (5.D.2). */
  readonly promote: (input: {
    sessionID: SessionID
    taskIDs?: readonly string[]
  }) => Effect.Effect<Task.PromoteResult, Error>
  /**
   * Continues stopped, failed or interrupted children of a root session in the background, each in a new attempt (D.3).
   * A completed child continues only from the user, with `text`.
   */
  readonly resume: (
    input: {
      sessionID: SessionID
      taskIDs: readonly string[]
      text?: string
      origin: "agent" | "user"
      /** A guest asked: the guest limits and budget apply. */
      guest: boolean
    },
    ops: TaskPromptOps,
  ) => Effect.Effect<Task.ResumeResult, Error>
  readonly wait: (input: {
    sessionID: SessionID
    taskIDs: readonly string[]
    mode?: "any" | "all"
    timeout?: number
  }) => Effect.Effect<Task.WaitResult, Error>
}

export class Service extends Context.Service<Service, Interface>()("@vector/TaskManager") {}

const ACTIVE = new Set<string>(["queued", "running", "waiting_on_user"])
const MAX_TASKS = 200
// Sessions the active board walks, finished ones included, before it calls itself truncated.
const MAX_VISITED = 2000
// "Stop including helpers" sweeps the board once, then again while a sweep still found work to stop (a grandchild
// launched mid-sweep), at most this many times in all.
const SWEEPS = 4
const STOP_REASON = "Stopped by the parent session; partial work was retained."
const INTERRUPT_REASON = "Stopped with the main agent; partial work was kept."
const OUTPUT_LIMIT = 4096
// The most children one resume call continues.
const MAX_RESUME = 32
// Research agents (Agent.RESEARCH, RESEARCHER and RESEARCH_JUDGE) start from a checked brief, which a resume would skip.
const RESEARCH_AGENTS = new Set(["research", "researcher", "research-judge"])
const overlaps = (a: string, b: string) =>
  a === "." || b === "." || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
// A record whose engine is gone, found before TaskRecovery reported it: why it stopped is unknown (D.3).
const abandon = (at: number) => ({
  status: "cancelled" as const,
  completedAt: at,
  reason: "Engine restarted; partial work was retained. Resume explicitly to continue.",
  interruption: { at, cause: "unknown" as const },
})
const recentActiveFirst = (left: { status: string; startedAt: number }, right: { status: string; startedAt: number }) =>
  Number(ACTIVE.has(right.status)) - Number(ACTIVE.has(left.status)) || right.startedAt - left.startedAt

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const jobs = yield* BackgroundJob.Service
    const statuses = yield* SessionStatus.Service
    const permissions = yield* Permission.Service
    const questions = yield* Question.Service
    const database = yield* Database.Service
    const guard = yield* SpendGuard.Service
    const desktop = yield* DesktopTasks.Service
    const limits = yield* TaskLimits.Service
    const config = yield* Config.Service
    const guests = yield* FreeModelGuests.Service
    const store = yield* BackgroundJobStore.Service
    const notify = yield* TaskNotify.Service
    const flags = yield* RuntimeFlags.Service
    const bridge = <A>(effect: Effect.Effect<A, DesktopTasks.Error>) =>
      effect.pipe(Effect.mapError((error) => new Error({ code: error.code, message: error.message })))
    const lock = SubagentLifecycle.controlLock
    const get = (id: SessionID) =>
      sessions
        .get(id)
        .pipe(Effect.mapError(() => new Error({ code: "not_found", message: "Task session was not found." })))
    const persist = (sessionID: SessionID, patch: Parameters<typeof SubagentLifecycle.write>[2], attempt?: number) =>
      SubagentLifecycle.write(sessions, sessionID, patch, attempt).pipe(
        Effect.mapError(
          () => new Error({ code: "not_found", message: "Task disappeared before its state could be saved." }),
        ),
      )

    const requireTask = Effect.fn("TaskManager.requireTask")(function* (
      sessionID: SessionID,
      taskID: string,
      peer = false,
    ) {
      const requester = yield* get(sessionID)
      const parsed = Schema.decodeUnknownOption(SessionID)(taskID)
      if (parsed._tag === "None")
        return yield* new Error({ code: "invalid", message: "Task IDs must be valid session identifiers." })
      const task = yield* get(parsed.value)
      if (task.internal || !SubagentLifecycle.read(task))
        return yield* new Error({ code: "not_found", message: "This session is not a visible delegated task." })
      if (peer && requester.parentID && requester.parentID === task.parentID && SubagentLifecycle.read(requester))
        return task
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

    // A workflow run whose engine is gone leaves its own running or queued agents behind with it (D.3). Inert until
    // runs exist (WP31).
    const cascade = Effect.fn("TaskManager.cascade")(function* (runID: SessionID, at: number) {
      yield* Effect.forEach(
        yield* sessions.children(runID),
        (agent) =>
          Effect.gen(function* () {
            const record = SubagentLifecycle.read(agent)
            if (record?.workflow?.role !== "agent" || !SubagentLifecycle.open(record)) return
            if ((yield* jobs.get(agent.id)) || (yield* SubagentLifecycle.liveness(store, agent.id, record)) !== "dead")
              return
            yield* SubagentLifecycle.update(sessions, agent.id, abandon(at), record.attempt)
          }),
        { concurrency: 4, discard: true },
      )
    })

    // Move to background (5.D.2) and resume (D.3) are offered only for a direct child of a root session: a subagent's own
    // children stay in its run, since their reports would start a turn of the subagent after that run ended. Resume is
    // offered for a finished child that started, so the user can continue it.
    const offers = Effect.fn("TaskManager.offers")(function* (
      session: Session.Info,
      record: SubagentRecord,
      job: BackgroundJob.Info | undefined,
      status: Task.Status,
      started: boolean,
    ) {
      if (!flags.backgroundSubagents || SubagentLifecycle.stopping.has(session.id) || !session.parentID) return {}
      const background = ACTIVE.has(status) && job?.status === "running" && job.metadata?.background !== true
      const resume =
        !ACTIVE.has(status) &&
        job?.status !== "running" &&
        started &&
        !RESEARCH_AGENTS.has(record.agent) &&
        record.interruption?.dismissedAt === undefined
      if (!background && !resume) return {}
      const parent = yield* sessions.get(session.parentID).pipe(Effect.option)
      if (Option.isNone(parent) || parent.value.parentID) return {}
      return background ? { background: true } : { resume: true }
    })

    const observe = Effect.fn("TaskManager.observe")(function* (
      initial: Session.Info,
    ): Effect.fn.Return<Task.Info, Error> {
      const record = SubagentLifecycle.read(initial)!
      const job = yield* jobs.get(initial.id)
      const live = (yield* statuses.get(initial.id)).type !== "idle"
      const abandoned =
        !job &&
        !live &&
        SubagentLifecycle.open(record) &&
        (yield* SubagentLifecycle.liveness(store, initial.id, record)) === "dead"
      if (abandoned) {
        const at = Date.now()
        yield* SubagentLifecycle.update(sessions, initial.id, abandon(at), record.attempt)
        if (record.workflow?.role === "run") yield* cascade(initial.id, at)
      }
      const session = abandoned ? yield* get(initial.id) : initial
      const current = SubagentLifecycle.read(session)!
      const pending = [...(yield* permissions.list()), ...(yield* questions.list())].some(
        (item) => item.sessionID === session.id,
      )
      const status: Task.Status =
        abandoned || current.status === "cancelled" || job?.status === "cancelled" || job?.status === "interrupted"
          ? "stopped"
          : current.status === "error" || job?.status === "error"
            ? "failed"
            : current.status === "completed" || job?.status === "completed"
              ? "completed"
              : pending
                ? "waiting_on_user"
                : current.status === "queued"
                  ? "queued"
                  : "running"
      const recent = yield* sessions.messages({ sessionID: session.id, limit: 4 }).pipe(Effect.orDie)
      const tool = recent.flatMap((message) => message.parts).findLast((part) => part.type === "tool")
      const counts = yield* database.db
        .select({
          tools: sql<number>`coalesce(sum(case when json_extract(${PartTable.data}, '$.type') = 'tool' then 1 else 0 end), 0)`,
          steps: sql<number>`coalesce(sum(case when json_extract(${PartTable.data}, '$.type') = 'step-finish' then 1 else 0 end), 0)`,
        })
        .from(PartTable)
        .where(eq(PartTable.session_id, session.id))
        .get()
        .pipe(Effect.orDie)
      const tokens = session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      const completedAt = current.completedAt ?? job?.completed_at
      return {
        id: session.id,
        sessionID: session.id,
        parentSessionID: session.parentID!,
        source: "subagent",
        title: current.title.slice(0, 240),
        agent: current.agent,
        status,
        batchID: current.batchID,
        startedAt: current.startedAt,
        completedAt,
        elapsedMs: Math.max(0, (completedAt ?? Date.now()) - current.startedAt),
        currentStep: pending
          ? "Waiting for your answer or permission"
          : tool?.type === "tool"
            ? tool.state.status === "running"
              ? (tool.state.title ?? tool.tool).slice(0, 240)
              : tool.tool.slice(0, 240)
            : undefined,
        lastTool: tool?.type === "tool" ? tool.tool : undefined,
        usage: {
          cost: session.cost ?? 0,
          tokens,
          total: tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write,
          toolUses: Number(counts?.tools ?? 0),
          steps: Number(counts?.steps ?? 0),
          unpricedSteps: session.unpricedSteps,
        },
        ownedPaths: current.ownedPaths ?? [],
        dependsOn: current.dependsOn ?? [],
        resultAvailable: Boolean(
          current.resultRef ||
            job?.output ||
            recent.some(
              (message) =>
                message.info.role === "assistant" &&
                message.parts.some((part) => part.type === "text" && !part.synthetic && part.text),
            ),
        ),
        resultRef: current.resultRef ?? `session:${session.id}`,
        reason: (current.reason ?? current.error ?? job?.error)?.slice(0, 1000),
        attempt: current.attempt ?? 1,
        budget: current.budget,
        budgetScopes: ACTIVE.has(status)
          ? SubagentLifecycle.scopeFields(yield* guard.scopes(session.id)).budgetScopes
          : current.budgetScopes,
        controls: {
          inspect: true,
          message: ACTIVE.has(status) && job?.status === "running" && !SubagentLifecycle.stopping.has(session.id),
          stop: ACTIVE.has(status) && !SubagentLifecycle.stopping.has(session.id),
          ...(yield* offers(session, current, job, status, recent.length > 0)),
        },
        ...(current.interruption
          ? {
              interrupted: SubagentLifecycle.defined({
                at: current.interruption.at,
                cause: current.interruption.cause,
                reported: current.interruption.reportedAt !== undefined,
                resumedAt: current.interruption.resumedAt,
                dismissedAt: current.interruption.dismissedAt,
              }) as Task.Interrupted,
            }
          : {}),
      }
    })

    // The conversation's subagent limits as `session` sees them (5.B.10): its root's pool, and the request its launches
    // count in. For a root that is the request its prompt loop counts launches in now, so a new request with no
    // launches shows none started, while a message that joined the running request keeps that request's count; a
    // Parallel Workspace or Swarm root shows its conversation's request, which its launches count in (5.B.1).
    const limitsOf = Effect.fn("TaskManager.limits")(function* (session: Session.Info) {
      let root = session
      const seen = new Set<string>([root.id])
      while (root.parentID && !seen.has(root.parentID) && seen.size <= MAX_TASKS) {
        seen.add(root.parentID)
        const parent = yield* sessions.get(root.parentID).pipe(Effect.option)
        if (Option.isNone(parent)) break
        root = parent.value
      }
      const guest = yield* guests.marked(root.id)
      const conversationID = yield* TaskLimits.conversationOf(sessions, root, guest)
      const status = yield* limits.status(
        conversationID,
        SubagentLifecycle.read(session)?.requestID ??
          (yield* TaskLimits.requestFor(limits, sessions, SessionID.make(conversationID))),
        TaskLimits.resolve(yield* config.get(), guest),
      )
      return {
        running: status.running,
        queued: status.queued,
        maxRunning: status.limit,
        launched: status.launched,
        maxPerRequest: status.perRequest,
        ...(status.spend ? { spend: status.spend } : {}),
      } satisfies Task.Limits
    })

    const list: Interface["list"] = Effect.fn("TaskManager.list")(function* (input) {
      const session = yield* get(input.sessionID)
      const result = yield* collect(input)
      // The board never fails for want of its limits line.
      const counted = yield* limitsOf(session).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("TaskManager.list: reading the subagent limits failed", { cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      )
      return counted ? { ...result, limits: counted } : result
    })

    const collect = Effect.fn("TaskManager.collect")(function* (input: Parameters<Interface["list"]>[0]) {
      yield* get(input.sessionID)
      const limit = Math.min(MAX_TASKS, Math.max(1, Math.floor(input.limit ?? 100)))
      const queue = [input.sessionID]
      const seen = new Set<string>(queue)
      const found: Session.Info[] = []
      // The active board lists only open records (abandoned ones too, so observe settles them), yet walks under every
      // child, finished or not, until its own budget of sessions runs out: finished children never crowd it out.
      while (queue.length && (input.active ? seen.size <= MAX_VISITED : found.length <= MAX_TASKS)) {
        const children = (yield* sessions.children(queue.shift()!))
          .filter((item) => !item.internal && SubagentLifecycle.read(item))
          .sort((left, right) => recentActiveFirst(SubagentLifecycle.read(left)!, SubagentLifecycle.read(right)!))
        for (const child of children) {
          if (seen.has(child.id)) continue
          seen.add(child.id)
          if (!input.active || SubagentLifecycle.open(SubagentLifecycle.read(child))) found.push(child)
          if (input.descendants) queue.push(child.id)
        }
        if (!input.descendants) break
      }
      const native = yield* Effect.forEach(
        found
          .sort((left, right) => recentActiveFirst(SubagentLifecycle.read(left)!, SubagentLifecycle.read(right)!))
          .slice(0, limit),
        observe,
        { concurrency: 4 },
      )
      const external = yield* bridge(desktop.list(input))
      // A desktop workspace can expose the same native child session; retain its
      // richer source identity and controls, counting cumulative usage only once.
      const mirrored = new Set(external.tasks.flatMap((task) => (task.sessionID ? [task.sessionID] : [])))
      const rows = input.active ? external.tasks.filter((task) => ACTIVE.has(task.status)) : external.tasks
      const tasks = [
        ...native.filter((task) => !mirrored.has(task.id) && (!input.active || ACTIVE.has(task.status))),
        ...rows.map((task) => {
          const session = native.find((entry) => entry.id === task.sessionID)
          return session ? { ...task, usage: session.usage, budgetScopes: session.budgetScopes } : task
        }),
      ].sort(recentActiveFirst)
      return {
        tasks: tasks.slice(0, limit),
        // A desktop listing cut short matters to the active board only while it returned live rows.
        truncated:
          tasks.length > limit ||
          (external.truncated && (!input.active || rows.length > 0)) ||
          found.length > limit ||
          queue.length > 0,
      }
    })

    const inspect: Interface["inspect"] = Effect.fn("TaskManager.inspect")(function* (input) {
      if (DesktopTasks.owns(input.taskID)) return yield* bridge(desktop.inspect(input))
      const session = yield* requireTask(input.sessionID, input.taskID)
      const task = yield* observe(session)
      const messages = yield* sessions.messages({ sessionID: session.id, limit: 8 }).pipe(Effect.orDie)
      const parts = messages.flatMap((message) => message.parts)
      const steps = parts
        .flatMap((part) =>
          part.type === "tool"
            ? [
                {
                  tool: part.tool,
                  status: part.state.status,
                  text: (part.state.status === "running" || part.state.status === "completed"
                    ? (part.state.title ?? part.tool)
                    : part.tool
                  ).slice(0, 240),
                },
              ]
            : [],
        )
        .slice(-8)
      const text = messages
        .filter((message) => message.info.role === "assistant")
        .flatMap((message) => message.parts)
        .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
        .join("\n\n")
      return {
        task,
        steps,
        output: text.slice(-OUTPUT_LIMIT),
        truncated:
          messages.length >= 8 || text.length > OUTPUT_LIMIT || parts.filter((part) => part.type === "tool").length > 8,
      }
    })

    const message: Interface["message"] = Effect.fn("TaskManager.message")(function* (input, ops) {
      const text = input.text.trim()
      const invalid = TaskMailbox.bodyError(text)
      if (invalid) return yield* new Error({ code: "invalid", message: invalid })
      if (DesktopTasks.owns(input.taskID)) return yield* bridge(desktop.message({ ...input, text }))
      return yield* SubagentLifecycle.locked(lock)(
        Effect.gen(function* () {
          const session = yield* requireTask(input.sessionID, input.taskID, true)
          if (SubagentLifecycle.stopping.has(session.id))
            return yield* new Error({ code: "finished", message: "This task is stopping; no message was sent." })
          const requester = yield* get(input.sessionID)
          const relation = requester.parentID && requester.parentID === session.parentID ? "peer" : "parent"
          const record = SubagentLifecycle.read(session)!
          if ((yield* jobs.get(session.id))?.status !== "running")
            return yield* new Error({
              code: "finished",
              message:
                "The task has finished; no message was sent and no new run was started. To continue it, call task with its task_id.",
            })
          const now = Date.now()
          const mailbox = record.mailbox ?? []
          const limited = TaskMailbox.admissionError({
            text,
            sentAt: mailbox.filter((item) => item.sender === input.sessionID).map((item) => item.createdAt),
            pending: mailbox.filter((item) => !item.deliveredAt).length,
            now,
          })
          if (limited) return yield* new Error({ code: "rate_limited", message: limited })
          const entry = {
            id: MessageID.ascending(),
            sender: input.sessionID,
            text,
            delivery: input.delivery ?? ("steer" as const),
            createdAt: now,
          }
          yield* persist(
            session.id,
            { mailbox: [...mailbox.filter((item) => !item.deliveredAt || item.createdAt > now - 60_000), entry] },
            record.attempt,
          )
          const delivery = Effect.gen(function* () {
            const current = yield* get(session.id)
            const value = SubagentLifecycle.read(current)!
            if (value.attempt !== record.attempt) return ""
            yield* persist(
              session.id,
              {
                mailbox: (value.mailbox ?? []).map((item) =>
                  item.id === entry.id ? { ...item, deliveredAt: Date.now() } : item,
                ),
                ...(value.slotReason === TaskLimits.SLOT_REASON
                  ? { status: "running" as const, slotReason: undefined }
                  : {}),
              },
              record.attempt,
            )
            const result = yield* ops.prompt({
              sessionID: session.id,
              messageID: entry.id,
              agent: record.agent,
              model: {
                providerID: ProviderV2.ID.make(record.model.providerID),
                modelID: ModelV2.ID.make(record.model.modelID),
              },
              variant: record.model.variant,
              parts: [
                {
                  type: "text",
                  synthetic: true,
                  text: TaskMailbox.envelope(text, { sender: input.sessionID, recipient: session.id, relation }),
                },
              ],
            })
            const failed = result.info.role === "assistant" ? SubagentLifecycle.failure(result.info.error) : undefined
            const output = result.parts
              .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
              .join("\n\n")
            if (failed?.status === "cancelled") return yield* Effect.interrupt
            if (failed) return yield* new BackgroundJob.RunFailed({ message: failed.error ?? "Task failed", output })
            return output
          }).pipe(Effect.onInterrupt(() => ops.cancel(session.id)))
          // A run that starts after the child's own ended takes a subagent slot again, waiting for one when every slot
          // is taken; one joining a running run shares its slot (5.B.3).
          const conversationID = record.conversationID
          const run = conversationID
            ? limits.run(
                {
                  conversationID,
                  childID: session.id,
                  origin:
                    record.workflow?.role === "agent"
                      ? "workflow"
                      : record.rootSessionID && session.parentID !== record.rootSessionID
                        ? "nested"
                        : "root",
                  waiting: persist(
                    session.id,
                    { status: "queued", slotReason: TaskLimits.SLOT_REASON },
                    record.attempt,
                  ).pipe(Effect.ignore),
                },
                delivery,
              )
            : delivery
          const accepted = yield* jobs.extend({
            id: session.id,
            concurrent:
              entry.delivery === "steer" &&
              record.status !== "queued" &&
              (yield* statuses.get(session.id)).type !== "idle",
            run,
          })
          if (!accepted) {
            yield* persist(session.id, { mailbox }, record.attempt)
            return yield* new Error({
              code: "finished",
              message: "The task finished during admission; no message was sent.",
            })
          }
          return { taskID: session.id, messageID: entry.id, delivery: entry.delivery, accepted: true as const }
        }),
      )
    })

    const select = Effect.fn("TaskManager.select")(function* (sessionID: SessionID, ids: readonly string[]) {
      if (ids.length === 0 || ids.length > MAX_TASKS)
        return yield* new Error({ code: "invalid", message: "Choose 1–200 task IDs." })
      return yield* Effect.forEach([...new Set(ids)], (id) =>
        DesktopTasks.owns(id)
          ? bridge(desktop.get({ sessionID, taskID: id }))
          : requireTask(sessionID, id).pipe(Effect.flatMap(observe)),
      )
    })

    // A row "Stop including helpers" reaches: a native subagent, never a desktop workspace or swarm (5.D.1).
    const helper = (task: Task.Info) => task.source === "subagent" && !DesktopTasks.owns(task.id)

    // Stops the selected tasks of the active board with their descendants and dependents, keeping partial work. With
    // `helpers`, only native subagents are selectable and reached. Returns the stopped tasks and the board it read.
    const halt = Effect.fn("TaskManager.halt")(function* (
      input: {
        sessionID: SessionID
        taskIDs?: readonly string[]
        all?: boolean
        reason?: string
        origin: "agent" | "user"
        helpers?: boolean
      },
      ops: TaskPromptOps,
    ) {
      const reason = input.reason?.trim() || (input.helpers ? INTERRUPT_REASON : STOP_REASON)
      const directory = yield* InstanceState.directory
      const claimed = new Set<SessionID>()
      return yield* Effect.gen(function* () {
        const prepared = yield* SubagentLifecycle.locked(lock)(
          Effect.gen(function* () {
            const board = yield* collect({
              sessionID: input.sessionID,
              descendants: true,
              active: true,
              limit: MAX_TASKS,
            })
            if (board.truncated)
              return yield* new Error({
                code: "invalid",
                message: "Too many descendants to stop atomically; select a narrower parent session.",
              })
            const reachable = input.helpers ? board.tasks.filter(helper) : board.tasks
            const selected = input.all ? reachable.map((task) => task.id) : (input.taskIDs ?? [])
            if (input.all && selected.length === 0) return { native: [], remote: [], board: board.tasks }
            yield* select(input.sessionID, selected)
            const ids = new Set(selected)
            let changed = true
            while (changed) {
              changed = false
              reachable.forEach((task) => {
                if (ids.has(task.id) || (!ids.has(task.parentSessionID) && !task.dependsOn.some((id) => ids.has(id))))
                  return
                ids.add(task.id)
                changed = true
              })
            }
            const tasks = yield* select(input.sessionID, [...ids])
            const native = yield* Effect.forEach(
              tasks.filter((task) => !DesktopTasks.owns(task.id)),
              (task) =>
                Effect.gen(function* () {
                  if (!ACTIVE.has(task.status) || !task.controls.stop) return { task }
                  const session = yield* requireTask(input.sessionID, task.id)
                  if (SubagentLifecycle.stopping.has(session.id)) return { task }
                  const attempt = SubagentLifecycle.read(session)?.attempt
                  SubagentLifecycle.stopping.add(session.id)
                  claimed.add(session.id)
                  yield* SubagentLifecycle.update(sessions, session.id, { reason }, attempt)
                  return { task, session, attempt }
                }),
              { concurrency: 4 },
            )
            return { native, remote: tasks.filter((task) => DesktopTasks.owns(task.id)), board: board.tasks }
          }),
        )
        const native = yield* Effect.forEach(
          prepared.native,
          (entry) =>
            Effect.gen(function* () {
              if (!("session" in entry) || !entry.session) return entry.task
              const session = entry.session
              yield* jobs.cancel(session.id)
              yield* ops.cancel(session.id)
              return yield* SubagentLifecycle.locked(lock)(
                Effect.gen(function* () {
                  SubagentLifecycle.stopping.delete(session.id)
                  claimed.delete(session.id)
                  const current = yield* get(session.id)
                  const record = SubagentLifecycle.read(current)
                  // While Vector goes away, TaskRecovery owns the record (D.3).
                  if (!record || record.attempt !== entry.attempt || disposing(directory))
                    return yield* observe(current)
                  const status = SubagentLifecycle.open(record)
                    ? (yield* SubagentLifecycle.settle(sessions, session.id, { status: "cancelled" })).status
                    : record.status
                  yield* persist(
                    session.id,
                    {
                      ...SubagentLifecycle.scopeFields(yield* guard.scopes(session.id)),
                      // Who stopped it, which decides whether resuming it waits for the user (D.3). A child that
                      // finished before the stop reached it was not stopped.
                      ...(status === "cancelled" ? { stop: { by: input.origin, at: Date.now() } } : {}),
                    },
                    entry.attempt,
                  )
                  yield* guard.release(session.id)
                  return yield* get(session.id).pipe(Effect.flatMap(observe))
                }),
              )
            }),
          { concurrency: 4 },
        )
        // A disconnected desktop must not hold the native launch/settlement lock.
        // Stopping a swarm coordinator already cancels its workers and dependencies.
        const roots = new Set(
          prepared.remote
            .filter(
              (task) =>
                task.groupID && task.id === `swarm:${task.groupID}` && ACTIVE.has(task.status) && task.controls.stop,
            )
            .map((task) => task.groupID),
        )
        const controls = prepared.remote.filter(
          (task) =>
            ACTIVE.has(task.status) &&
            task.controls.stop &&
            (!task.groupID || !roots.has(task.groupID) || task.id === `swarm:${task.groupID}`),
        )
        yield* Effect.forEach(
          controls,
          (task) => bridge(desktop.stop({ sessionID: input.sessionID, taskID: task.id, reason: input.reason })),
          { concurrency: 4 },
        )
        const remote = yield* Effect.forEach(prepared.remote, (task) =>
          bridge(desktop.get({ sessionID: input.sessionID, taskID: task.id })),
        )
        return { tasks: [...native, ...remote], board: prepared.board }
      }).pipe(Effect.ensuring(Effect.sync(() => claimed.forEach((id) => SubagentLifecycle.stopping.delete(id)))))
    })

    const stop: Interface["stop"] = Effect.fn("TaskManager.stop")(function* (input, ops) {
      if (input.all && input.taskIDs?.length)
        return yield* new Error({ code: "invalid", message: "Choose task IDs or all, not both." })
      if (input.reason && input.reason.length > 1000)
        return yield* new Error({ code: "invalid", message: "Stop reasons are limited to 1000 characters." })
      const { tasks } = yield* halt({ ...input, origin: input.origin ?? "agent" }, ops)
      return { tasks }
    })

    const interrupt: Interface["interrupt"] = Effect.fn("TaskManager.interrupt")(function* (input, ops) {
      if (input.reason && input.reason.length > 1000)
        return yield* new Error({ code: "invalid", message: "Stop reasons are limited to 1000 characters." })
      const session = yield* get(input.sessionID)
      // Fenced before anything stops: a helper that finishes meanwhile, or whose note is already held, is recorded
      // without starting a turn until the user writes again (I5).
      yield* notify.fence(session.id)
      const aborted = (yield* statuses.get(session.id)).type !== "idle"
      yield* ops.cancel(session.id)
      if (!input.helpers) return { aborted, tasks: [], shells: 0, excluded: 0, skipped: 0 }
      const stopped = new Map<string, Task.Info>()
      let board: readonly Task.Info[] = []
      for (let sweep = 0; sweep < SWEEPS; sweep++) {
        const result = yield* halt(
          { sessionID: session.id, all: true, reason: input.reason, origin: "user", helpers: true },
          ops,
        )
        board = result.board
        const fresh = result.tasks.filter((task) => !stopped.has(task.id))
        result.tasks.forEach((task) => stopped.set(task.id, task))
        // Background commands stop here too once they exist (WP33).
        if (fresh.length === 0) break
      }
      // Desktop workspaces and swarms keep their own runners and are left running; the ones Vector cannot reach
      // right now are counted apart.
      const left = board.filter((task) => !helper(task))
      return {
        aborted,
        tasks: [...stopped.values()],
        shells: 0,
        excluded: left.filter((task) => task.connection !== "disconnected").length,
        skipped: left.filter((task) => task.connection === "disconnected").length,
      }
    })

    // Move to background (5.D.2): each of a root session's running foreground subagents, a batch's entries included,
    // keeps running, the call that waited on it returns, and it reports later in its own note.
    const promote: Interface["promote"] = Effect.fn("TaskManager.promote")(function* (input) {
      if (input.taskIDs && (input.taskIDs.length === 0 || input.taskIDs.length > MAX_TASKS))
        return yield* new Error({ code: "invalid", message: "Choose 1–200 task IDs." })
      const session = yield* get(input.sessionID)
      if (session.parentID || !flags.backgroundSubagents) return { tasks: [] }
      const wanted = input.taskIDs && new Set(input.taskIDs)
      const foreground = (yield* jobs.list()).filter(
        (job) =>
          job.type === "task" &&
          job.status === "running" &&
          job.metadata?.parentSessionId === session.id &&
          job.metadata.background !== true &&
          (!wanted || wanted.has(job.id)),
      )
      const promoted = yield* Effect.forEach(foreground, (job) => jobs.promote(job.id), { concurrency: "unbounded" })
      const tasks = yield* Effect.forEach(
        promoted.flatMap((job) => (job?.metadata?.background === true ? [SessionID.make(job.id)] : [])),
        (id) =>
          get(id).pipe(
            Effect.flatMap((child) => (SubagentLifecycle.read(child) ? observe(child) : Effect.succeed(undefined))),
            Effect.catchTag("TaskManager.Error", () => Effect.succeed(undefined)),
          ),
        { concurrency: 4 },
      )
      return { tasks: tasks.filter((task) => task !== undefined) }
    })

    // Resume checks one child (D.3 checks 1 to 9): a direct child of the root, not running here or in another live
    // engine, finished as stopped or failed (completed only from the user, with a message), not a research agent, started,
    // not dismissed, its launch message kept, and for the agent, the user asked after it was interrupted or stopped.
    const resumable = Effect.fn("TaskManager.resumable")(function* (
      root: Session.Info,
      taskID: string,
      origin: "agent" | "user",
      text: string | undefined,
    ) {
      const found = yield* requireTask(root.id, taskID)
      if (found.parentID !== root.id)
        return yield* new Error({
          code: "invalid",
          message: "Only helpers the main agent launched resume this way; resume the helper that launched this one.",
        })
      // A record whose engine is gone is settled first, as the board settles it.
      yield* observe(found)
      const session = yield* get(found.id)
      const record = SubagentLifecycle.read(session)!
      const running = new Error({ code: "running", message: "This task is still running; send it a message instead." })
      if ((yield* jobs.get(session.id))?.status === "running" || SubagentLifecycle.stopping.has(session.id))
        return yield* running
      if (!SubagentLifecycle.ownedHere(record)) {
        const owner = yield* SubagentLifecycle.liveness(store, session.id, record)
        // The user is asked to confirm an owner Vector cannot reach; the agent never resumes one.
        if (owner === "alive" || (owner === "unknown" && origin === "agent"))
          return yield* new Error({
            code: "running",
            message:
              owner === "alive"
                ? "Another Vector process is still running this task."
                : "Another Vector process may still be running this task; ask the user before resuming it.",
          })
      }
      if (record.status === "completed" && origin === "agent")
        return yield* new Error({
          code: "finished",
          message: "This task completed; to give it more work, call task with its task_id and a new brief.",
        })
      if (record.status === "completed" && !text)
        return yield* new Error({ code: "invalid", message: "A completed task continues only with a message." })
      if (SubagentLifecycle.open(record)) return yield* running
      if (RESEARCH_AGENTS.has(record.agent))
        return yield* new Error({ code: "invalid", message: "A research agent cannot be resumed; start a new one." })
      if (Option.isNone(yield* sessions.findMessage(session.id, SessionTaskSize.real).pipe(Effect.orDie)))
        return yield* new Error({ code: "invalid", message: "This task never started; relaunch it with task." })
      if (record.interruption?.dismissedAt !== undefined)
        return yield* new Error({
          code: "invalid",
          message: "This task was dismissed; relaunch it with task if needed.",
        })
      if (!(yield* SubagentLifecycle.written(database, root.id, record.parentMessageID)))
        return yield* new Error({
          code: "invalid",
          message: "The message that launched this task was reverted; relaunch it with task if needed.",
        })
      if (origin === "agent" && !(yield* SubagentLifecycle.agentMayResume(sessions, root.id, record)))
        return yield* new Error({ code: "forbidden", message: SubagentLifecycle.HUMAN_FIRST })
      return { session, record }
    })

    // Resume (D.3): every child is checked, its owned paths are free and its admission taken before any of them starts.
    const resume: Interface["resume"] = Effect.fn("TaskManager.resume")(function* (input, ops) {
      const ids = [...new Set(input.taskIDs)]
      if (ids.length === 0 || ids.length > MAX_RESUME)
        return yield* new Error({ code: "invalid", message: `Choose 1–${MAX_RESUME} task IDs.` })
      const text = input.text?.trim() || undefined
      const invalid = text === undefined ? undefined : TaskMailbox.bodyError(text)
      if (invalid) return yield* new Error({ code: "invalid", message: invalid })
      const root = yield* get(input.sessionID)
      if (root.parentID)
        return yield* new Error({
          code: "forbidden",
          message: "Only the main agent resumes helpers this way; continue your own child with task and its task_id.",
        })
      if (!flags.backgroundSubagents)
        return yield* new Error({
          code: "invalid",
          message: "Background subagents are turned off (VECTOR_DISABLE_BACKGROUND_SUBAGENTS), so nothing can resume.",
        })
      const guest = input.guest || (yield* guests.marked(root.id))
      const conversationID = yield* TaskLimits.conversationOf(sessions, root, guest)
      const requestID = yield* TaskLimits.requestFor(limits, sessions, SessionID.make(conversationID))
      const resolved = TaskLimits.resolve(yield* config.get(), guest)
      const directory = yield* InstanceState.directory
      const started = yield* SubagentLifecycle.locked(lock)(
        Effect.scoped(
          Effect.gen(function* () {
            const checked = yield* Effect.forEach(ids, (id) => resumable(root, id, input.origin, text))
            const resuming = new Set<string>(checked.map((item) => item.session.id))
            // Owned paths stay exclusive among the conversation's active children (check 11).
            const running = (yield* jobs.list()).filter((job) => job.type === "task" && job.status === "running")
            const active = [
              ...running
                .filter((job) => job.metadata?.parentSessionId === root.id && !resuming.has(job.id))
                .map((job) => ({
                  label: job.title ?? job.id,
                  paths: Array.isArray(job.metadata?.ownedPaths)
                    ? job.metadata.ownedPaths.filter((item): item is string => typeof item === "string")
                    : [],
                })),
              ...[...SubagentLifecycle.claims]
                .filter(
                  (claim) =>
                    claim.parentSessionID === root.id &&
                    !(claim.taskID && resuming.has(claim.taskID)) &&
                    (!claim.held || running.some((job) => job.id === claim.taskID)),
                )
                .map((claim) => ({ label: claim.title, paths: claim.paths })),
            ]
            const conflicts = new Set(
              checked.flatMap(({ record }) =>
                (record.ownedPaths ?? []).flatMap((owned) =>
                  active.flatMap((item) =>
                    item.paths
                      .filter((path) => overlaps(owned, path))
                      .map((path) => `${item.label}: ${owned} overlaps ${path}`),
                  ),
                ),
              ),
            )
            if (conflicts.size > 0)
              return yield* new Error({
                code: "conflict",
                message: [
                  "Owned paths overlap active work:",
                  ...[...conflicts].map((item) => `- ${item}`),
                  "Wait for that task or stop it first.",
                ].join("\n"),
              })
            const admitted = yield* Effect.forEach(checked, (item) =>
              limits.admit({ conversationID, requestID, limits: resolved, origin: "resume", count: 1 }).pipe(
                Effect.map((admission) => ({ ...item, admission })),
                Effect.mapError((refused) => new Error({ code: "limit", message: refused.message })),
              ),
            )
            const delegated = {
              id: TaskLimits.ledger(conversationID, requestID),
              budget: resolved.budget,
              seed: yield* limits.seed(conversationID, requestID),
            }
            return yield* Effect.forEach(admitted, ({ session, record, admission }) =>
              Effect.gen(function* () {
                const id = session.id
                const attempt = (record.attempt ?? 1) + 1
                const now = Date.now()
                const lease = yield* jobs.lease()
                let queued = admission.waits
                yield* guard.link(id, root.id, { budget: record.budget, renew: true, delegated })
                yield* persist(
                  id,
                  {
                    attempt,
                    status: queued ? "queued" : "running",
                    slotReason: queued ? TaskLimits.SLOT_REASON : undefined,
                    background: true,
                    startedAt: now,
                    runtimeID: lease?.runtime ?? SubagentLifecycle.RUNTIME_ID,
                    owner: lease ? { pid: lease.pid, boot: lease.boot } : undefined,
                    conversationID,
                    rootSessionID: root.id,
                    requestID,
                    completedAt: undefined,
                    usage: undefined,
                    budgetScopes: undefined,
                    error: undefined,
                    notification: undefined,
                    resultRef: undefined,
                    resultSummary: undefined,
                    reason: undefined,
                    ...(record.interruption && { interruption: { ...record.interruption, resumedAt: now } }),
                    stop: undefined,
                    waiting: undefined,
                    reports: undefined,
                  },
                  record.attempt,
                )
                const brief = [
                  ...(record.status === "completed"
                    ? []
                    : [
                        record.stop?.by === "user"
                          ? SubagentLifecycle.RESUME_STOPPED_BRIEF
                          : record.interruption
                            ? SubagentLifecycle.RESUME_BRIEF
                            : SubagentLifecycle.RESUME_ENDED_BRIEF,
                      ]),
                  ...(text ? [TaskMailbox.envelope(text, { sender: root.id, recipient: id, relation: "parent" })] : []),
                ].join("\n\n")
                const work = Effect.gen(function* () {
                  // Queued for a slot until now; running clears the reason.
                  if (queued) {
                    queued = false
                    yield* SubagentLifecycle.update(sessions, id, { status: "running", slotReason: undefined }, attempt)
                  }
                  return yield* ops.prompt({
                    sessionID: id,
                    messageID: MessageID.ascending(),
                    agent: record.agent,
                    model: {
                      providerID: ProviderV2.ID.make(record.model.providerID),
                      modelID: ModelV2.ID.make(record.model.modelID),
                    },
                    variant: record.model.variant,
                    parts: [{ type: "text", synthetic: true, text: brief }],
                  })
                })
                const waiting = Effect.sync(() => {
                  queued = true
                }).pipe(
                  Effect.andThen(
                    SubagentLifecycle.update(
                      sessions,
                      id,
                      { status: "queued", slotReason: TaskLimits.SLOT_REASON },
                      attempt,
                    ),
                  ),
                )
                yield* limits.bind(admission, id)
                yield* jobs.start({
                  id,
                  type: "task",
                  title: record.title,
                  metadata: {
                    parentSessionId: root.id,
                    sessionId: id,
                    projectId: root.projectID,
                    directory: root.directory,
                    model: record.model,
                    kind: record.kind,
                    agent: record.agent,
                    custom: record.custom,
                    title: record.title,
                    parentMessageId: record.parentMessageID,
                    startedAt: now,
                    attempt,
                    ...(record.ownedPaths?.length ? { ownedPaths: record.ownedPaths } : {}),
                    background: true,
                  },
                  // A row in vector.db, so a restart can tell the parent this child was interrupted again.
                  durable: { parentSessionID: root.id, sessionID: id, directory, attempt },
                  run: limits.run({ conversationID, childID: id, origin: "resume", waiting }, work).pipe(
                    Effect.onInterrupt(() => ops.cancel(id)),
                    Effect.flatMap(SubagentLifecycle.settleRun),
                    Effect.ensuring(limits.release(admission, id)),
                  ),
                })
                yield* notify.watch({
                  jobID: id,
                  parentID: root.id,
                  taskID: id,
                  attempt,
                  title: record.title,
                  startedAt: now,
                  launchID: MessageID.make(record.parentMessageID),
                  ops,
                  agent: root.agent ?? "build",
                })
                return id
              }),
            )
          }),
        ),
      )
      return {
        tasks: yield* Effect.forEach(started, (id) => get(id).pipe(Effect.flatMap(observe)), { concurrency: 4 }),
      }
    })

    const wait: Interface["wait"] = Effect.fn("TaskManager.wait")(function* (input) {
      if (
        !Number.isFinite(input.timeout ?? 30_000) ||
        (input.timeout ?? 30_000) < 0 ||
        (input.timeout ?? 30_000) > 60_000
      )
        return yield* new Error({ code: "invalid", message: "Wait timeout must be between 0 and 60000 milliseconds." })
      const before = yield* SubagentLifecycle.locked(lock)(select(input.sessionID, input.taskIDs))
      const settled = (tasks: readonly Task.Info[]) =>
        input.mode === "all"
          ? tasks.every((task) => !ACTIVE.has(task.status))
          : tasks.some((task) => !ACTIVE.has(task.status))
      if (settled(before)) return { tasks: before, timedOut: false }
      const waits = before
        .filter((task) => ACTIVE.has(task.status))
        .map((task) =>
          DesktopTasks.owns(task.id)
            ? bridge(desktop.wait({ sessionID: input.sessionID, taskID: task.id, timeout: input.timeout ?? 30_000 }))
            : jobs.wait({ id: task.id }).pipe(Effect.asVoid),
        )
      const done = yield* (
        input.mode === "all" ? Effect.all(waits, { concurrency: "unbounded", discard: true }) : Effect.raceAll(waits)
      ).pipe(Effect.timeoutOption(input.timeout ?? 30_000))
      const tasks = yield* select(input.sessionID, input.taskIDs)
      return { tasks, timedOut: done._tag === "None" || !settled(tasks) }
    })

    return Service.of({ list, inspect, message, stop, interrupt, promote, resume, wait })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Session.node,
    BackgroundJob.node,
    SessionStatus.node,
    Permission.node,
    Question.node,
    Database.node,
    SpendGuard.node,
    DesktopTasks.node,
    TaskLimits.node,
    Config.node,
    FreeModelGuests.node,
    BackgroundJobStore.node,
    TaskNotify.node,
    RuntimeFlags.node,
  ],
})
export * as TaskManager from "./manager"
