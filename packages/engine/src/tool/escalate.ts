import { Effect, Schema } from "effect"
import type { TaskSize } from "@vectordevai/core/task-size"
import { Tool } from "./tool"
import DESCRIPTION from "./escalate.txt"

export const Parameters = Schema.Struct({
  reason: Schema.String.annotate({ description: "One line on why the work is large" }),
})

type Metadata = {
  from?: TaskSize.Tier
  to?: TaskSize.Tier
}

/**
 * The request's size as the session runtime sized it this step, and whether the user capped it at Work ("no
 * subagents", "don't be thorough"); the model cannot supply either.
 */
export type TaskSizeContext = { readonly tier: TaskSize.Tier; readonly capped?: boolean }

export const EscalateTool = Tool.define<typeof Parameters, Metadata, never>(
  "escalate",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
      Effect.sync(() => {
        const current = ctx.extra?.taskSize as TaskSizeContext | undefined
        if (!current)
          return { title: "Not raised", output: "Task sizing does not apply to this session.", metadata: {} }
        if (current.capped)
          return {
            title: "Not raised",
            output:
              "The user asked not to use subagents or go thorough for this request. Do the work yourself with the tools you have.",
            metadata: {},
          }
        if (current.tier === "thorough")
          return {
            title: "Not raised",
            output: "This request is already Thorough. Carry on with the tools you have.",
            metadata: {},
          }
        // Work and Thorough are the only sizes the agent works at, so a raise always goes to Thorough. The completed
        // call is the durable record: every later step recomputes the size from the history, so the raise survives a
        // restart, and a reply that continues the work keeps it Thorough.
        return {
          title: "Thorough task",
          // The request's size note was written for its old size and stays as it was, so the prompt cache keeps it; this
          // result is what tells the model the size changed.
          output: `This request is now Thorough: subagents (task and task_manage) and the to-do list are offered from your next step, at high reasoning effort. This replaces the size note on the request. Reason noted: ${params.reason.slice(0, 200)}`,
          metadata: { from: current.tier, to: "thorough" },
        }
      }),
  } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>),
)
