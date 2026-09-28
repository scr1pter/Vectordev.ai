// The desktop spend ledger, as the renderer sees it through window.api. The web
// build has no ledger, so every accessor here returns undefined there.
//
// These types mirror packages/desktop/src/main/spend-limits.ts structurally;
// the renderer cannot import from the desktop main process.

export type SpendLimit = { usd: number; warnAt?: number }

export type SpendLimitSet = {
  perRun?: SpendLimit
  perDay?: SpendLimit
  perMonth?: SpendLimit
  perProjectMonth?: SpendLimit
}

export type SpendPolicy = { interactive: SpendLimitSet; unattended: SpendLimitSet }

export type SpendWindowTotal = { costUsd: number; tokens: number; runs: number; unmeasuredRuns: number }

export type SpendSummary = {
  at: string
  day: string
  month: string
  all: { day: SpendWindowTotal; month: SpendWindowTotal }
  project?: { projectPath: string; day: SpendWindowTotal; month: SpendWindowTotal }
  policy: SpendPolicy
}

export type SpendEvent = {
  id: string
  projectPath: string
  runId: string
  provider: string
  model: string
  costUsd?: number
  tokens?: number
  at: string
  source: "session" | "parallel" | "scheduled"
}

export type SpendLimitsApi = {
  limits: () => Promise<SpendPolicy>
  setLimits: (next: Partial<SpendPolicy>) => Promise<SpendPolicy>
  status: (projectPath?: string) => Promise<SpendSummary>
  recent: (limit?: number) => Promise<SpendEvent[]>
}

export function spendLimitsApi() {
  return (globalThis.window?.api as (Record<string, unknown> & { spendLimits?: SpendLimitsApi }) | undefined)
    ?.spendLimits
}

const CACHE_MS = 30_000
let cached: { at: number; policy: Promise<SpendPolicy | undefined> } | undefined

// Read on every prompt submit, so the policy is cached for 30 seconds rather
// than paying an IPC round trip per message. Saving limits clears it.
export function cachedSpendPolicy(now = Date.now()) {
  const api = spendLimitsApi()
  if (!api) return Promise.resolve(undefined)
  if (cached && now - cached.at < CACHE_MS) return cached.policy
  const policy = api.limits().catch(() => undefined)
  cached = { at: now, policy }
  return policy
}

export function clearSpendPolicyCache() {
  cached = undefined
}

// The prompt budget for a foreground chat: the interactive per-run cap, when
// the user has set one.
export function interactiveRunBudget(policy: SpendPolicy | undefined) {
  const perRun = policy?.interactive.perRun
  if (!perRun || !(perRun.usd > 0)) return undefined
  return { usd: perRun.usd, ...(perRun.warnAt === undefined ? {} : { warnAt: perRun.warnAt }) }
}
