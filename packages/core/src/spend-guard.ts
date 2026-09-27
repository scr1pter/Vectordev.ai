export * as SpendGuard from "./spend-guard"

// What a run may spend and when it must stop. The pure rules below decide; Vectorscope shares costKindOf and
// priceOf so a review and the run guard agree on which models can be priced.

import type { ReviewPrice } from "./review/plan"
import type { CostKind } from "./review/types"

export type { CostKind }

// The order matters: a free model with a catalog price is still free, and an OAuth plan with a catalog price is
// billed by the plan, not per token.
export function costKindOf(input: { free: boolean; listed: boolean; oauthPlan: boolean }): CostKind {
  if (input.free) return "free"
  if (input.oauthPlan) return "plan"
  if (input.listed) return "priced"
  return "unknown"
}

// Catalog rates in USD per million tokens. A model with no input and no output rate has no price.
export function priceOf(cost: {
  input: number
  output: number
  cache?: { read?: number; write?: number }
}): ReviewPrice | undefined {
  if (cost.input === 0 && cost.output === 0) return undefined
  return {
    input: cost.input,
    output: cost.output,
    ...((cost.cache?.read ?? 0) > 0 ? { cacheRead: cost.cache?.read } : {}),
    ...((cost.cache?.write ?? 0) > 0 ? { cacheWrite: cost.cache?.write } : {}),
  }
}
