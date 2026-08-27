// Reads the provider's own reported token usage and cost off assistant
// messages. This is the only place the economics engine learns what a run
// actually spent — nothing here estimates from character counts, so a run
// whose provider reported no usage yields undefined rather than a zero that
// would read as "free".
import { addUsage, emptyUsage, type TokenUsage } from "./economics-types"

// Structural subset of the SDK's AssistantMessage. Declared locally so this
// module does not depend on generated SDK types that change shape on
// regeneration; any real AssistantMessage satisfies it.
export type UsageBearingMessage = {
  role?: string
  providerID?: string
  modelID?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
}

export type MeasuredUsage = {
  usage: TokenUsage
  costUsd: number
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
// a fabricated zero. The provider/model reported is the one from the most
// recent assistant message, since a session can switch models mid-run.
export function measureUsage(messages: readonly UsageBearingMessage[]): MeasuredUsage | undefined {
  const assistant = messages.filter((message) => message.role === "assistant")
  if (!assistant.length) return undefined

  const measured = assistant.filter((message) => {
    const usage = usageOf(message)
    return usage.input > 0 || usage.output > 0 || usage.reasoning > 0 || usage.cacheRead > 0
  })
  if (!measured.length) return undefined

  const last = measured[measured.length - 1]
  return {
    usage: measured.map(usageOf).reduce(addUsage, emptyUsage),
    costUsd: measured.reduce((total, message) => total + finite(message.cost), 0),
    provider: last?.providerID,
    model: last?.modelID,
    messageCount: measured.length,
  }
}
