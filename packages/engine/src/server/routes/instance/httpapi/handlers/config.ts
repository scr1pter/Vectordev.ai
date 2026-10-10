import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { Redaction } from "@vectordevai/core/redaction"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service

    // Every client of the server reads config, including guests invited with
    // `vector invite`, so stored keys go out as Redaction.MARKER. Config.update
    // treats a MARKER sent back as "unchanged".
    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return Redaction.redactConfig(yield* configSvc.get())
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return Redaction.redactConfig(ctx.payload)
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map(Provider.toClientInfo),
        default: Provider.defaultModelIDs(providers),
        unavailable: yield* providerSvc.unavailable(),
      }
    })

    return handlers.handle("get", get).handle("update", update).handle("providers", providers)
  }),
)
