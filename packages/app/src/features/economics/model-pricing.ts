// Prices a run from the engine's own per-model cost catalog.
//
// Vector already knows what every model charges: the engine resolves each
// model's rates from models.dev and hands them to the renderer on
// `Provider.models[id].cost` (USD per 1M tokens, with separate cache read and
// write rates and optional context tiers). That is the same catalog the engine
// bills sessions against, so pricing here agrees with the "Total cost" the user
// sees on their session instead of drifting away from it.
//
// This module deliberately holds NO price constants. A hardcoded table can only
// ever be a stale second opinion — it goes out of date the day a provider
// changes a rate, and it silently knows nothing about models added after it was
// written. If a model has no rates, these functions return undefined so callers
// render an honest "cost unknown".

import type { TokenUsage } from "./economics-types"

// Structural subset of the SDK's `Model["cost"]`. Declared locally so this
// module doesn't depend on generated SDK types that change shape on
// regeneration; any real model cost satisfies it.
export type ModelRates = {
  /** USD per 1,000,000 input tokens. */
  input: number
  /** USD per 1,000,000 output tokens. */
  output: number
  cache: {
    /** USD per 1,000,000 tokens read from cache — typically ~0.1x input. */
    read: number
    /** USD per 1,000,000 tokens written to cache — typically 1.25x-2x input. */
    write: number
  }
  /** Higher rates that apply once a request exceeds `tier.size` tokens. */
  tiers?: readonly {
    input: number
    output: number
    cache: { read: number; write: number }
    tier: { type: "context"; size: number }
  }[]
}

export type ModelCostSource = {
  models?: Record<string, { cost?: ModelRates } | undefined>
}

// A model whose every rate is zero is either free (the anonymous gateway) or
// simply unpriced in the catalog. Either way there is no spend to report, and
// reporting $0.00 would make it look cheaper than a model that honestly costs
// something — so callers get undefined and render "cost unknown".
function priced(rates: ModelRates | undefined): ModelRates | undefined {
  if (!rates) return undefined
  if (rates.input === 0 && rates.output === 0 && rates.cache.read === 0 && rates.cache.write === 0) return undefined
  return rates
}

// Looks up a model's real rates in the engine's provider catalog. `providers`
// is the same map the rest of the app already holds (`useProviders().all()`),
// so no extra fetch is needed.
export function ratesFor(
  providers: ReadonlyMap<string, ModelCostSource> | undefined,
  providerID: string | undefined,
  modelID: string | undefined,
): ModelRates | undefined {
  if (!providers || !providerID || !modelID) return undefined
  return priced(providers.get(providerID)?.models?.[modelID]?.cost)
}

// Providers charge a higher rate above a context threshold (Gemini and the
// long-context Claude tiers both do this). Picks the rate band that actually
// applies to a request of `contextTokens`, falling back to the base rate.
export function ratesAtContext(rates: ModelRates, contextTokens: number): ModelRates {
  const applicable = (rates.tiers ?? [])
    .filter((entry) => contextTokens > entry.tier.size)
    .sort((a, b) => b.tier.size - a.tier.size)[0]
  if (!applicable) return rates
  return { input: applicable.input, output: applicable.output, cache: applicable.cache }
}

// What a run actually cost, from measured token counts and the model's real
// rates. Cache reads and writes are billed at their own rates rather than
// folded into the input rate — in an agentic coding loop cache traffic is most
// of the tokens, so charging it as input overstates spend by roughly 10x.
//
// Prefer the provider's own reported cost (`ModelOutcome.costUsd`, which the
// engine computes the same way) whenever it exists; this is for the case where
// usage was reported but cost was not.
export function costOfUsage(rates: ModelRates | undefined, usage: TokenUsage): number | undefined {
  if (!rates) return undefined
  const at = (count: number, rate: number) => (Math.max(0, count) / 1_000_000) * rate
  const tiered = ratesAtContext(rates, usage.input + usage.cacheRead + usage.cacheWrite)
  return (
    at(usage.input, tiered.input) +
    at(usage.output + usage.reasoning, tiered.output) +
    at(usage.cacheRead, tiered.cache.read) +
    at(usage.cacheWrite, tiered.cache.write)
  )
}

// Assumed output length when the caller has no better estimate — enough for a
// typical short-to-medium coding response. Callers that know the expected size
// should pass it explicitly.
const DEFAULT_ASSUMED_OUTPUT_TOKENS = 800

export type ProjectedCost = {
  rates: ModelRates
  inputTokens: number
  assumedOutputTokens: number
  inputCost: number
  outputCost: number
  totalCost: number
}

// Forward-looking estimate: what one more turn of this size would cost on this
// model. Input tokens are treated as uncached, which is the conservative
// direction — a warm cache only makes the real turn cheaper than quoted.
export function projectCost(
  rates: ModelRates | undefined,
  inputTokens: number,
  assumedOutputTokens = DEFAULT_ASSUMED_OUTPUT_TOKENS,
): ProjectedCost | undefined {
  if (!rates) return undefined

  const input = Math.max(0, Math.round(inputTokens))
  const output = Math.max(0, Math.round(assumedOutputTokens))
  const tiered = ratesAtContext(rates, input)
  const inputCost = (input / 1_000_000) * tiered.input
  const outputCost = (output / 1_000_000) * tiered.output

  return {
    rates: tiered,
    inputTokens: input,
    assumedOutputTokens: output,
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
  }
}
