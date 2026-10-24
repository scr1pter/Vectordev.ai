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
import {
  CHATGPT_CLIENT_ID,
  CODEX_CLI_CLIENT_ID,
  CHATGPT_SIGN_IN,
  applyRemoteProviderPolicy,
  chatgptCredentialMatches,
  chatgptOAuthConfiguration,
  providerCredentialAllowed,
  providerCredentialUnavailable,
  providerOAuthAllowed,
} from "@vectordevai/core/provider-policy"
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

test("unavailable credential reasons preserve ordinary and custom API keys", () => {
  for (const id of ["xai", "poe", "digitalocean", "gitlab"]) {
    expect(providerCredentialUnavailable(id, { type: "oauth" })?.reason).toBe("sign-in-paused")
    expect(providerCredentialUnavailable(id, { type: "api" })).toBeUndefined()
  }
  // Sign in with ChatGPT is off (owner decision, 23 October 2026): a saved sign-in is paused, and the notice points
  // to OpenAI's own routes, an API key or the user's own Codex CLI.
  const chatgpt = providerCredentialUnavailable("openai", { type: "oauth" })
  expect(chatgpt?.reason).toBe("sign-in-paused")
  expect(chatgpt?.message).toContain("Sign in with ChatGPT is off in Vector")
  expect(chatgpt?.message).toContain("API key")
  expect(chatgpt?.message).toContain("Codex CLI from Host locally")
  expect(chatgpt?.message).toContain("vector providers logout openai")
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

const issuer = "https://auth.openai.com"
const owned = "vector-owned-test-registration"

// A registration of Vector's own, as VECTOR_OPENAI_OAUTH_CLIENT_ID supplies one, for a sign-in that is on.
function ownedRegistration() {
  const before = process.env.VECTOR_OPENAI_OAUTH_CLIENT_ID
  process.env.VECTOR_OPENAI_OAUTH_CLIENT_ID = owned
  return () => {
    if (before === undefined) delete process.env.VECTOR_OPENAI_OAUTH_CLIENT_ID
    else process.env.VECTOR_OPENAI_OAUTH_CLIENT_ID = before
  }
}

test("Sign in with ChatGPT is off unless a registration of Vector's own is configured", () => {
  // Off by the owner's decision of 23 October 2026: the Codex CLI's registration is never used for a new sign-in.
  expect(CHATGPT_SIGN_IN).toBe(false)
  expect(CODEX_CLI_CLIENT_ID).toBe("app_EMoamEEZ73f0CkXaXp7hrann")
  expect(chatgptOAuthConfiguration({})).toBeUndefined()
  expect(chatgptOAuthConfiguration({}, true)).toBeUndefined()
  expect(providerOAuthAllowed("openai")).toBe(false)
  // A registration OpenAI issues to Vector still turns it on, and the owner's switch still applies to it.
  expect(chatgptOAuthConfiguration({ VECTOR_OPENAI_OAUTH_CLIENT_ID: owned })).toEqual({
    clientId: owned,
    origin: issuer,
  })
  expect(chatgptOAuthConfiguration({ VECTOR_OPENAI_OAUTH_CLIENT_ID: owned }, false)).toBeUndefined()
  expect(chatgptOAuthConfiguration({ VECTOR_OPENAI_OAUTH_CLIENT_ID: "invalid registration" })).toBeUndefined()

  // Sign-ins saved before, unstamped or stamped with the Codex CLI client, are neither used nor refreshed.
  for (const credential of [
    { type: "oauth" },
    { type: "oauth", clientId: CODEX_CLI_CLIENT_ID, enterpriseUrl: issuer },
    { type: "oauth", metadata: { oauth_client_id: CHATGPT_CLIENT_ID, oauth_instance_url: issuer } },
  ])
    expect(providerCredentialAllowed("openai", credential)).toBe(false)
  expect(chatgptCredentialMatches({}, chatgptOAuthConfiguration({}))).toBe(false)
  // API keys are unaffected.
  expect(providerCredentialAllowed("openai", { type: "api" })).toBe(true)
  expect(providerCredentialAllowed("openai", { type: "key" })).toBe(true)
})

test("with a registration of Vector's own, only its own sign-ins are used", () => {
  const restore = ownedRegistration()
  try {
    expect(providerOAuthAllowed("openai")).toBe(true)
    const configuration = chatgptOAuthConfiguration()
    expect(configuration).toEqual({ clientId: owned, origin: issuer })
    expect(providerCredentialAllowed("openai", { type: "oauth", clientId: owned, enterpriseUrl: issuer })).toBe(true)
    expect(
      providerCredentialAllowed("openai", {
        type: "oauth",
        metadata: { oauth_client_id: owned, oauth_instance_url: issuer },
      }),
    ).toBe(true)
    // The Codex CLI client's sign-ins, stamped or from before stamps, have to be redone.
    expect(providerCredentialAllowed("openai", { type: "oauth" })).toBe(false)
    expect(
      providerCredentialAllowed("openai", { type: "oauth", clientId: CODEX_CLI_CLIENT_ID, enterpriseUrl: issuer }),
    ).toBe(false)
    expect(chatgptCredentialMatches({}, configuration)).toBe(false)
    // Unstamped sign-ins match the Codex CLI client only, should the built-in sign-in ever be turned on again.
    expect(chatgptCredentialMatches({}, { clientId: CODEX_CLI_CLIENT_ID, origin: issuer })).toBe(true)
  } finally {
    restore()
  }
})

test("the owner's remote switch hides ChatGPT sign-in and stops saved sign-ins; API keys stay usable", () => {
  const restore = ownedRegistration()
  const stamped = { type: "oauth", clientId: owned, enterpriseUrl: issuer }
  applyRemoteProviderPolicy({ chatgptSignIn: false })
  try {
    expect(chatgptOAuthConfiguration()).toBeUndefined()
    expect(providerOAuthAllowed("openai")).toBe(false)
    expect(providerCredentialAllowed("openai", stamped)).toBe(false)
    expect(providerCredentialUnavailable("openai", stamped)?.reason).toBe("sign-in-paused")
    expect(providerCredentialAllowed("openai", { type: "api" })).toBe(true)
    expect(providerCredentialAllowed("openai", { type: "key" })).toBe(true)
  } finally {
    applyRemoteProviderPolicy({ chatgptSignIn: true })
  }
  try {
    expect(providerOAuthAllowed("openai")).toBe(true)
    expect(providerCredentialAllowed("openai", stamped)).toBe(true)
  } finally {
    restore()
  }
})

it.effect("V2 connects a saved ChatGPT sign-in only while the sign-in is on", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const integrations = yield* Integration.Service
    const integrationID = Integration.ID.make("openai")
    yield* integrations.transform((draft) => draft.update(integrationID, () => {}))
    const saved = yield* credentials.create({
      integrationID,
      value: Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("chatgpt-browser"),
        access: "placeholder",
        refresh: "placeholder",
        expires: Date.now() + 3600_000,
        metadata: { oauth_client_id: owned, oauth_instance_url: issuer },
      }),
    })
    const connection = { type: "credential" as const, id: saved.id, label: saved.label }
    // Off by default: the saved sign-in is not used.
    expect(yield* integrations.connection.active(integrationID)).toBeUndefined()
    const on = yield* Effect.acquireUseRelease(
      Effect.sync(ownedRegistration),
      () =>
        Effect.gen(function* () {
          const connected = yield* Effect.all([
            integrations.connection.active(integrationID),
            integrations.connection.resolve(connection),
          ])
          applyRemoteProviderPolicy({ chatgptSignIn: false })
          const paused = yield* Effect.all([
            integrations.connection.active(integrationID),
            integrations.connection.resolve(connection),
          ]).pipe(Effect.ensuring(Effect.sync(() => applyRemoteProviderPolicy({ chatgptSignIn: true }))))
          return { connected, paused }
        }),
      (restore) => Effect.sync(restore),
    )
    expect(on.connected[0]).toMatchObject({ id: saved.id })
    expect(on.connected[1]).toMatchObject({ type: "oauth" })
    expect(on.paused).toEqual([undefined, undefined])
  }),
)
