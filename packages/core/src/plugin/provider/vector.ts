import { Effect, Stream } from "effect"
import { EventV2 } from "../../event"
import { Integration } from "../../integration"
import { FreeModels } from "../../free-models"
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
        for (const item of catalog.provider.list()) {
          if (item.provider.id !== "openrouter") continue
          for (const model of item.models.values()) {
            if (model.id.toLowerCase().endsWith(":free")) catalog.model.remove("openrouter", model.id)
          }
        }
        if (current.enabled)
          catalog.provider.update("vector", (provider) => {
            provider.name = "Vector"
            provider.disabled = !vector && !openrouter
            provider.api = {
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
              url: "https://vectordev.ai/api/free-models",
            }
          })
        for (const model of current.enabled ? current.models : []) {
          catalog.model.update("vector", model.id, (draft) => {
            draft.name = model.name
            draft.api = {
              id: model.id,
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
              url: "https://vectordev.ai/api/free-models",
            }
            draft.capabilities = { tools: true, input: ["text"], output: ["text"] }
            draft.cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
            draft.limit = { context: model.contextLength, output: model.maxOutputTokens }
            draft.enabled = !openrouter || owned.some((item) => item.id === model.id)
            Object.assign(draft, { freeModel: { source: "shared" } })
          })
        }
        for (const model of owned) {
          catalog.model.update("openrouter", model.id, (draft) => {
            draft.name = model.name
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
            Object.assign(draft, { freeModel: { source: "openrouter" } })
          })
        }
      }),
    )
    yield* events.subscribe(Integration.Event.Updated).pipe(
      Stream.runForEach(() => ctx.catalog.reload()),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* Effect.forever(Effect.sleep("5 minutes").pipe(Effect.andThen(ctx.catalog.reload()))).pipe(
      Effect.forkScoped(),
    )
  }),
})
