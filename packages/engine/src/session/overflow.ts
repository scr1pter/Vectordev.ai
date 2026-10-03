import type { Config } from "@/config/config"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { SessionV1 } from "@vectordevai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000
// Where sessions compact by default on 1M-class models, as Claude Code compacts within a 200K window. Every request
// re-sends the whole conversation, so a step at 900K costs several times one at 200K.
export const DEFAULT_MAX_CONTEXT = 200_000
const LARGE_WINDOW = 500_000

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
  const ceiling = maxContext(input.cfg.compaction?.max_context, input.model, configured)
  return ceiling !== undefined && ceiling - buffer < window ? Math.max(0, ceiling - buffer) : window
}

// Past a long-context price tier every token of a request is billed at the higher rate, so by default sessions
// compact before crossing it, and 1M-class models without a tier compact at DEFAULT_MAX_CONTEXT. A configured reserve
// without a configured ceiling keeps its own window, as it did before the ceiling existed.
function maxContext(setting: number | undefined, model: Provider.Model, reserved: number | undefined) {
  if (setting === 0) return undefined
  if (setting !== undefined) return setting
  if (reserved !== undefined) return undefined
  return priceTier(model) ?? (model.limit.context >= LARGE_WINDOW ? DEFAULT_MAX_CONTEXT : undefined)
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
