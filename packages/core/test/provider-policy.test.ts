import { EventV2 } from "@vectordevai/core/event"
import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import {
  COPILOT_SIGN_IN,
  providerEnabled,
  SUPPORTED_PROVIDER_IDS,
  filterProviderCatalog,
  providerAllowed,
  providerUsable,
} from "@vectordevai/schema/provider-policy"
import { Catalog } from "@vectordevai/core/catalog"
import { Credential } from "@vectordevai/core/credential"
import { Integration } from "@vectordevai/core/integration"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
import { providerCredentialAllowed } from "@vectordevai/core/provider-policy"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)
const unsupported = "unsupported-fixture"

test("provider admission requires an exact reviewed ID", () => {
  expect(SUPPORTED_PROVIDER_IDS.length).toBeGreaterThan(0)
  expect(new Set(SUPPORTED_PROVIDER_IDS).size).toBe(SUPPORTED_PROVIDER_IDS.length)
  expect(providerAllowed("openai")).toBe(true)
  expect(providerAllowed("lmstudio")).toBe(true)
  for (const id of [unsupported, "OPENAI", "openai-custom", "", " openai"]) {
    expect(providerAllowed(id)).toBe(false)
    expect(providerCredentialAllowed(id, { type: "api" })).toBe(false)
    expect(providerCredentialAllowed(id, { type: "oauth" })).toBe(false)
  }
})

test("snapshot filtering rejects unknown IDs and mismatched catalog identities", () => {
  expect(
    filterProviderCatalog({
      openai: { id: "openai", api: "https://custom.example.test/v1" },
      anthropic: { id: unsupported },
      [unsupported]: { id: "openai" },
    }),
  ).toEqual({ openai: { id: "openai", api: "https://custom.example.test/v1" } })
})

test("catalog documentation uses provider guides without changing providers or model data", () => {
  const catalog = Object.fromEntries(
    SUPPORTED_PROVIDER_IDS.map((id) => [
      id,
      {
        id,
        doc: `https://example.test/${id}/client-guide`,
        models: { example: { id: "example", cost: { input: 1 } } },
      },
    ]),
  )
  const filtered = filterProviderCatalog(catalog)
  expect(Object.keys(filtered)).toEqual([...SUPPORTED_PROVIDER_IDS])
  expect(filtered.infer.doc).toBe("https://infer.flow7.org/docs")
  expect(filtered.pendra.doc).toBe("https://pendra.ai/docs/")
  expect(filtered.agentrouter.doc).toBe("https://agentrouter.org/docs/index.html")
  expect(filtered.openai).toBe(catalog.openai)
  for (const id of SUPPORTED_PROVIDER_IDS) {
    expect(filtered[id].models).toBe(catalog[id].models)
    expect(catalog[id].doc).toBe(`https://example.test/${id}/client-guide`)
  }
})

test("runtime catalog defaults to Vector and accepts deliberate custom mirrors", () => {
  expect(ModelCatalog.mirrorURL(undefined)).toBe("https://vectordev.ai/models")
  expect(ModelCatalog.mirrorURL("https://vectordev.ai/models/api.json")).toBe("https://vectordev.ai/models")
  for (const value of [
    "https://catalog.example.test",
    "https://catalog.example.test:444/models",
    "http://127.0.0.1:1234/catalog",
  ]) {
    expect(ModelCatalog.mirrorURL(value)).toBe(value)
    expect(ModelCatalog.ownedMirror(value)).toBe(false)
  }
  expect(ModelCatalog.ownedMirror("https://vectordev.ai/models")).toBe(true)
  expect(
    ModelCatalog.ownedMirror("https://42qryducihx01gl0.public.blob.vercel-storage.com/releases/vector-v1.2.3"),
  ).toBe(true)
  for (const value of [
    "file:///catalog.json",
    "https://user:password@catalog.example.test/models",
    "https://catalog.example.test/models?token=hidden",
    "https://catalog.example.test/models#fragment",
    "not a url",
  ]) {
    expect(ModelCatalog.mirrorURL(value)).toBeUndefined()
  }
})

it.effect("plugin-defined providers acquire models, defaults and credential connections", () =>
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const credentials = yield* Credential.Service
    const integrations = yield* Integration.Service
    const provider = ProviderV2.ID.make(unsupported)
    const integrationID = Integration.ID.make(unsupported)
    yield* catalog.transform((draft) => {
      draft.provider.update(provider, (value) => {
        value.request.body.apiKey = "placeholder"
      })
      draft.model.update(provider, ModelV2.ID.make("example"), () => {})
      draft.model.default.set(provider, ModelV2.ID.make("example"))
    })
    yield* integrations.transform((draft) => draft.update(integrationID, () => {}))
    for (const value of [
      Credential.Key.make({ type: "key", key: "placeholder" }),
      Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("fixture-sign-in"),
        access: "placeholder",
        refresh: "placeholder",
        expires: Date.now() + 3600_000,
      }),
    ]) {
      const saved = yield* credentials.create({ integrationID, value })
      expect(yield* integrations.connection.active(integrationID)).toMatchObject({ type: "credential", id: saved.id })
      expect(yield* integrations.connection.resolve({ type: "credential", id: saved.id, label: saved.label })).toEqual(
        value,
      )
    }
    expect(yield* integrations.get(integrationID)).toMatchObject({ id: integrationID })
    expect(yield* catalog.provider.get(provider)).toMatchObject({ id: provider })
    expect(yield* catalog.model.get(provider, ModelV2.ID.make("example"))).toMatchObject({ providerID: provider })
    expect(yield* catalog.model.default()).toMatchObject({ providerID: provider })
  }),
)

it.effect("mutable catalog transforms cannot change provider or model identities", () =>
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const provider = ProviderV2.ID.make("lmstudio")
    const model = ModelV2.ID.make("example")
    yield* catalog.transform((draft) => {
      draft.provider.update(provider, (value) => {
        value.api = { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://custom.example.test/v1" }
      })
      draft.model.update(provider, model, () => {})
      const record = draft.provider.get(provider)!
      record.provider.id = ProviderV2.ID.make(unsupported)
      record.models.get(model)!.providerID = ProviderV2.ID.make(unsupported)
    })
    expect(yield* catalog.provider.get(provider)).toMatchObject({
      id: provider,
      api: { url: "https://custom.example.test/v1" },
    })
    expect(yield* catalog.model.get(provider, model)).toMatchObject({ providerID: provider, id: model })
    expect(yield* catalog.provider.get(ProviderV2.ID.make(unsupported))).toBeUndefined()
  }),
)

it.effect("paused sign-ins never expose stored OAuth connections", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const integrations = yield* Integration.Service
    for (const id of ["github-copilot", "xai", "gitlab", "poe", "digitalocean"]) {
      const integrationID = Integration.ID.make(id)
      yield* integrations.transform((draft) => draft.update(integrationID, () => {}))
      const saved = yield* credentials.create({
        integrationID,
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("paused-sign-in"),
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

test("custom provider admission requires an explicit definition", () => {
  expect(providerUsable("ollama")).toBe(false)
  expect(providerUsable("ollama", { npm: "@ai-sdk/openai-compatible" })).toBe(true)
  expect(providerUsable("ollama", { options: { baseURL: "http://localhost:11434/v1" } })).toBe(true)
  expect(providerUsable("ollama", { source: "config" })).toBe(true)
  expect(providerUsable("ollama", { source: "custom" })).toBe(true)
  expect(providerUsable("ollama", { options: { baseURL: " " } })).toBe(false)
})

it.effect("a saved key does not create an unregistered custom integration", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const integrations = yield* Integration.Service
    const integrationID = Integration.ID.make("unregistered-provider")
    const saved = yield* credentials.create({
      integrationID,
      value: Credential.Key.make({ type: "key", key: "fixture" }),
    })
    expect(yield* integrations.connection.active(integrationID)).toBeUndefined()
    expect(
      yield* integrations.connection.resolve({ type: "credential", id: saved.id, label: saved.label }),
    ).toBeUndefined()
  }),
)

test("the Copilot pause switch covers catalog, explicit config, and every credential type", () => {
  expect(COPILOT_SIGN_IN).toBe(false)
  for (const id of ["github-copilot", "github-copilot-enterprise"]) {
    expect(providerEnabled(id)).toBe(false)
    expect(providerAllowed(id)).toBe(false)
    expect(providerUsable(id, { source: "custom", npm: "@ai-sdk/openai-compatible" })).toBe(false)
    for (const type of ["api", "key", "oauth"]) {
      expect(providerCredentialAllowed(id, { type }, true)).toBe(false)
    }
  }
  expect(filterProviderCatalog({ "github-copilot": { id: "github-copilot" } })).toEqual({})
})

it.effect("paused Copilot cannot acquire V2 models, defaults, key connections, or environment methods", () =>
  Effect.gen(function* () {
    const previous = process.env.GITHUB_TOKEN
    process.env.GITHUB_TOKEN = "synthetic-token-that-must-not-autoload"
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.GITHUB_TOKEN
        if (previous !== undefined) process.env.GITHUB_TOKEN = previous
      }),
    )
    const catalog = yield* Catalog.Service
    const credentials = yield* Credential.Service
    const integrations = yield* Integration.Service
    const providerID = ProviderV2.ID.make("github-copilot")
    const integrationID = Integration.ID.make("github-copilot")
    yield* catalog.transform((draft) => {
      draft.provider.update(providerID, (provider) => {
        provider.request.body.apiKey = "fixture-github-token"
      })
      draft.model.update(providerID, ModelV2.ID.make("example"), () => {})
      draft.model.default.set(providerID, ModelV2.ID.make("example"))
    })
    yield* integrations.transform((draft) => {
      draft.update(integrationID, () => {})
      draft.method.update({ integrationID, method: { type: "env", names: ["GITHUB_TOKEN"] } })
      draft.method.update({ integrationID, method: { type: "key" } })
    })
    const saved = yield* credentials.create({
      integrationID,
      value: Credential.Key.make({ type: "key", key: "fixture" }),
    })
    expect(yield* integrations.connection.active(integrationID)).toBeUndefined()
    expect(
      yield* integrations.connection.resolve({ type: "credential", id: saved.id, label: saved.label }),
    ).toBeUndefined()
    expect((yield* integrations.get(integrationID))?.methods).toEqual([])
    expect(yield* catalog.provider.get(providerID)).toBeUndefined()
    expect(yield* catalog.model.default()).toBeUndefined()
  }),
)

test("unavailable credential reasons preserve ordinary and custom API keys", async () => {
  const { providerCredentialUnavailable } = await import("@vectordevai/core/provider-policy")
  for (const id of ["xai", "poe", "digitalocean", "gitlab"]) {
    expect(providerCredentialUnavailable(id, { type: "oauth" })?.reason).toBe("sign-in-paused")
    expect(providerCredentialUnavailable(id, { type: "api" })).toBeUndefined()
  }
  // ChatGPT sign-in was restored on 26 September 2026.
  expect(providerCredentialUnavailable("openai", { type: "oauth" })).toBeUndefined()
  expect(providerCredentialUnavailable("openai", { type: "api" })).toBeUndefined()
  expect(
    providerCredentialUnavailable("digitalocean", { type: "api", metadata: { oauth_access: "true" } })?.reason,
  ).toBe("sign-in-paused")
  expect(providerCredentialUnavailable("github-copilot", { type: "api" })?.reason).toBe("sign-in-paused")
  expect(providerCredentialUnavailable("removed-fixture", { type: "api" })?.reason).toBe("provider-not-configured")
  expect(providerCredentialUnavailable("company-gateway", { type: "api" }, true)).toBeUndefined()
  expect(providerCredentialUnavailable("https://organization.example.test", { type: "wellknown" })).toBeUndefined()
})

it.effect("V2 publishes one actionable notice for a paused credential without exposing tokens", () =>
  Effect.gen(function* () {
    const integrations = yield* Integration.Service
    const credentials = yield* Credential.Service
    const events = yield* EventV2.Service
    const integrationID = Integration.ID.make("xai")
    const notices: unknown[] = []
    yield* events.subscribe(Integration.Event.Unavailable).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          notices.push(event.data)
        }),
      ),
      Effect.forkScoped,
    )
    yield* Effect.yieldNow
    yield* credentials.create({
      integrationID,
      value: Credential.OAuth.make({
        type: "oauth",
        access: "fixture-private-access",
        refresh: "fixture-private-refresh",
        expires: 0,
        methodID: Integration.MethodID.make("fixture-paused"),
      }),
    })
    expect(yield* integrations.connection.active(integrationID)).toBeUndefined()
    expect(yield* integrations.connection.active(integrationID)).toBeUndefined()
    yield* integrations.list()
    yield* Effect.yieldNow
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ id: "xai", reason: "sign-in-paused" })
    expect(JSON.stringify(notices)).toContain("vector providers logout xai")
    expect(JSON.stringify(notices)).not.toContain("fixture-private")
  }),
)
