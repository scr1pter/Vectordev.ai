import { Effect } from "effect"
import { define } from "../internal"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { poeOAuthConfiguration, ownedOAuthMatches } from "../../provider-policy"
import { createPoeOAuth } from "../../oauth/poe"
import { ownedOAuthFetch } from "../../oauth/owned"
import type { IntegrationOAuthMethodRegistration } from "@vectordevai/plugin/v2/effect/integration"

export const PoePlugin = define({
  id: "poe",
  effect: Effect.fn(function* (ctx) {
    if (!poeOAuthConfiguration()) return
    yield* ctx.integration.transform((draft) => {
      draft.method.update(poeOAuthMethod())
    })
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== "poe") return
        const connection = yield* ctx.integration.connection.active("poe")
        const value = connection ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.orDie) : undefined
        if (value?.type !== "oauth") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/openai-compatible"))
        evt.sdk = mod.createOpenAICompatible({
          ...evt.options,
          name: "poe",
          baseURL: typeof evt.options.baseURL === "string" ? evt.options.baseURL : "https://api.poe.com/v1",
          apiKey: "",
          fetch: ownedOAuthFetch("https://api.poe.com", async () => {
            const current = await Effect.runPromise(ctx.integration.connection.resolve(connection!))
            if (
              current?.type !== "oauth" ||
              !ownedOAuthMatches(current, poeOAuthConfiguration()) ||
              current.expires <= Date.now()
            )
              throw new Error("Your Poe delegated key expired or its registration changed. Sign in again.")
            return current.access
          }),
        })
      }),
    )
  }),
})
export function poeOAuthMethod(
  configuration = poeOAuthConfiguration,
  oauth = createPoeOAuth(),
): IntegrationOAuthMethodRegistration {
  const methodID = Integration.MethodID.make("vector-poe-pkce")
  return {
    integrationID: Integration.ID.make("poe"),
    method: { id: methodID, type: "oauth", label: "Sign in with Poe" },
    authorize: () =>
      Effect.gen(function* () {
        const app = configuration()
        if (!app) throw new Error("Poe sign-in is not enabled for this Vector build. Use an API key.")
        const abort = new AbortController()
        yield* Effect.addFinalizer(() => Effect.sync(() => abort.abort()))
        const flow = yield* Effect.tryPromise({
          try: (signal) => oauth.authorize(app, AbortSignal.any([signal, abort.signal])),
          catch: (cause) => cause,
        })
        return {
          mode: "auto" as const,
          url: flow.url,
          instructions: "Connect Vector in your browser. Poe issues a delegated API key with your selected expiry.",
          callback: Effect.tryPromise({
            try: () =>
              flow.complete().then((value) => {
                if (!ownedOAuthMatches(value, configuration()))
                  throw new Error("Poe registration changed. Sign in again.")
                return Credential.OAuth.make({
                  type: "oauth",
                  methodID,
                  access: value.access,
                  refresh: "",
                  expires: value.expires,
                  metadata: { oauth_client_id: value.clientId, oauth_instance_url: value.enterpriseUrl },
                })
              }),
            catch: (cause) => cause,
          }).pipe(Effect.ensuring(Effect.sync(() => abort.abort()))),
        }
      }),
  }
}
