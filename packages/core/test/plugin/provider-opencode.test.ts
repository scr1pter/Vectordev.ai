import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Catalog } from "@vectordevai/core/catalog"
import { Credential } from "@vectordevai/core/credential"
import { Integration } from "@vectordevai/core/integration"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ProviderPlugins } from "@vectordevai/core/plugin/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

describe("retired hosted providers", () => {
  it.effect("cannot be restored by catalog transforms", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      for (const id of ["opencode", "opencode-go", "opencode-zen", "opencode-custom"]) {
        const provider = ProviderV2.ID.make(id)
        yield* catalog.transform((draft) => {
          draft.provider.update(provider, (value) => {
            value.request.body.apiKey = "placeholder"
          })
          draft.model.update(provider, ModelV2.ID.make("example"), () => {})
        })
        expect(yield* catalog.provider.get(provider)).toBeUndefined()
        expect(yield* catalog.model.get(provider, ModelV2.ID.make("example"))).toBeUndefined()
      }
      expect(ProviderPlugins.some((plugin) => plugin.id.startsWith("opencode"))).toBe(false)
    }),
  )

  it.effect("does not use stored borrowed OAuth credentials", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrations = yield* Integration.Service
      for (const id of ["opencode", "openai", "github-copilot", "xai", "poe", "digitalocean"]) {
        const integrationID = Integration.ID.make(id)
        yield* integrations.transform((draft) => draft.update(integrationID, () => {}))
        const saved = yield* credentials.create({
          integrationID,
          value: Credential.OAuth.make({
            type: "oauth",
            methodID: Integration.MethodID.make("old-sign-in"),
            access: "placeholder",
            refresh: "placeholder",
            expires: Date.now() + 3600_000,
          }),
        })
        expect(yield* integrations.connection.active(integrationID)).toBeUndefined()
        expect(
          yield* integrations.connection.resolve({ type: "credential", id: saved.id, label: saved.label }),
        ).toBeUndefined()
      }
    }),
  )

  it.effect("removes aliases pointing to retired hosted endpoints", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const provider = ProviderV2.ID.make("custom")
      yield* catalog.transform((draft) => {
        draft.provider.update(provider, (value) => {
          value.api = { type: "aisdk", package: "@ai-sdk/openai", url: "https://api.opencode.ai/v1" }
        })
      })
      expect(yield* catalog.provider.get(provider)).toBeUndefined()
    }),
  )
})
