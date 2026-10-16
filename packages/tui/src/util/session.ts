import type { Session } from "@vectordevai/sdk/v2"
import { Locale } from "./locale"

export function isDefaultTitle(title: string) {
  return /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)
}

export function isInternalSession(session: Pick<Session, "internal" | "title"> | undefined) {
  return Boolean(
    session?.internal ||
      session?.title.startsWith("Vector Tool · ") ||
      session?.title.startsWith("Vectorscope review · ") ||
      // Desktop 1.99.8 and `vector review` titled reviewers this way before Vectorscope had its name.
      /^Vector review · .+ · (review|security|verify)$/.test(session?.title ?? ""),
  )
}

// Helpers are absent from list snapshots after reconnect. Resolve an unknown session before showing any attention
// surface; a failed lookup cannot prove that it is a user session. Known sessions keep synchronous notification order.
export function notifyVisibleSession(input: {
  sessionID?: string
  cached: (sessionID: string) => Session | undefined
  read: (sessionID: string) => Promise<Session | undefined>
  show: (session: Session | undefined) => void
}) {
  if (!input.sessionID) return input.show(undefined)
  const cached = input.cached(input.sessionID)
  if (cached) {
    if (!isInternalSession(cached)) input.show(cached)
    return
  }
  return input
    .read(input.sessionID)
    .then((session) => {
      if (session && !isInternalSession(session)) input.show(session)
    })
    .catch(() => undefined)
}

type Spend = Pick<
  Session,
  | "internal"
  | "title"
  | "cost"
  | "unpricedSteps"
  | "subagentCost"
  | "subagentUnpricedSteps"
  | "tokens"
  | "subagentTokens"
>

// What a session delegated, as sidebar lines. The backend keeps it in subagentCost and subagentTokens, Vector's helpers
// included, so it is split by the session's children: the helpers among them and the subagents (the rest). Until the
// children are read the line cannot say which of the two spent it.
export function delegatedSpendLines(session: Spend | undefined, children: readonly Spend[] | undefined) {
  if (!session || !(session.subagentCost || session.subagentUnpricedSteps || tokenCount(session.subagentTokens)))
    return []
  const total = {
    cost: session.subagentCost ?? 0,
    unpriced: session.subagentUnpricedSteps ?? 0,
    tokens: tokenCount(session.subagentTokens),
  }
  if (!children) return [spendLine(total, "by subagents or Vector's helpers")]
  const helpers = children.filter(isInternalSession).reduce(
    (sum, child) => {
      const spend = Locale.sessionSpend(child)
      return {
        cost: sum.cost + spend.cost,
        unpriced: sum.unpriced + spend.unpriced,
        tokens: sum.tokens + tokenCount(child.tokens) + tokenCount(child.subagentTokens),
      }
    },
    { cost: 0, unpriced: 0, tokens: 0 },
  )
  const rest = Math.max(0, total.cost - helpers.cost)
  const subagents = {
    // Float sums of the same steps can differ in the last bits; a remainder below a millionth of a cent is nothing.
    cost: rest < 1e-8 ? 0 : rest,
    unpriced: Math.max(0, total.unpriced - helpers.unpriced),
    tokens: Math.max(0, total.tokens - helpers.tokens),
  }
  return [
    ...(subagents.cost || subagents.unpriced || subagents.tokens ? [spendLine(subagents, "by subagents")] : []),
    ...(helpers.cost || helpers.unpriced || helpers.tokens ? [spendLine(helpers, "by Vector's helpers")] : []),
  ]
}

function spendLine(spend: { cost: number; unpriced: number; tokens: number }, by: string) {
  const tokens = spend.tokens ? ` · ${Locale.number(spend.tokens)} tokens` : ""
  return `${Locale.spend(spend.cost, spend.unpriced)}${tokens} ${by}`
}

function tokenCount(tokens: Session["tokens"]) {
  if (!tokens) return 0
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}
