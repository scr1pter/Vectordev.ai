import { Effect } from "effect"
import { define } from "../internal"
import { ProviderSDK } from "../../provider-sdk"

export const SapAICorePlugin = define({
  id: "sap-ai-core",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.package !== "@jerome-benoit/sap-ai-provider") return
        const create = yield* Effect.promise(() => ProviderSDK.load(evt.package))
        evt.sdk = create(evt.options)
      }),
    )
  }),
})
