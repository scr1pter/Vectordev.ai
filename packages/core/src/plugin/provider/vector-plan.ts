import { Effect, Stream } from "effect"
import { EventV2 } from "../../event"
import { Integration } from "../../integration"
import { FreeModels } from "../../free-models"
import { ModelPlans } from "../../model-plans"
import { define } from "../internal"

/** Vector Codium: the signed-in account's managed coding models, listed from vectordev.ai and never from configuration. */
export const VectorPlanPlugin = define({
  id: "vector-plan",
  effect: Effect.fn(function* (ctx) {
    const plans = yield* ModelPlans.Service
    const credentials = yield* FreeModels.CredentialsService
    const events = yield* EventV2.Service
    yield* ctx.catalog.transform(
      Effect.fn(function* (catalog) {
        const token = yield* credentials.get("vector")
        const current = yield* plans.catalog(token)
        // Account entitlements, prices and destinations cannot come from repository configuration.
        catalog.provider.remove(ModelPlans.PROVIDER_ID)
        if (!current.enabled) return
        catalog.provider.update(ModelPlans.PROVIDER_ID, (provider) => {
          provider.name = ModelPlans.PROVIDER_NAME
          provider.disabled = false
          provider.api = { type: "aisdk", package: "@ai-sdk/openai-compatible", url: ModelPlans.API_URL }
        })
        for (const model of current.models)
          catalog.model.update(ModelPlans.PROVIDER_ID, model.id, (draft) => {
            draft.name = model.name
            draft.api = { id: model.id, type: "aisdk", package: "@ai-sdk/openai-compatible", url: ModelPlans.API_URL }
            draft.capabilities = { tools: true, input: ["text"], output: ["text"] }
            // Ceiling prices per million tokens; the recorded cost prefers what the gateway reports it billed.
            draft.cost = [
              {
                input: model.inputPrice,
                output: model.outputPrice,
                cache: { read: model.inputPrice, write: model.inputPrice },
              },
            ]
            draft.limit = { context: model.contextLength, output: model.maxOutputTokens }
            draft.enabled = true
          })
      }),
    )
    yield* events.subscribe(Integration.Event.Updated).pipe(
      Stream.runForEach(() => ctx.catalog.reload()),
      Effect.forkScoped({ startImmediately: true }),
    )
    // A plan bought or cancelled in the browser shows up without restarting Vector.
    yield* Effect.forever(Effect.sleep("1 minute").pipe(Effect.andThen(ctx.catalog.reload()))).pipe(Effect.forkScoped())
  }),
})
