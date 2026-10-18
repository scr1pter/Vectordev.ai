import { Effect, Schema } from "effect"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  tool: Schema.String,
  error: Schema.String,
})

export const InvalidTool = Tool.define(
  "invalid",
  Effect.succeed({
    description: "Do not use",
    parameters: Parameters,
    execute: (params: { tool: string; error: string }) =>
      Effect.succeed({
        title: "Invalid Tool",
        // A small model may call a tool its request's size does not offer, such as task on a Light request.
        output: /unavailable tool|no such tool/i.test(params.error)
          ? `The ${params.tool} tool is not offered for this request. Do the work with the tools you have; if it truly needs ${params.tool}, call escalate when it is offered.`
          : `The arguments provided to the tool are invalid: ${params.error}`,
        metadata: {},
      }),
  }),
)
