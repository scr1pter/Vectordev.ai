import { Effect, Schema } from "effect"
import { TaskSize } from "@vectordevai/core/task-size"
import { Tool } from "./tool"
import DESCRIPTION from "./escalate.txt"

export const Parameters = Schema.Struct({
  reason: Schema.String.annotate({ description: "One line on why the work needs a larger size" }),
})

type Metadata = {
  from?: TaskSize.Tier
  to?: TaskSize.Tier
}

// What a request gains at each size, as the model reads it in the result.
const GAINS: Partial<Record<TaskSize.Tier, string>> = {
  standard: "the to-do list (todowrite) and questions to the user",
  thorough: "subagents (task and task_manage)",
}

/** The request's size as the session runtime sized it this step; the model cannot supply it. */
export type TaskSizeContext = { readonly tier: TaskSize.Tier; readonly escalated: boolean }

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
        // The completed call is the durable record: every later step recomputes the size from the history, so the
        // raise survives a restart and counts once per request however many times it is called.
        if (current.escalated || current.tier === "thorough")
          return {
            title: "Not raised",
            output:
              current.tier === "thorough"
                ? "This request is already Thorough."
                : "Already raised once for this request. Carry on with the tools you have; the user can ask for a thorough run.",
            metadata: {},
          }
        const to = TaskSize.raise(current.tier)
        return {
          title: `${TaskSize.label(to)} task`,
          output: `This request is now ${TaskSize.label(to)}${GAINS[to] ? `: ${GAINS[to]} are offered from your next step` : ""}. Reason noted: ${params.reason.slice(0, 200)}`,
          metadata: { from: current.tier, to },
        }
      }),
  } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>),
)
