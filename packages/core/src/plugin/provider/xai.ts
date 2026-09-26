import { Effect } from "effect"
import { define } from "../internal"
import { ProviderV2 } from "../../provider"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { xaiOAuthConfiguration, ownedOAuthMatches } from "../../provider-policy"
import { createXaiOAuth } from "../../oauth/xai"
import { ownedOAuthFetch } from "../../oauth/owned"
import type { IntegrationOAuthMethodRegistration } from "@vectordevai/plugin/v2/effect/integration"

export const XAIPlugin = define({
  id: "xai",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.integration.transform((draft) => {
      if (!xaiOAuthConfiguration()) return
      draft.method.update(xaiOAuthMethod("browser"))
      draft.method.update(xaiOAuthMethod("device"))
    })
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/xai") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/xai"))
        const connection = yield* ctx.integration.connection.active("xai")
        const saved = connection ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.orDie) : undefined
        if (saved?.type !== "oauth") {
          evt.sdk = mod.createXai(evt.options)
          return
        }
        if (!ownedOAuthMatches(saved, xaiOAuthConfiguration()))
          throw new Error("xAI registration changed. Sign in again.")
        evt.sdk = mod.createXai({
          ...evt.options,
          apiKey: "",
          fetch: ownedOAuthFetch("https://api.x.ai", async () => {
            const current = await Effect.runPromise(ctx.integration.connection.resolve(connection!))
            if (current?.type !== "oauth" || !ownedOAuthMatches(current, xaiOAuthConfiguration()))
              throw new Error("xAI registration changed. Sign in again.")
            return current.access
          }),
        })
      }),
    )
    yield* ctx.aisdk.language(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== ProviderV2.ID.make("xai")) return
        evt.language = evt.sdk.responses(evt.model.api.id)
      }),
    )
  }),
})

export function xaiOAuthMethod(
  mode: "browser" | "device",
  configuration = xaiOAuthConfiguration,
  oauth = createXaiOAuth(),
): IntegrationOAuthMethodRegistration {
  const methodID = Integration.MethodID.make(`vector-xai-${mode}`)
  const registration = () => {
    const value = configuration()
    if (!value) throw new Error("xAI sign-in is not enabled for this Vector build. Use an API key.")
    return value
  }
  const credential = (value: Awaited<ReturnType<typeof oauth.refresh>>) => {
    if (!ownedOAuthMatches(value, configuration())) throw new Error("xAI registration changed. Sign in again.")
    return Credential.OAuth.make({
      type: "oauth",
      methodID,
      access: value.access,
      refresh: value.refresh,
      expires: value.expires,
      metadata: { oauth_client_id: value.clientId, oauth_instance_url: value.enterpriseUrl },
    })
  }
  return {
    integrationID: Integration.ID.make("xai"),
    method: {
      id: methodID,
      type: "oauth",
      label: mode === "browser" ? "Sign in with xAI (browser)" : "Sign in with xAI (device code)",
    },
    authorize: () =>
      Effect.gen(function* () {
        const abort = new AbortController()
        yield* Effect.addFinalizer(() => Effect.sync(() => abort.abort()))
        const flow = yield* Effect.tryPromise({
          try: (signal) => oauth[mode](registration(), AbortSignal.any([signal, abort.signal])),
          catch: (cause) => cause,
        })
        return {
          mode: "auto" as const,
          url: flow.url,
          instructions: flow.instructions,
          callback: Effect.tryPromise({ try: () => flow.complete().then(credential), catch: (cause) => cause }).pipe(
            Effect.ensuring(Effect.sync(() => abort.abort())),
          ),
        }
      }),
    refresh: (value) =>
      Effect.tryPromise({
        try: (signal) => {
          const app = registration()
          if (!ownedOAuthMatches(value, app)) throw new Error("xAI registration changed. Sign in again.")
          return oauth.refresh(app, value.refresh, signal).then(credential)
        },
        catch: (cause) => cause,
      }),
  }
}
