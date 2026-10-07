// Reads provider-reported token usage and the recorded charge off assistant
// messages. Charges may use catalog rates or provider billing metadata. Nothing
// here estimates from character counts, so a run
// whose provider reported no usage yields undefined rather than a zero that
// would read as "free".
import { addUsage, emptyUsage, totalTokens, type TokenUsage } from "./economics-types"

// Structural subset of the SDK's AssistantMessage. Declared locally so this
// module does not depend on generated SDK types that change shape on
// regeneration; any real AssistantMessage satisfies it.
export type UsageBearingMessage = {
  role?: string
  providerID?: string
  modelID?: string
  cost?: number
  // A step of this message ran on a model with no listed price, so its cost leaves that step out.
  unpriced?: boolean
  // Copied in by a fork; the original session already measured it.
  forked?: boolean
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
}

export type MeasuredUsage = {
  usage: TokenUsage
  // Absent when any message ran unpriced: what the rest cost is not what the run cost.
  costUsd?: number
  provider?: string
  model?: string
  messageCount: number
}

const finite = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0

function usageOf(message: UsageBearingMessage): TokenUsage {
  return {
    input: finite(message.tokens?.input),
    output: finite(message.tokens?.output),
    reasoning: finite(message.tokens?.reasoning),
    cacheRead: finite(message.tokens?.cache?.read),
    cacheWrite: finite(message.tokens?.cache?.write),
  }
}

// Sums usage across every assistant message in a session. Returns undefined
// when nothing reported usage, so callers can render "not measured" instead of
// a fabricated zero. A model identity is returned only when all measured work
// used the same model: a switched-model run cannot train a single-model ranking.
export function measureUsage(messages: readonly UsageBearingMessage[]): MeasuredUsage | undefined {
  const assistant = messages.filter((message) => message.role === "assistant" && !message.forked)
  if (!assistant.length) return undefined

  const measured = assistant.filter((message) => totalTokens(usageOf(message)) > 0)
  if (!measured.length) return undefined

  // A provider can report a charge even when its token counters are absent.
  // Include it in spend rather than silently dropping it from the task total.
  const accounted = assistant.filter(
    (message) =>
      totalTokens(usageOf(message)) > 0 || message.unpriced || (typeof message.cost === "number" && message.cost !== 0),
  )
  const first = accounted[0]
  const sameModel = accounted.every(
    (message) => message.providerID === first?.providerID && message.modelID === first?.modelID,
  )
  const costs = accounted.map((message) => message.cost)
  const costUsd =
    accounted.some((message) => message.unpriced) ||
    costs.some((cost) => typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
      ? undefined
      : costs.reduce<number>((total, cost) => total + (cost ?? 0), 0)
  return {
    usage: measured.map(usageOf).reduce(addUsage, emptyUsage),
    costUsd: Number.isFinite(costUsd) ? costUsd : undefined,
    provider: sameModel ? first?.providerID : undefined,
    model: sameModel ? first?.modelID : undefined,
    messageCount: measured.length,
  }
}

// Child sessions execute separate provider requests. Their rollup must be
// included before comparing whole tasks, and a partial price stays unknown.
export function aggregateCostUsd(
  costUsd: number | undefined,
  subagents?: { subagentCost?: number; subagentUnpricedSteps?: number },
) {
  if (costUsd === undefined || !Number.isFinite(costUsd) || costUsd < 0) return undefined
  const unpriced = subagents?.subagentUnpricedSteps ?? 0
  const delegated = subagents?.subagentCost ?? 0
  if (!Number.isFinite(unpriced) || unpriced !== 0 || !Number.isFinite(delegated) || delegated < 0) return undefined
  const total = costUsd + delegated
  return Number.isFinite(total) ? total : undefined
}
