import { ConfigResearchV1 } from "@vectordevai/core/v1/config/research"
import { Research } from "@vectordevai/schema/research"
import { Effect, Schema } from "effect"
import { Config } from "@/config/config"
import type { TaskSizeContext } from "./escalate"
import { ResearchRun } from "./research-run"
import { TaskTool } from "./task"
import { Tool } from "./tool"
import DESCRIPTION from "./research.txt"

// research: the build agent's way to research a question as part of its work, on Work and Thorough requests (the
// `research.tool` setting), besides the Deep research mode the user picks. It hands the question to the research lead
// through the task tool, so the run gets the research agents' narrowing permissions, their holds and their caps: the
// request passes the outbound check before the lead starts (the lead gets nothing else of this session's private
// context), research's default caps apply when the user has none, and the lead stays at this request's size, so only
// a Thorough request may run deep. Each call is its own run, keyed by the lead's session.

export const Parameters = Schema.Struct({
  question: Schema.String.check(Schema.isLengthBetween(1, 1_000)).annotate({
    description:
      "The question to research, written in public terms: the lead sees only this, and it must not carry text from files, documents or memory",
  }),
  depth: Schema.optional(Research.Depth).annotate({
    description: "focused (default) or deep (researchers and a citation judge; Thorough requests only)",
  }),
  scope: Schema.optional(Research.Scope).annotate({
    description: "web, web+brain (default: the web and this repository's brain) or brain",
  }),
  background: Schema.optional(Schema.Boolean).annotate({
    description: "Run in the background (the default where background subagents are on); false waits for the report",
  }),
})

export const RESEARCH_TOOL = "research"

export const ResearchTool = Tool.define(
  RESEARCH_TOOL,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const task = yield* Tool.init(yield* TaskTool)

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const setting = (yield* config.get()).research?.tool
          const size = ctx.extra?.taskSize as TaskSizeContext | undefined
          if (size && !ConfigResearchV1.buildTool(size.tier, setting))
            return {
              title: "Not researched",
              output:
                setting === "off"
                  ? "Research as a tool is turned off in the settings for this repository (research.tool)."
                  : "Research as a tool runs on Thorough requests only in these settings (research.tool: thorough). Call escalate if the work needs it.",
              metadata: {},
            }
          const deep = params.depth === "deep" && size?.tier === "thorough"
          const prompt = [
            params.question.trim(),
            "",
            `Depth: ${deep ? "deep" : "focused"}. Scope: ${params.scope ?? "web+brain"}.`,
            "Plan the run with research_plan, research it, write the report with research_report, and reply with the answer in a few lines and the note IDs it rests on.",
          ].join("\n")
          // The task tool decides whether the lead may start as it does for any subagent the model asks for, so the
          // user's task rules apply: `task: deny` refuses it, and `task: { research: "ask" }` asks first.
          return yield* task.execute(
            {
              description: `Research: ${params.question.trim().slice(0, 48)}`,
              prompt,
              subagent_type: ResearchRun.LEAD,
              ...(params.background === undefined ? {} : { background: params.background }),
            },
            ctx,
          )
        }),
    }
  }),
)
