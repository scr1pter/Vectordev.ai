export * as ConfigCommandV1 from "./command"

import { Schema } from "effect"
import { TaskSize } from "@vectordevai/schema/task-size"

export const Info = Schema.Struct({
  template: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  subtask: Schema.optional(Schema.Boolean),
  size: Schema.optional(TaskSize.Tier).annotate({
    description:
      "How much harness the command's run gets: chat, light, standard or thorough. When unset, Vector sizes the run from what the template asks for. Only thorough offers subagents.",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
