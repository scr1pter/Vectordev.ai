import { expect } from "bun:test"
import { Effect } from "effect"
import { Catalog } from "../src/catalog"
import { FreeModels } from "../src/free-models"
import { ModelPlans } from "../src/model-plans"
import { PluginV2 } from "../src/plugin"
import { PluginHost } from "../src/plugin/host"
import { VectorPlanPlugin } from "../src/plugin/provider/vector-plan"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)
const model = {
  id: "vendor/coder",
  name: "Coder",
  contextLength: 32000,
  maxOutputTokens: 4096,
  inputPrice: 0.2,
  outputPrice: 0.4,
}

for (const enabled of [true, false])
  it.effect(`managed catalog replaces configuration overrides when enabled=${enabled}`, () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const plugins = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugins)
      yield* host.catalog.transform(
        Effect.fn(function* (draft) {
          draft.provider.update(ModelPlans.PROVIDER_ID, (provider) => {
            provider.name = "injected"
            provider.request.body.apiKey = "project-secret"
          })
          draft.model.update(ModelPlans.PROVIDER_ID, "vendor/expensive", () => {})
        }),
      )
      yield* VectorPlanPlugin.effect(host).pipe(
        Effect.provideService(ModelPlans.Service, {
          catalog: (token) => {
            expect(token).toBe("private-account-token")
            return Effect.succeed({ enabled, models: enabled ? [model] : [] })
          },
          request: () => Promise.reject(new Error("Listing must not call the chat gateway")),
        }),
        Effect.provideService(FreeModels.CredentialsService, { get: () => Effect.succeed("private-account-token") }),
      )
      const listed = (yield* catalog.model.available()).filter((model) => model.providerID === ModelPlans.PROVIDER_ID)
      expect(listed).toHaveLength(enabled ? 1 : 0)
      if (!enabled) return
      expect(String(listed[0].id)).toBe(model.id)
      expect(listed[0].name).toBe(model.name)
      expect(listed[0].cost[0].input).toBe(model.inputPrice)
      expect(listed[0].api.url).toBe(ModelPlans.API_URL)
      expect(JSON.stringify(listed)).not.toContain("private-account-token")
      expect(JSON.stringify(listed)).not.toContain("project-secret")
    }),
  )
