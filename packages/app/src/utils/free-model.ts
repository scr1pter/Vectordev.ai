type FreeCandidate = { id: string; limit: { context: number }; freeModel?: { source: string } }

/**
 * The largest-context model served through the user's own OpenRouter account. Price and `:free`
 * suffixes are never treated as eligibility; only server-approved metadata is, so a paid or shared
 * model can never be chosen here.
 */
export function bestOwnFreeModel<T extends FreeCandidate>(models: readonly T[]) {
  return models
    .filter((model) => model.freeModel?.source === "openrouter")
    .toSorted((a, b) => b.limit.context - a.limit.context)[0]
}
