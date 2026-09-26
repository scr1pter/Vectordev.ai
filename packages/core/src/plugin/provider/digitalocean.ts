import { Effect, Stream } from "effect"
import { define } from "../internal"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { EventV2 } from "../../event"
import { digitalOceanOAuthConfiguration, ownedOAuthMatches } from "../../provider-policy"
import { createDigitalOceanOAuth } from "../../oauth/digitalocean"
import { ownedOAuthFetch } from "../../oauth/owned"
import type { IntegrationOAuthMethodRegistration } from "@vectordevai/plugin/v2/effect/integration"

export const DigitalOceanPlugin = define({
  id: "digitalocean",
  effect: Effect.fn(function* (ctx) {
    if (!digitalOceanOAuthConfiguration()) return
    const oauth = createDigitalOceanOAuth()
    yield* ctx.integration.transform((draft) => {
      draft.method.update(digitalOceanOAuthMethod())
    })
    yield* ctx.catalog.transform(
      Effect.fn(function* (catalog) {
        const connection = yield* ctx.integration.connection.active("digitalocean")
        const value = connection ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.orDie) : undefined
        if (
          value?.type !== "oauth" ||
          !ownedOAuthMatches(value, digitalOceanOAuthConfiguration()) ||
          value.expires <= Date.now()
        )
          return
        const routers = yield* Effect.promise((signal) => oauth.routers(value.access, signal))
        for (const router of routers)
          catalog.model.update("digitalocean", `router:${router.name}`, (draft) => {
            draft.name = router.name
            draft.api = {
              id: `router:${router.name}`,
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
              url: "https://inference.do-ai.run/v1",
            }
            draft.capabilities = { tools: true, input: ["text"], output: ["text"] }
            draft.limit = { context: 128_000, output: 8192 }
            draft.enabled = true
          })
      }),
    )
    const events = yield* EventV2.Service
    yield* events.subscribe(Integration.Event.Updated).pipe(
      Stream.runForEach(() => ctx.catalog.reload()),
      Effect.forkScoped(),
    )
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== "digitalocean") return
        const connection = yield* ctx.integration.connection.active("digitalocean")
        const value = connection ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.orDie) : undefined
        if (value?.type !== "oauth") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/openai-compatible"))
        evt.sdk = mod.createOpenAICompatible({
          ...evt.options,
          name: "digitalocean",
          baseURL: typeof evt.options.baseURL === "string" ? evt.options.baseURL : "https://inference.do-ai.run/v1",
          apiKey: "",
          fetch: ownedOAuthFetch("https://inference.do-ai.run", async () => {
            const current = await Effect.runPromise(ctx.integration.connection.resolve(connection!))
            if (
              current?.type !== "oauth" ||
              !ownedOAuthMatches(current, digitalOceanOAuthConfiguration()) ||
              current.expires <= Date.now()
            )
              throw new Error("DigitalOcean sign-in expired or its registration changed. Reconnect to continue.")
            return current.access
          }),
        })
      }),
    )
  }),
})

export function digitalOceanOAuthMethod(
  configuration = digitalOceanOAuthConfiguration,
  oauth = createDigitalOceanOAuth(),
): IntegrationOAuthMethodRegistration {
  const methodID = Integration.MethodID.make("vector-digitalocean-browser")
  return {
    integrationID: Integration.ID.make("digitalocean"),
    method: { id: methodID, type: "oauth", label: "Sign in with DigitalOcean" },
    authorize: () =>
      Effect.gen(function* () {
        const app = configuration()
        if (!app)
          throw new Error("DigitalOcean sign-in is not enabled for this Vector build. Use an inference access key.")
        const abort = new AbortController()
        yield* Effect.addFinalizer(() => Effect.sync(() => abort.abort()))
        const flow = yield* Effect.tryPromise({
          try: (signal) => oauth.authorize(app, AbortSignal.any([signal, abort.signal])),
          catch: (cause) => cause,
        })
        return {
          mode: "auto" as const,
          url: flow.url,
          instructions: flow.instructions,
          callback: Effect.tryPromise({
            try: () =>
              flow.complete().then((value) => {
                if (!ownedOAuthMatches(value, configuration()))
                  throw new Error("DigitalOcean registration changed. Sign in again.")
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
