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
// Some catalogs price input in bands from 32K up; only the long-context tiers, at 200K and beyond, set where to
// compact. Below that, compaction would follow almost every step.
const LONG_CONTEXT_TIER = 200_000
// A ceiling under this would leave little more room than the fixed system prompt and tools take.
const MIN_MAX_CONTEXT = 64_000

// Room an agent needs beyond its fixed prompt, for the conversation and the reply: a quarter of the fixed prompt, and
// never less than this.
export const HEADROOM = 4_096

/**
 * The context an agent needs on a model: its fixed prompt (the system prompt and tool definitions, measured for that
 * agent on that model) plus headroom. An agent with no fixed prompt has nothing that must fit.
 */
export function requirement(fixed: number) {
  if (fixed <= 0) return 0
  return fixed + Math.max(HEADROOM, Math.ceil(fixed / 4))
}

/**
 * Why a model cannot run an agent whose fixed prompt takes `fixed` tokens, or undefined when it can. A model with no
 * listed context is refused too: its window is unknown, so it would never compact and Vector cannot tell what fits.
 */
export function refusal(input: { model: Provider.Model; fixed: number; agent: string }) {
  const needed = requirement(input.fixed)
  const context = input.model.limit.input || input.model.limit.context
  if (needed === 0 || context >= needed) return undefined
  const about = (Math.ceil(needed / 1_000) * 1_000).toLocaleString("en-US")
  const role = MAIN_AGENTS.has(input.agent) ? "Vector's agent" : `Vector's ${input.agent} agent`
  if (context === 0)
    return `${input.model.id} has no listed context size. ${role} needs about ${about} tokens. Set limit.context for this model in your config, or pick another model.`
  const size = context.toLocaleString("en-US")
  // "an 8,192-token context", "an 11,000-token context", "a 16,384-token context".
  const article = /^(8|1[18](,|$))/.test(size) ? "an" : "a"
  return `${input.model.id} has ${article} ${size}-token context. ${role} needs about ${about}. Raise the context size (Ollama: num_ctx) or pick another model.`
}

const MAIN_AGENTS = new Set(["build", "plan", "quick", "research"])

// There is no fallback window for a model with no listed context: guessing one (8K was proposed) would compact on
// every step for most models. Such a model never compacts on its own; the agent refuses it on a server someone hosts.
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
  if (setting !== undefined) return Math.max(setting, MIN_MAX_CONTEXT)
  if (reserved !== undefined) return undefined
  return priceTier(model) ?? (model.limit.context >= LARGE_WINDOW ? DEFAULT_MAX_CONTEXT : undefined)
}

// models.dev keeps context_over_200k as a 200K stand-in for older readers next to the exact tiers, so the stand-in
// counts only for a model without tiers, as pricing treats it.
function priceTier(model: Provider.Model) {
  const tiers = (model.cost.tiers ?? []).map((item) => item.tier.size)
  const sizes = (tiers.length ? tiers : model.cost.experimentalOver200K ? [200_000] : []).filter(
    (size) => size >= LONG_CONTEXT_TIER,
  )
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
