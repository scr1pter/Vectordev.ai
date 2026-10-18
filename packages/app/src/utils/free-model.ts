import { freeModelMayTrain, type FreeModelChoice } from "@vectordevai/core/free-model-choice"
import { FREE_ROUTER_ID } from "@vectordevai/schema/free-model"

type FreeCandidate = { id: string; limit: { context: number }; freeModel?: FreeModelChoice["freeModel"] }

/**
 * The largest-context model served through the user's own OpenRouter account, preferring one whose provider does not
 * train on prompts: Vector never picks a "May train on your prompts" model for the user ahead of a no-training one.
 * Price and `:free` suffixes are never treated as eligibility; only server-approved metadata is, so a paid or shared
 * model can never be chosen here.
 */
export function bestOwnFreeModel<T extends FreeCandidate>(models: readonly T[]) {
  return (
    models
      // OpenRouter's free router picks a model at random, so it is never chosen for the user.
      .filter((model) => model.freeModel?.source === "openrouter" && model.id !== FREE_ROUTER_ID)
      .toSorted(
        (a, b) => Number(freeModelMayTrain(a)) - Number(freeModelMayTrain(b)) || b.limit.context - a.limit.context,
      )[0]
  )
}
