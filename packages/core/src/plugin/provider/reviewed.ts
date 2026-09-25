import { Effect } from "effect"
import { define } from "../internal"
import { ProviderSDK } from "../../provider-sdk"

export const ReviewedProviderPlugin = define({
  id: "reviewed-providers",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (!ProviderSDK.packages.includes(evt.package as (typeof ProviderSDK.packages)[number]) || evt.sdk) return
        const create = yield* Effect.promise(() => ProviderSDK.load(evt.package))
        evt.sdk = create(evt.options)
      }),
    )
  }),
})
