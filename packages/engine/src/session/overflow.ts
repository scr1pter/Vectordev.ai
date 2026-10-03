import type { Config } from "@/config/config"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { SessionV1 } from "@vectordevai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const output = ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax)
  const configured = input.cfg.compaction?.reserved
  const buffer = Math.min(COMPACTION_BUFFER, output)
  // Without an input limit the window keeps room for a full reply; a larger configured reserve only compacts earlier.
  const window = input.model.limit.input
    ? Math.max(0, input.model.limit.input - (configured ?? buffer))
    : Math.max(0, context - Math.max(output, configured ?? 0))
  // Past a long-context price tier every token of a request is billed at the higher rate, so compact before crossing
  // it, unless a configured reserve says where to compact.
  const tier = configured === undefined ? priceTier(input.model) : undefined
  return tier !== undefined && tier - buffer < window ? Math.max(0, tier - buffer) : window
}

function priceTier(model: Provider.Model) {
  const sizes = [
    ...(model.cost.tiers ?? []).map((item) => item.tier.size),
    ...(model.cost.experimentalOver200K ? [200_000] : []),
  ]
  return sizes.length ? Math.min(...sizes) : undefined
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}
