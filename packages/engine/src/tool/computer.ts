import { Effect, Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { ComputerAvailability } from "@/computer/availability"
import { Tool } from "./tool"

/** Narrow both single and batch actions while retaining the shared input's bounds and hold-key checks. */
export function parameters(actions: readonly Computer.ToolAction[]) {
  return Schema.Struct({
    ...Computer.ToolInput.fields,
    action: Schema.Literals(actions),
    actions: Schema.optional(
      Schema.Array(
        Schema.Struct({
          ...Computer.ToolStep.fields,
          action: Schema.Literals(actions.filter((action) => action !== "handoff")),
        }),
      ).check(Schema.isMaxLength(Computer.LIMITS.batchSteps)),
    ),
  }).check(Schema.makeFilter(Schema.is(Computer.ToolInput), { expected: "a valid computer action" }))
}

// Registration lands before the lease and approval implementation. No scaffold call may operate the computer.
export const ComputerTool = Tool.define(
  "computer",
  Effect.gen(function* () {
    const availability = yield* ComputerAvailability.Service
    return () =>
      Effect.gen(function* () {
        return {
          description: `Use ${Hands.NAME} to work with approved desktop apps.`,
          parameters: parameters(yield* availability.actions()),
          execute: (input: Computer.ToolInput) =>
            Effect.succeed({
              title: Hands.NAME,
              output: `${Hands.NAME} is not available in this build yet.`,
              metadata: { action: input.action, code: "unavailable" as const },
            }),
        }
      })
  }),
)
