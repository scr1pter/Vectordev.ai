import { isFreeModel } from "@vectordevai/schema/free-model"
// Which model a review runs on (section 2.9), what it costs (section 5.5), and the 32k context floor.

import { providerCredentialAllowed } from "@vectordevai/core/provider-policy"
import { Effect, Schema } from "effect"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
import { contextRefusal, type ReviewPrice } from "@vectordevai/core/review/plan"
import { WORKFLOW_FILE } from "@vectordevai/core/review/workflow"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import type { CostKind, Trigger } from "@vectordevai/core/review/types"
import type { ProviderV2 } from "@vectordevai/core/provider"
import type { ModelV2 } from "@vectordevai/core/model"

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
// default model. CI may use an available free model without a provider key.
export const resolveReviewModel = Effect.fn("ReviewModel.resolve")(function* (input: ResolveInput) {
  const env = input.env ?? process.env
  const provider = yield* Provider.Service
  const config = yield* Config.Service
  const auth = yield* Auth.Service
  const catalog = yield* ModelCatalog.Service

  const ci = input.trigger === "auto" || input.trigger === "command"
  const agent = ci ? undefined : (yield* config.get()).agent?.["review"]
  const chosen = ci
    ? first([input.trigger === "auto" ? env.REVIEW_AUTO_MODEL : undefined, input.config, env.MODEL])
    : first([input.flag, input.config, agent?.model])
  const free =
    chosen || !ci
      ? undefined
      : Object.values(yield* provider.list())
          .flatMap((item) => Object.values(item.models))
          .find(isFreeModel)
  const configured = chosen || ci ? undefined : yield* provider.defaultModel().pipe(Effect.option)
  const name =
    chosen ??
    (free ? `${free.providerID}/${free.id}` : undefined) ??
    (configured?._tag === "Some" ? `${configured.value.providerID}/${configured.value.modelID}` : undefined)

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
    Effect.catch((error) =>
      Effect.gen(function* () {
        if (!ci)
          return yield* new ReviewModelError({ message: `${name} is not available. Check the provider and its key.` })
        const listed = (yield* catalog.get())[ref.providerID]
        return yield* new ReviewModelError({ message: workflowRefusal(name, ref.modelID, listed, error) })
      }),
    ),
  )
  const refusal = contextRefusal(name, model.limit.context)
  if (refusal) return yield* new ReviewModelError({ message: refusal })

  const signIn = yield* auth.get(model.providerID).pipe(Effect.catch(() => Effect.succeed(undefined)))
  const costKind = SpendGuard.costKindOf({
    free: isFreeModel(model),
    oauthPlan:
      signIn?.type === "oauth" &&
      providerCredentialAllowed(model.providerID, signIn, Boolean(model.api.npm || model.api.url)),
    listed: model.cost.input > 0 || model.cost.output > 0,
  })

  return {
    providerID: model.providerID,
    modelID: model.id,
    // The agent's variant applies only when the agent's own model was chosen, as elsewhere in the engine.
    ...(chosen && chosen === agent?.model && agent.variant ? { variant: agent.variant } : {}),
    context: model.limit.context,
    ...(costKind === "priced" ? { price: SpendGuard.priceOf(model.cost) } : {}),
    costKind,
  } satisfies ResolvedModel
})

// Why a workflow's model cannot run. A missing secret is the usual cause: the provider is in the catalog but never
// loaded, because the review step's env does not pass its key. Only a provider Vector no longer lists means the
// workflow itself is out of date.
function workflowRefusal(
  name: string,
  modelID: string,
  listed: ModelCatalog.Provider | undefined,
  error: Provider.ModelNotFoundError,
) {
  if (error.unavailable) return `${name} cannot run in this workflow. ${error.unavailable.message}`
  if (!listed) return "This workflow was set up by an older Vector; run vector github install again."
  if (!Object.hasOwn(listed.models, modelID)) {
    const suggestions = error.suggestions?.length ? ` Did you mean ${error.suggestions.join(", ")}?` : ""
    return `${listed.name} has no model ${modelID}.${suggestions} Set MODEL in ${WORKFLOW_FILE} to one of its models, or run vector github install again.`
  }
  const keys = listed.env.length ? listed.env.join(" or ") : `${listed.name}'s credentials`
  return `${name} needs ${keys}. Add it as a repository secret and pass it to the Review step in ${WORKFLOW_FILE}.`
}

function first(values: (string | undefined)[]) {
  return values.map((value) => value?.trim()).find((value): value is string => !!value)
}

export * as ReviewModel from "./model"
