import { Effect, Stream } from "effect"
import { EventV2 } from "../../event"
import { Integration } from "../../integration"
import { FreeModels } from "../../free-models"
import { freeModelDataPolicy, sendsToOpenRouterFree } from "../../free-model-catalog"
import { freeModelCatalogName } from "../../free-model-choice"
import type { CatalogDraft } from "@vectordevai/plugin/v2/promise"
import { define } from "../internal"

export const VectorPlugin = define({
  id: "vector",
  effect: Effect.fn(function* (ctx) {
    const freeModels = yield* FreeModels.Service
    const credentials = yield* FreeModels.CredentialsService
    const events = yield* EventV2.Service
    yield* ctx.catalog.transform(
      Effect.fn(function* (catalog) {
        const current = yield* freeModels.catalog()
        const vector = yield* credentials.get("vector")
        const openrouter = yield* credentials.get("openrouter")
        const owned = openrouter ? yield* freeModels.forKey(openrouter) : []
        if (openrouter) catalog.provider.update("openrouter", () => {})
        // OpenRouter models that run on free endpoints, zero-price ones and its free router included, return below
        // only as the free models the catalogs list.
        removeOpenRouterFree(catalog)
        // Vector's provider is the shared allowance, so it needs a Vector sign-in; an OpenRouter key of the user's
        // own lists that account's copies under OpenRouter instead.
        if (current.enabled)
          catalog.provider.update("vector", (provider) => {
            provider.name = "Vector"
            provider.disabled = !vector
            provider.api = {
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
              url: "https://vectordev.ai/api/free-models",
            }
          })
        for (const model of current.enabled ? current.models : []) {
          catalog.model.update("vector", model.id, (draft) => {
            draft.name = freeModelCatalogName(model)
            draft.api = {
              id: model.id,
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
              url: "https://vectordev.ai/api/free-models",
            }
            draft.capabilities = { tools: true, input: ["text"], output: ["text"] }
            draft.cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
            draft.limit = { context: model.contextLength, output: model.maxOutputTokens }
            // A shared selection stays on the shared allowance whichever OpenRouter account is connected.
            draft.enabled = true
            draft.freeModel = { source: "shared", dataPolicy: freeModelDataPolicy(model) }
          })
        }
        for (const model of owned) {
          catalog.model.update("openrouter", model.id, (draft) => {
            draft.name = freeModelCatalogName(model)
            draft.api = {
              id: model.id,
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
              url: FreeModels.OPENROUTER_ROOT,
            }
            draft.capabilities = { tools: true, input: ["text"], output: ["text"] }
            draft.cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
            draft.limit = { context: model.contextLength, output: model.maxOutputTokens }
            draft.enabled = true
            draft.freeModel = { source: "openrouter", dataPolicy: freeModelDataPolicy(model) }
          })
        }
      }),
    )
    yield* events.subscribe(Integration.Event.Updated).pipe(
      Stream.runForEach(() => ctx.catalog.reload()),
      Effect.forkScoped({ startImmediately: true }),
    )
    // A catalog first read as OFF (a cached answer served at startup) must not hide models that turn on later.
    yield* freeModels.changes.pipe(
      Stream.runForEach(() => ctx.catalog.reload()),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* Effect.forever(Effect.sleep("5 minutes").pipe(Effect.andThen(ctx.catalog.reload()))).pipe(
      Effect.forkScoped(),
    )
  }),
})

/**
 * Repository configuration loads after the provider plugins, so it can add a free OpenRouter model back, under its own
 * name or another, or under a provider of another name pointed at openrouter.ai. This runs after it. The runner sends
 * any such model only through the free-model route, which refuses it; this keeps it out of the lists too.
 */
export const FreeModelGuardPlugin = define({
  id: "free-model-guard",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform(
      Effect.fn(function* (catalog) {
        removeOpenRouterFree(catalog)
      }),
    )
  }),
})

// Free models listed by Vector itself carry `freeModel` and stay; the shared allowance's provider is Vector's own.
function removeOpenRouterFree(catalog: CatalogDraft) {
  for (const item of catalog.provider.list()) {
    if (item.provider.id === "vector") continue
    for (const model of item.models.values()) {
      if (
        !model.freeModel &&
        sendsToOpenRouterFree({
          providerID: item.provider.id,
          id: model.id,
          apiID: model.api.id,
          destinations: [
            model.api.url,
            model.request.body.baseURL,
            model.api.type === "aisdk" ? model.api.package : undefined,
            item.provider.api.url,
            item.provider.request.body.baseURL,
            item.provider.api.type === "aisdk" ? item.provider.api.package : undefined,
          ],
          price: model.cost.find((cost) => !cost.tier),
        })
      )
        catalog.model.remove(item.provider.id, model.id)
    }
  }
}
