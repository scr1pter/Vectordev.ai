export * as RunBudget from "./run-budget"

import { Schema } from "effect"
import { optional, PositiveInt } from "./schema"

// Limits for one run of a root session and its subagents. `usd` is priced at catalog list rates; `warnAt` is the
// share of `usd` at which the run warns once; `unpricedSteps` bounds steps on a model with no catalog price.
export const Info = Schema.Struct({
  usd: optional(Schema.Finite.check(Schema.isGreaterThan(0))),
  steps: optional(PositiveInt),
  warnAt: optional(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  unpricedSteps: optional(PositiveInt),
}).annotate({ identifier: "RunBudget" })
export type Info = Schema.Schema.Type<typeof Info>

export const StopReason = Schema.Literals(["cap", "predicted", "unpriced", "steps", "loop"]).annotate({
  identifier: "RunBudgetStopReason",
})
export type StopReason = typeof StopReason.Type
