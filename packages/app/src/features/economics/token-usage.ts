// Reads provider-reported token usage and the recorded charge off assistant
// messages. Charges may use catalog rates or provider billing metadata. Nothing
// here estimates from character counts, so a run whose provider reported no
// usage yields undefined rather than a zero that would read as "free".
import { addUsage, emptyUsage, totalTokens, type TokenUsage, type VariantEvidence } from "./economics-types"

// Structural subset of the SDK's AssistantMessage. Declared locally so this
// module does not depend on generated SDK types that change shape on
// regeneration; any real AssistantMessage satisfies it.
export type UsageBearingMessage = {
  role?: string
  providerID?: string
  modelID?: string
  variant?: string
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
  mixedModels?: boolean
  variant?: VariantEvidence
  messageCount: number
}

export type SessionSpend = {
  cost?: number
  unpricedSteps?: number
  subagentCost?: number
  subagentUnpricedSteps?: number
}

// Session totals include ancillary requests, whose tokens and model do not belong to the main assistant's sample.
export function totalSessionCost(spend: SessionSpend | undefined, measuredCost: number | undefined) {
  if (!spend || spend.unpricedSteps || spend.subagentUnpricedSteps) return undefined
  if (measuredCost === undefined || !Number.isFinite(measuredCost)) return undefined
  if (typeof spend.cost !== "number" || !Number.isFinite(spend.cost) || spend.cost < 0) return undefined
  if (spend.cost + 1e-9 < measuredCost) return undefined
  const subagents = spend.subagentCost ?? 0
  if (!Number.isFinite(subagents) || subagents < 0) return undefined
  const total = spend.cost + subagents
  return Number.isFinite(total) ? total : undefined
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
// a fabricated zero. Attribute the total to a model only when every observed
// attempt used that same provider/model; missing usage cannot prove an earlier attempt was free.
export function measureUsage(messages: readonly UsageBearingMessage[]): MeasuredUsage | undefined {
  const assistant = messages.filter((message) => message.role === "assistant" && !message.forked)
  if (!assistant.length) return undefined

  const measured = assistant.filter((message) => totalTokens(usageOf(message)) > 0)
  if (!measured.length) return undefined

  // A positive recorded charge remains measured spend without token counters. A zero-cost
  // attempt without usage cannot establish free execution, so it leaves the total unknown.
  const accounted = assistant.filter(
    (message) =>
      totalTokens(usageOf(message)) > 0 || message.unpriced || (typeof message.cost === "number" && message.cost !== 0),
  )
  const costs = accounted.map((message) => message.cost)
  const costUsd =
    accounted.length !== assistant.length ||
    accounted.some((message) => message.unpriced) ||
    costs.some((cost) => typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
      ? undefined
      : costs.reduce<number>((total, cost) => total + (cost ?? 0), 0)
  const first = measured[0]
  const identities = new Set(
    assistant
      .filter((message) => message.providerID && message.modelID)
      .map((message) => JSON.stringify([message.providerID, message.modelID])),
  )
  const attributable =
    !!first.providerID &&
    !!first.modelID &&
    assistant.every((message) => message.providerID === first.providerID && message.modelID === first.modelID)
  // Include observed attempts without reported usage: a later failure on another preset cannot qualify
  // the earlier preset's paid history. Forked history remains excluded, and absent names stay unknown.
  const configured = assistant.filter(
    (message) => message.providerID === first.providerID && message.modelID === first.modelID,
  )
  const variants = new Set(
    configured
      .map((message) => message.variant)
      .filter((variant): variant is string => typeof variant === "string" && variant.length > 0),
  )
  const variant: VariantEvidence | undefined =
    variants.size > 1
      ? { kind: "mixed" }
      : variants.size === 1 && configured.every((message) => message.variant === first.variant)
        ? { kind: "named", name: first.variant! }
        : undefined
  return {
    usage: measured.map(usageOf).reduce(addUsage, emptyUsage),
    costUsd: Number.isFinite(costUsd) ? costUsd : undefined,
    provider: attributable ? first.providerID : undefined,
    model: attributable ? first.modelID : undefined,
    mixedModels: identities.size > 1 ? true : undefined,
    variant: attributable ? variant : undefined,
    messageCount: measured.length,
  }
}
