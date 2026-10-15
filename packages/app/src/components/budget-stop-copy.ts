import type { AssistantMessage, BudgetStopError } from "@vectordevai/sdk/v2/client"
import { formatUsd } from "@/features/economics/format-spend"

export type BudgetStopNotice = {
  messageID: string
  providerID: string
  modelID: string
  agent: string
  error: BudgetStopError["data"]
}

export const BUDGET_STOP_CONTINUE_PROMPT = "Continue from where you stopped."
export const BUDGET_STOP_FOOTNOTE = "Continuing starts a new run with its own cap."

// What the timeline hands the Budget stop card: the stop itself and the model
// and agent a continuation should run with.
export function budgetStopNotice(message: AssistantMessage | undefined): BudgetStopNotice | undefined {
  if (message?.error?.name !== "BudgetStopError") return undefined
  return {
    messageID: message.id,
    providerID: message.providerID,
    modelID: message.modelID,
    agent: message.agent,
    error: message.error.data,
  }
}

// Everything the Budget stop card says, derived from the engine's error alone
// so the wording can be tested without rendering.
export function budgetStopCopy(error: BudgetStopError["data"]) {
  const loop = error.reason === "loop"
  return {
    title: loop ? "Loop paused" : "Budget stop",
    body: error.message,
    spent: spentLine(error),
    // Always a range: one number would read as a quote rather than an estimate.
    estimate: error.estimate
      ? `Next step estimated at ${formatUsd(error.estimate.lowUsd)}–${formatUsd(error.estimate.highUsd)}`
      : undefined,
    continueLabel: continueLabel(error),
    // A continuation renews the stopped run's cap at the same size; the card
    // builds the rest of the budget from the user's configured limits.
    capUsd: error.capUsd,
    footnote: BUDGET_STOP_FOOTNOTE,
  }
}

function spentLine(error: BudgetStopError["data"]) {
  if (error.spentUsd === undefined) return undefined
  if (error.capUsd === undefined) return `${formatUsd(error.spentUsd)} spent`
  return `${formatUsd(error.spentUsd)} of ${formatUsd(error.capUsd)} spent`
}

// A loop is not about money, so it continues as is. A money stop continues only
// under a fresh cap of the same size. A step limit with no cap renews the step
// limit, since every new run starts with the configured one.
function continueLabel(error: BudgetStopError["data"]) {
  if (error.reason === "loop") return "Continue anyway"
  if (error.capUsd !== undefined) return `Continue with a new ${formatUsd(error.capUsd)} cap`
  if (error.reason === "steps") return "Continue with a new step limit"
  return undefined
}
