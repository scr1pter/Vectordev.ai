// Which model a review runs on (section 2.9), what it costs (section 5.5), and the 32k context floor.

import { providerCredentialAllowed } from "@opencode-ai/core/provider-policy"
import { Effect, Schema } from "effect"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { contextRefusal, type ReviewPrice } from "@opencode-ai/core/review/plan"
import type { CostKind, Trigger } from "@opencode-ai/core/review/types"
import type { ProviderV2 } from "@opencode-ai/core/provider"
import type { ModelV2 } from "@opencode-ai/core/model"

export interface ResolvedModel {
  providerID: ProviderV2.ID
  modelID: ModelV2.ID
  variant?: string
  context: number
  price?: ReviewPrice // only for "priced": the dollar cap needs a price
  costKind: CostKind
}

export class ReviewModelError extends Schema.TaggedErrorClass<ReviewModelError>()("ReviewModelError", {
  message: Schema.String,
}) {}

export interface ResolveInput {
  trigger: Trigger
  flag?: string // `vector review --model`
  config?: string // `model` from .vector/review.json
  env?: Record<string, string | undefined> // MODEL and REVIEW_AUTO_MODEL; process.env by default
}

// CI (auto and command): REVIEW_AUTO_MODEL for automatic runs only, then review.json, then MODEL.
// Project config is disabled in CI, so a pull request cannot choose the model through
// agent.review.model.
// Local (local and desktop): --model, review.json, agent.review.model from the user's config, the configured
// default model. A provider must be configured before any review can run.
export const resolveReviewModel = Effect.fn("ReviewModel.resolve")(function* (input: ResolveInput) {
  const env = input.env ?? process.env
  const provider = yield* Provider.Service
  const config = yield* Config.Service
  const auth = yield* Auth.Service

  const ci = input.trigger === "auto" || input.trigger === "command"
  const agent = ci ? undefined : (yield* config.get()).agent?.["review"]
  const chosen = ci
    ? first([input.trigger === "auto" ? env.REVIEW_AUTO_MODEL : undefined, input.config, env.MODEL])
    : first([input.flag, input.config, agent?.model])
  const configured = chosen || ci ? undefined : yield* provider.defaultModel().pipe(Effect.option)
  const name =
    chosen ?? (configured?._tag === "Some" ? `${configured.value.providerID}/${configured.value.modelID}` : undefined)

  if (!name)
    return yield* new ReviewModelError({
      message: ci
        ? "No review model is set. Set MODEL or REVIEW_AUTO_MODEL in the workflow, or model in .vector/review.json, and provide that provider's key."
        : "No review model is set. Pass --model, set model in .vector/review.json, or connect a provider in Vector.",
    })

  const ref = Provider.parseModel(name)
  if (!ref.providerID || !ref.modelID)
    return yield* new ReviewModelError({
      message: `Invalid model ${name}. Model must be in the format "provider/model".`,
    })
  const model = yield* provider.getModel(ref.providerID, ref.modelID).pipe(
    Effect.catch(() =>
      Effect.fail(
        new ReviewModelError({
          message: `${name} is not available. Check the provider and its key.`,
        }),
      ),
    ),
  )
  const refusal = contextRefusal(name, model.limit.context)
  if (refusal) return yield* new ReviewModelError({ message: refusal })

  const signIn = yield* auth.get(model.providerID).pipe(Effect.catch(() => Effect.succeed(undefined)))
  const listed = model.cost.input > 0 || model.cost.output > 0
  const costKind: CostKind =
    signIn?.type === "oauth" && providerCredentialAllowed(model.providerID, signIn)
      ? "plan"
      : listed
        ? "priced"
        : "unknown"

  return {
    providerID: model.providerID,
    modelID: model.id,
    // The agent's variant applies only when the agent's own model was chosen, as elsewhere in the engine.
    ...(chosen && chosen === agent?.model && agent.variant ? { variant: agent.variant } : {}),
    context: model.limit.context,
    ...(costKind === "priced"
      ? {
          price: {
            input: model.cost.input,
            output: model.cost.output,
            ...(model.cost.cache.read > 0 ? { cacheRead: model.cost.cache.read } : {}),
            ...(model.cost.cache.write > 0 ? { cacheWrite: model.cost.cache.write } : {}),
          },
        }
      : {}),
    costKind,
  } satisfies ResolvedModel
})

function first(values: (string | undefined)[]) {
  return values.map((value) => value?.trim()).find((value): value is string => !!value)
}

export * as ReviewModel from "./model"
