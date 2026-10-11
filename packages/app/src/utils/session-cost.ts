import { helperLabel } from "./internal-sessions"

// A session's recorded cost, said honestly. A step on a model that lists no price adds nothing to the cost, so a
// total that includes such steps is only a lower bound, and one made of nothing else is unknown rather than $0.00.
export function formatSessionCost(input: {
  cost: number | undefined
  unpricedSteps: number | undefined
  format: (value: number) => string
  t: (key: "session.cost.unknown" | "session.cost.partial", params: { cost: string }) => string
}) {
  const cost = input.format(input.cost ?? 0)
  if (!input.unpricedSteps) return cost
  if (!input.cost) return input.t("session.cost.unknown", { cost })
  return input.t("session.cost.partial", { cost })
}

// What a task cost: the session's own steps plus everything its subagents spent, which the backend keeps apart.
export function sessionSpend(
  info: { cost?: number; unpricedSteps?: number; subagentCost?: number; subagentUnpricedSteps?: number } | undefined,
) {
  return {
    cost: (info?.cost ?? 0) + (info?.subagentCost ?? 0),
    unpricedSteps: (info?.unpricedSteps ?? 0) + (info?.subagentUnpricedSteps ?? 0),
  }
}

type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

type Spend = {
  internal?: string
  cost?: number
  unpricedSteps?: number
  subagentCost?: number
  subagentUnpricedSteps?: number
  tokens?: Tokens
  subagentTokens?: Tokens
}

function tokenCount(tokens: Tokens | undefined) {
  if (!tokens) return 0
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

// The tokens a task used: the session's own plus what its subagents and Vector's helpers used for it.
export function sessionTokens(info: Pick<Spend, "tokens" | "subagentTokens"> | undefined) {
  return tokenCount(info?.tokens) + tokenCount(info?.subagentTokens)
}

export function compactTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

// What a session delegated, as the backend keeps it in subagentCost and subagentTokens, split into the Vector helpers
// that worked for it (named, from its helper child sessions) and its subagents (the rest).
export function delegatedSpend(info: Spend | undefined, children: readonly Spend[]) {
  const helpers = [
    ...children
      .reduce((groups, child) => {
        if (!child.internal) return groups
        const label = helperLabel(child.internal)
        const current = groups.get(label) ?? { label, cost: 0, unpricedSteps: 0, tokens: 0 }
        const spend = sessionSpend(child)
        return groups.set(label, {
          label,
          cost: current.cost + spend.cost,
          unpricedSteps: current.unpricedSteps + spend.unpricedSteps,
          tokens: current.tokens + sessionTokens(child),
        })
      }, new Map<string, { label: string; cost: number; unpricedSteps: number; tokens: number }>())
      .values(),
  ].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.label.localeCompare(b.label))
  const rest = {
    // Float sums of the same steps can differ in the last bits; a remainder below a millionth of a cent is nothing.
    cost: Math.max(0, (info?.subagentCost ?? 0) - helpers.reduce((total, helper) => total + helper.cost, 0)),
    unpricedSteps: Math.max(
      0,
      (info?.subagentUnpricedSteps ?? 0) - helpers.reduce((total, helper) => total + helper.unpricedSteps, 0),
    ),
    tokens: Math.max(0, tokenCount(info?.subagentTokens) - helpers.reduce((total, helper) => total + helper.tokens, 0)),
  }
  const subagents = { ...rest, cost: rest.cost < 1e-8 ? 0 : rest.cost }
  return {
    helpers,
    subagents: subagents.cost || subagents.unpricedSteps || subagents.tokens ? subagents : undefined,
  }
}
