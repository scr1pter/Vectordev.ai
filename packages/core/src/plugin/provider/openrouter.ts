import { Effect } from "effect"
import { ModelV2 } from "../../model"
import { define } from "../internal"
import { OpenRouterOAuth } from "../../oauth/openrouter"
import { OPENROUTER_ACCOUNT_COPY } from "../../free-model-choice"

export const OpenRouterPlugin = define({
  id: "openrouter",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.integration.transform((draft) => {
      draft.update("openrouter", (integration) => {
        integration.name = "OpenRouter"
      })
      draft.method.update({ integrationID: "openrouter", method: { type: "key" } })
      draft.method.update({
        integrationID: "openrouter",
        method: { type: "oauth", id: "openrouter-pkce", label: "Connect OpenRouter" },
        authorize: () =>
          Effect.gen(function* () {
            const attempt = yield* Effect.tryPromise({
              try: () => OpenRouterOAuth.authorize(),
              catch: (cause) => cause,
            })
            yield* Effect.addFinalizer(() => Effect.sync(() => attempt.close()))
            return {
              url: attempt.url,
              instructions: `${OPENROUTER_ACCOUNT_COPY} Finish connecting in a browser on this computer. For a remote engine, forward the loopback callback port or use an API key.`,
              mode: "auto" as const,
              callback: Effect.tryPromise({ try: () => attempt.key, catch: (cause) => cause }).pipe(
                Effect.map((key) => ({ type: "key" as const, key })),
              ),
            }
          }),
      })
    })
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@openrouter/ai-sdk-provider") continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.request.headers["HTTP-Referer"] = "https://vectordev.ai/"
            provider.request.headers["X-OpenRouter-Title"] = "Vector"
          })
          for (const modelID of [ModelV2.ID.make("gpt-5-chat-latest"), ModelV2.ID.make("openai/gpt-5-chat")]) {
            if (!item.models.has(modelID)) continue
            evt.model.update(item.provider.id, modelID, (model) => {
              // These are OpenRouter-specific OpenAI chat aliases that do not work
              // on the generic path. Keep custom providers with matching IDs untouched.
              model.enabled = false
            })
          }
        }
      }),
    )
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.package !== "@openrouter/ai-sdk-provider") return
        const mod = yield* Effect.promise(() => import("@openrouter/ai-sdk-provider"))
        evt.sdk = mod.createOpenRouter(evt.options)
      }),
    )
  }),
})
