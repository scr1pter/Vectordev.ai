/** Models included with Vector: OpenCode Zen's zero-cost models, which run with no key. The
    model dialog lists them in one section, and everywhere the TUI names a model it names them
    without the "Free" their catalogue names carry. No context or component imports here, so
    both sides can use it. */

/** OpenCode Zen's provider ids, and the key Zen runs on with no sign-in and no Zen key, when
    only its zero-cost models load. */
const ZEN_PROVIDER_IDS: ReadonlySet<string> = new Set(["opencode", "opencode-zen"])
const ZEN_PUBLIC_KEY = "public"

/** The desktop app's rule (includedModel in packages/app/src/utils/provider-brand.ts), so both
    list the same models. Zero cost from OpenCode Zen means included only for its catalogue
    models, which carry a release date, or when it runs keyless: a model defined only in config
    defaults to zero cost, and on a Zen key it bills the Zen balance. */
export function isIncluded(
  provider: { id: string; options?: Record<string, unknown> },
  model: { cost?: { input?: number }; release_date?: string },
) {
  if (!ZEN_PROVIDER_IDS.has(provider.id) || model.cost?.input !== 0) return false
  return Boolean(model.release_date) || provider.options?.apiKey === ZEN_PUBLIC_KEY
}

/** Included catalogue names often end in "Free" or "(Free)"; the section already says how
    they're paid for. */
export function includedModelName(name: string) {
  return name.replace(/\s+(?:\(free\)|free)\s*$/i, "").trim() || name
}

/** What the TUI prints where it would name an included model's provider. An included row names
    no provider, as in the model dialog and the desktop app: the catalogue's "OpenCode Zen" isn't
    how Vector offers it. */
const INCLUDED_PROVIDER_LABEL = "Included with Vector"

/** The provider name beside a model on the prompt line. */
export function modelProviderName(
  provider: { id: string; name?: string; options?: Record<string, unknown> },
  model: { cost?: { input?: number }; release_date?: string },
) {
  return isIncluded(provider, model) ? INCLUDED_PROVIDER_LABEL : (provider.name ?? provider.id)
}

/** A model's name wherever the TUI shows one: the prompt line, message headers, transcripts. */
export function modelDisplayName(
  provider: { id: string; options?: Record<string, unknown> },
  model: { id: string; name?: string; cost?: { input?: number }; release_date?: string },
) {
  const name = model.name ?? model.id
  return isIncluded(provider, model) ? includedModelName(name) : name
}
