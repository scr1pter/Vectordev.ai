// What a review runs and what it may cost: which specialists, how much diff fits a model's context, and the cost
// estimates behind the budget checks (sections 5.2 and 5.3). Pure and browser-safe.

import type { DiffFile } from "./diff"
import { isSensitivePath } from "./ignore"
import type { ReviewConfig } from "./types"

export type Specialist = "review" | "security"

export const MIN_CONTEXT = 32_000

// Tokens a step adds to the context before the next one: tool results and the model's own output.
export const NEXT_STEP_SLACK = 3_000

// USD per million tokens, as models.dev lists them.
export interface ReviewPrice {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

// Estimate constants: output tokens per step, and how many tokens each step adds to the next one's input. S and R
// fitted 2026-09-14 on a live opencode/big-pickle review of a 5-file change: the review and security sessions took
// 5 and 4 steps, and R = 2,000 makes S·P + R·S·(S−1)/2 match their measured 79.3k input tokens. HIGH_GROWTH is
// unchanged (the largest one-step growth was 4,032). That run averaged 1,800 output tokens a step, reasoning
// included; OUTPUT_PER_STEP also prices the budget check's next step, so it stays until a priced run confirms it.
const OUTPUT_PER_STEP = 600
const LOW_STEPS = 5
const LOW_GROWTH = 2_000
const HIGH_GROWTH = 4_000

// `review` always runs. `security` runs when it is "always", or "auto" and a sensitive path changed.
export function planSpecialists(
  files: Pick<DiffFile, "path" | "oldPath">[],
  config: Pick<ReviewConfig, "security">,
): Specialist[] {
  if (config.security === "off") return ["review"]
  if (config.security === "always") return ["review", "security"]
  const sensitive = files.some(
    (file) => isSensitivePath(file.path) || (!!file.oldPath && isSensitivePath(file.oldPath)),
  )
  return sensitive ? ["review", "security"] : ["review"]
}

// Characters of diff to inline for a model: 30% of the context left after a reserve, at 3.5 characters a token,
// clamped to 8,000..maxDiffChars. That is 16.8k at 32k of context, 79.8k at 128k, and the cap at 1M.
export function diffBudgetChars(context: number, maxDiffChars: number): number {
  const reserve = Math.min(52_000, Math.floor(context / 2))
  // × 3.5 × 0.3 = × 21/20, kept in integers so the result is exact.
  const chars = Math.floor(((context - reserve) * 21) / 20)
  return Math.min(Math.max(chars, 8_000), maxDiffChars)
}

// The refusal for a model below MIN_CONTEXT, or undefined when it is large enough.
export function contextRefusal(model: string, context: number): string | undefined {
  if (context >= MIN_CONTEXT) return undefined
  const size = context > 0 ? `${Math.round(context / 1000)}k` : "no listed context size"
  return `Vecbot reviews need a model with at least 32k tokens of context; ${model} has ${size}.`
}

function usd(tokens: number, perMillion: number) {
  return (tokens * perMillion) / 1_000_000
}

// A range for a review of a prompt of P tokens. Over S steps the input is S·P plus the growth R·S·(S−1)/2, and the
// output S·600. Low: S = 5 (or maxSteps if lower) and R = 2,000, with the cache-read price for (S−1)·P when one is
// known. High: S = maxSteps and R = 4,000, all at the full input price.
export function estimateCostUsd(input: { promptTokens: number; maxSteps: number; price: ReviewPrice }): {
  low: number
  high: number
} {
  const { promptTokens, price } = input
  const high = Math.max(1, Math.floor(input.maxSteps))
  const low = Math.min(LOW_STEPS, high)
  const cached = price.cacheRead === undefined ? 0 : (low - 1) * promptTokens
  const lowInput = low * promptTokens - cached + (LOW_GROWTH * low * (low - 1)) / 2
  const highInput = high * promptTokens + (HIGH_GROWTH * high * (high - 1)) / 2
  return {
    low: usd(lowInput, price.input) + usd(cached, price.cacheRead ?? 0) + usd(low * OUTPUT_PER_STEP, price.output),
    high: usd(highInput, price.input) + usd(high * OUTPUT_PER_STEP, price.output),
  }
}

// What the next step of a session will cost: its whole context as input plus one step of output. `cachedTokens` is
// the part the provider reported as cache reads on the last step; it is charged at the cache-read price when there
// is one. Callers pass the last step's context plus NEXT_STEP_SLACK.
export function nextStepCostUsd(contextTokens: number, price: ReviewPrice, cachedTokens = 0): number {
  const cached = price.cacheRead === undefined ? 0 : Math.min(Math.max(cachedTokens, 0), contextTokens)
  return (
    usd(contextTokens - cached, price.input) + usd(cached, price.cacheRead ?? 0) + usd(OUTPUT_PER_STEP, price.output)
  )
}
