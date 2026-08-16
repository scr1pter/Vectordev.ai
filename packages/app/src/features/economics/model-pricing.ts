// Real, public per-1M-token USD list prices for common models, keyed by
// substring match on the model id string. Prices are hardcoded snapshots of
// each provider's published pricing (see the "as of" date on each entry) —
// never inferred or guessed. If a model id doesn't match any entry,
// estimatePromptCost returns undefined so callers can render an honest
// "cost unknown" rather than a fabricated number.

export type ModelPricing = {
  /** USD per 1,000,000 input tokens. */
  inputPer1M: number
  /** USD per 1,000,000 output tokens. */
  outputPer1M: number
  /** Date this price was last confirmed against the provider's public pricing page. */
  asOf: string
  label: string
}

type PricingRule = { match: string; pricing: ModelPricing }

// Order matters: entries are matched top-to-bottom by substring, so a more
// specific id (e.g. "gpt-4o-mini") must precede any id it's a substring of
// (e.g. "gpt-4o") or it would never be reached.
const PRICING_TABLE: PricingRule[] = [
  {
    match: "gpt-4o-mini",
    pricing: { inputPer1M: 0.15, outputPer1M: 0.6, asOf: "2024-08-06", label: "GPT-4o mini" },
  },
  {
    match: "gpt-4o",
    pricing: { inputPer1M: 2.5, outputPer1M: 10, asOf: "2024-08-06", label: "GPT-4o" },
  },
  {
    // OpenAI cut o3 pricing ~80% on 2025-06-10 (from $10/$40 to $2/$8 per 1M).
    match: "o3",
    pricing: { inputPer1M: 2, outputPer1M: 8, asOf: "2025-06-10", label: "OpenAI o3" },
  },
  {
    // Tiered by context length at GA; this is the <=200K-token tier.
    match: "gemini-2.5-pro",
    pricing: { inputPer1M: 1.25, outputPer1M: 10, asOf: "2025-06-17", label: "Gemini 2.5 Pro (<=200K context)" },
  },
  {
    // GA pricing folds "thinking" tokens into the single output rate.
    match: "gemini-2.5-flash",
    pricing: { inputPer1M: 0.3, outputPer1M: 2.5, asOf: "2025-06-17", label: "Gemini 2.5 Flash" },
  },
  {
    match: "claude-haiku",
    pricing: { inputPer1M: 1, outputPer1M: 5, asOf: "2026-06-24", label: "Claude Haiku 4.5" },
  },
  {
    match: "claude-sonnet",
    pricing: { inputPer1M: 3, outputPer1M: 15, asOf: "2026-06-24", label: "Claude Sonnet 5" },
  },
  {
    match: "claude-opus",
    pricing: { inputPer1M: 5, outputPer1M: 25, asOf: "2026-06-24", label: "Claude Opus 4.8" },
  },
  {
    // DeepSeek-V3 (deepseek-chat) standard rate; DeepSeek also offers a lower
    // off-peak / cache-hit rate not modeled here.
    match: "deepseek",
    pricing: { inputPer1M: 0.27, outputPer1M: 1.1, asOf: "2025-02-01", label: "DeepSeek-V3 (deepseek-chat)" },
  },
]

export function findModelPricing(model: string): ModelPricing | undefined {
  const normalized = model.trim().toLowerCase()
  if (!normalized) return undefined
  return PRICING_TABLE.find((entry) => normalized.includes(entry.match))?.pricing
}

// Cost of a run from its MEASURED token counts, for the case where a provider
// reported usage but no cost. Prefer the provider's own reported cost whenever
// it exists — this is a fallback, and it returns undefined for unpriced models
// rather than inventing a number. Cache reads are billed at the input rate
// here, which slightly over-states spend on providers that discount them.
export function costFromUsage(
  model: string,
  usage: { input: number; output: number; reasoning: number; cacheRead: number },
): number | undefined {
  const pricing = findModelPricing(model)
  if (!pricing) return undefined
  const inputTokens = Math.max(0, usage.input) + Math.max(0, usage.cacheRead)
  const outputTokens = Math.max(0, usage.output) + Math.max(0, usage.reasoning)
  return (inputTokens / 1_000_000) * pricing.inputPer1M + (outputTokens / 1_000_000) * pricing.outputPer1M
}

// Rough token estimate: ~4 characters per token, the same ballpark heuristic
// providers themselves publish for sizing prompts without a real tokenizer.
const CHARS_PER_TOKEN = 4

// Assumed output length when the caller doesn't have a better estimate —
// enough for a typical short-to-medium coding response. Callers with a real
// expected output size should pass it explicitly.
const DEFAULT_ASSUMED_OUTPUT_TOKENS = 800

export type PromptCostEstimate = {
  model: string
  pricing: ModelPricing
  estimatedInputTokens: number
  assumedOutputTokens: number
  estimatedInputCost: number
  estimatedOutputCost: number
  estimatedTotalCost: number
}

// Prospective estimate from a token count the caller already knows. Prefer
// this over estimatePromptCost whenever real token counts are available —
// going through characters only to divide them back out loses precision and
// invites the caller to fabricate a character count it never measured.
export function estimateCostForTokens(
  model: string,
  inputTokens: number,
  assumedOutputTokens = DEFAULT_ASSUMED_OUTPUT_TOKENS,
): PromptCostEstimate | undefined {
  const pricing = findModelPricing(model)
  if (!pricing) return undefined

  const estimatedInputTokens = Math.max(0, Math.round(inputTokens))
  const estimatedInputCost = (estimatedInputTokens / 1_000_000) * pricing.inputPer1M
  const estimatedOutputCost = (Math.max(0, assumedOutputTokens) / 1_000_000) * pricing.outputPer1M

  return {
    model,
    pricing,
    estimatedInputTokens,
    assumedOutputTokens,
    estimatedInputCost,
    estimatedOutputCost,
    estimatedTotalCost: estimatedInputCost + estimatedOutputCost,
  }
}

export function estimatePromptCost(
  model: string,
  promptChars: number,
  assumedOutputTokens = DEFAULT_ASSUMED_OUTPUT_TOKENS,
): PromptCostEstimate | undefined {
  const pricing = findModelPricing(model)
  if (!pricing) return undefined // unknown model — honest "cost unknown", never guess

  const estimatedInputTokens = Math.ceil(Math.max(0, promptChars) / CHARS_PER_TOKEN)
  const estimatedInputCost = (estimatedInputTokens / 1_000_000) * pricing.inputPer1M
  const estimatedOutputCost = (Math.max(0, assumedOutputTokens) / 1_000_000) * pricing.outputPer1M

  return {
    model,
    pricing,
    estimatedInputTokens,
    assumedOutputTokens,
    estimatedInputCost,
    estimatedOutputCost,
    estimatedTotalCost: estimatedInputCost + estimatedOutputCost,
  }
}
