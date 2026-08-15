import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Effect, Exit, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode-ai/core/database/database"
import path from "path"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Foreground is the default; use it when you need the result before continuing.",
  "Use background only for independent work that can run while you continue elsewhere.",
  "You will be notified automatically when it finishes.",
].join(" ")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")
const MAX_ACTIVE_SUBAGENTS = 16
const MAX_ACTIVE_SUBAGENTS_PER_SESSION = 6
const MAX_SUBAGENT_DEPTH = 2

function normalizedPath(value: string) {
  const input = value.trim().replaceAll("\\", "/")
  if (!input) return ""
  if (path.posix.isAbsolute(input) || path.win32.isAbsolute(value) || /^[a-z]:/i.test(input)) {
    throw new Error(`Subagent owned path must be repository-relative: ${value}`)
  }
  const normalized = path.posix.normalize(input.replace(/^\.\//, ""))
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Subagent owned path cannot leave the repository: ${value}`)
  }
  return normalized.replace(/\/$/, "")
}

function pathsOverlap(a: string, b: string) {
  if (a === "." || b === ".") return true
  if (a === b) return true
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

function dependencyIDs(job: BackgroundJob.Info) {
  if (!Array.isArray(job.metadata?.dependsOn)) return []
  return job.metadata.dependsOn.filter((item): item is string => typeof item === "string")
}

function dependencyReaches(jobs: BackgroundJob.Info[], start: string, target: string, seen = new Set<string>()): boolean {
  if (start === target) return true
  if (seen.has(start)) return false
  seen.add(start)
  const job = jobs.find((item) => item.id === start)
  if (!job) return false
  return dependencyIDs(job).some((dependency) => dependencyReaches(jobs, dependency, target, seen))
}

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  depends_on: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Task IDs that must complete successfully before this subagent starts. Use this to express dependencies between delegated work without polling",
  }),
  owned_paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Repository-relative files or directory prefixes this subagent owns. Vector rejects overlapping ownership among active sibling subagents",
  }),
  success_criteria: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Observable conditions the subagent must verify before reporting completion",
  }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

function assignmentPrompt(params: Schema.Schema.Type<typeof Parameters>, ownedPaths: string[]) {
  const successCriteria = params.success_criteria?.map((item) => item.trim()).filter(Boolean) ?? []
  if (ownedPaths.length === 0 && successCriteria.length === 0) return params.prompt
  return [
    "<orchestration_assignment>",
    ...(ownedPaths.length === 0
      ? []
      : [
          "You own only these repository paths for this assignment:",
          ...ownedPaths.map((item) => `- ${item}`),
          "Do not edit outside these paths. Report any required cross-boundary change to the parent agent instead.",
        ]),
    ...(successCriteria.length === 0
      ? []
      : [
          "Do not report completion until every success criterion below has been checked:",
          ...successCriteria.map((item) => `- ${item}`),
        ]),
    "</orchestration_assignment>",
    "",
    params.prompt,
  ].join("\n")
}

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }
      const parent = yield* sessions.get(ctx.sessionID)
      const dependencies = [...new Set(params.depends_on?.map((item) => item.trim()).filter(Boolean) ?? [])]
      const jobs = yield* background.list()
      for (const dependency of dependencies) {
        if (dependency === params.task_id) {
          return yield* Effect.fail(new Error(`Task ${dependency} cannot depend on itself.`))
        }
        const job = jobs.find((item) => item.id === dependency)
        if (!job) {
          return yield* Effect.fail(new Error(`Dependency ${dependency} was not found in this project runtime.`))
        }
        if (job.type !== id || job.metadata?.parentSessionId !== ctx.sessionID) {
          return yield* Effect.fail(new Error(`Dependency ${dependency} does not belong to this task's subagent group.`))
        }
        if (job.status === "error") {
          return yield* Effect.fail(
            new Error(`Dependency ${dependency} failed${job.error ? `: ${job.error}` : "."}`),
          )
        }
        if (job.status === "cancelled") {
          return yield* Effect.fail(new Error(`Dependency ${dependency} was cancelled.`))
        }
        if (params.task_id && dependencyReaches(jobs, dependency, params.task_id)) {
          return yield* Effect.fail(new Error(`Dependency ${dependency} would create a task cycle.`))
        }
      }

      const ownedPaths = yield* Effect.try({
        try: () => [...new Set(params.owned_paths?.map(normalizedPath).filter(Boolean) ?? [])],
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })
      if (ownedPaths.length > 0) {
        const conflicts = jobs
          .filter(
            (job) =>
              job.type === id &&
              job.status === "running" &&
              job.id !== params.task_id &&
              !dependencies.includes(job.id) &&
              job.metadata?.parentSessionId === ctx.sessionID,
          )
          .flatMap((job) => {
            const existing = Array.isArray(job.metadata?.ownedPaths)
              ? job.metadata.ownedPaths.filter((item): item is string => typeof item === "string")
              : []
            return ownedPaths.flatMap((owned) =>
              existing
                .map(normalizedPath)
                .filter((item) => item && pathsOverlap(owned, item))
                .map((item) => `${job.title ?? job.id}: ${owned} overlaps ${item}`),
            )
          })
        if (conflicts.length > 0) {
          return yield* Effect.fail(
            new Error(
              [
                "Subagent ownership overlaps active sibling work.",
                ...conflicts.map((item) => `- ${item}`),
                "Wait for that task, add it to depends_on, or assign non-overlapping paths.",
              ].join("\n"),
            ),
          )
        }
      }

      let cursor = parent
      let depth = 0
      while (cursor.parentID) {
        depth += 1
        const ancestor = yield* sessions
          .get(cursor.parentID)
          .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        if (!ancestor) break
        cursor = ancestor
      }
      if (depth >= MAX_SUBAGENT_DEPTH) {
        return yield* Effect.fail(
          new Error(`Subagent depth is limited to ${MAX_SUBAGENT_DEPTH} so delegated work cannot recursively fan out forever.`),
        )
      }
      if (!params.task_id) {
        const active = (yield* background.list()).filter((job) => job.type === id && job.status === "running")
        if (active.length >= MAX_ACTIVE_SUBAGENTS) {
          return yield* Effect.fail(
            new Error(`Vector already has ${MAX_ACTIVE_SUBAGENTS} active subagents. Wait for or stop one before launching another.`),
          )
        }
        const activeForParent = active.filter((job) => job.metadata?.parentSessionId === ctx.sessionID)
        if (activeForParent.length >= MAX_ACTIVE_SUBAGENTS_PER_SESSION) {
          return yield* Effect.fail(
            new Error(
              `This task already has ${MAX_ACTIVE_SUBAGENTS_PER_SESSION} active subagents. Reuse an existing task or wait for one to finish.`,
            ),
          )
        }
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const session = params.task_id
        ? yield* sessions.get(SessionID.make(params.task_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: next,
      })
      const childToolDenies = [
        ...(next.permission.some((rule) => rule.permission === "todowrite")
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === id)
          ? []
          : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
        ...(cfg.experimental?.primary_tools?.map((permission) => ({
          permission,
          pattern: "*" as const,
          action: "deny" as const,
        })) ?? []),
      ]
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          agent: next.name,
          permission: [
            ...childPermission,
            ...childToolDenies.filter(
              (deny) =>
                !childPermission.some(
                  (rule) =>
                    rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
                ),
            ),
          ],
        }))

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        projectId: parent.projectID,
        directory: parent.directory,
        model,
        ...(dependencies.length > 0 ? { dependsOn: dependencies } : {}),
        ...(ownedPaths.length > 0 ? { ownedPaths } : {}),
        ...(params.success_criteria?.length ? { successCriteria: params.success_criteria } : {}),
        ...(runInBackground ? { background: true } : {}),
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        for (const dependency of dependencies) {
          const waited = yield* background.wait({ id: dependency })
          if (!waited.info) {
            return yield* Effect.fail(new Error(`Dependency ${dependency} disappeared before this task could start.`))
          }
          if (waited.info.status === "error") {
            return yield* Effect.fail(
              new Error(`Dependency ${dependency} failed${waited.info.error ? `: ${waited.info.error}` : "."}`),
            )
          }
          if (waited.info.status === "cancelled") {
            return yield* Effect.fail(new Error(`Dependency ${dependency} was cancelled.`))
          }
        }
        const parts = yield* ops.resolvePromptParts(assignmentPrompt(params, ownedPaths))
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          variant: next.model ? undefined : variant,
          agent: next.name,
          parts,
        })
        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent: currentParent.agent ?? ctx.agent,
            variant,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: renderOutput({
                  sessionID: nextSession.id,
                  state,
                  summary:
                    state === "completed"
                      ? `Background task completed: ${params.description}`
                      : `Background task failed: ${params.description}`,
                  text,
                }),
              },
            ],
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
            if (result.info?.status === "error") return inject("error", result.info.error ?? "")
            return Effect.void
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      if (yield* background.extend({ id: nextSession.id, run: runTask() })) {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
          }),
        }
      }

      const info = yield* background.start({
        id: nextSession.id,
        type: id,
        title: params.description,
        metadata,
        onPromote: Effect.all([
          ctx.metadata({
            title: params.description,
            metadata: { ...metadata, background: true, jobId: nextSession.id },
          }),
          notify(nextSession.id),
        ]),
        run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
      })

      function backgroundResult() {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task started",
            text: BACKGROUND_STARTED,
          }),
        }
      }

      if (runInBackground) {
        yield* notify(info.id)
        return backgroundResult()
      }

      const runCancel = yield* EffectBridge.make()
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.raceFirst(
              background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
              background.waitForPromotion(nextSession.id),
            )
            if (result?.metadata?.background === true) return backgroundResult()
            if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            if (result?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
            return {
              title: params.description,
              metadata,
              output: renderOutput({ sessionID: nextSession.id, state: "completed", text: result?.output ?? "" }),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit))
              yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: flags.experimentalBackgroundSubagents
        ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n")
        : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
