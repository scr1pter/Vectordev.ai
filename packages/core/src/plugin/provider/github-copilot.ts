import { Effect } from "effect"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import type { PluginContext } from "@vectordevai/plugin/v2/effect"

import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { copilotOAuthConfiguration, ownedOAuthMatches } from "../../provider-policy"
import { createDeviceOAuth } from "../../oauth/device"
import { copilotFetch } from "../../oauth/copilot"
import type { IntegrationOAuthMethodRegistration } from "@vectordevai/plugin/v2/effect/integration"

export const GithubCopilotPlugin = {
  id: "github-copilot",
  effect: Effect.fn(function* (ctx: PluginContext) {
    yield* ctx.integration.transform((draft) => {
      if (copilotOAuthConfiguration()) draft.method.update(copilotDeviceMethod())
    })
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        const item = evt.provider.get(ProviderV2.ID.githubCopilot)
        if (!item || !item.models.has(ModelV2.ID.make("gpt-5-chat-latest"))) return
        evt.model.update(item.provider.id, ModelV2.ID.make("gpt-5-chat-latest"), (model) => {
          // This chat-only alias conflicts with the Copilot GPT-5 Responses route,
          // so hide it only for Copilot rather than for every provider catalog.
          model.enabled = false
        })
      }),
    )
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/github-copilot") return
        const mod = yield* Effect.promise(() => import("../../github-copilot/copilot-provider"))
        const connection = yield* ctx.integration.connection.active("github-copilot")
        const credential = connection
          ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.orDie)
          : undefined
        if (credential?.type !== "oauth") {
          evt.sdk = mod.createOpenaiCompatible(evt.options)
          return
        }
        if (!ownedOAuthMatches(credential, copilotOAuthConfiguration()))
          throw new Error("Copilot registration changed. Sign in again.")
        evt.sdk = mod.createOpenaiCompatible({
          ...evt.options,
          apiKey: "",
          fetch: copilotFetch(async () => {
            const current = await Effect.runPromise(ctx.integration.connection.resolve(connection!))
            if (current?.type !== "oauth" || !ownedOAuthMatches(current, copilotOAuthConfiguration()))
              throw new Error("Copilot registration changed. Sign in again.")
            return current.access
          }),
        })
      }),
    )
    yield* ctx.aisdk.language(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== ProviderV2.ID.githubCopilot) return
        if (evt.sdk.responses === undefined && evt.sdk.chat === undefined) {
          evt.language = evt.sdk.languageModel(evt.model.api.id)
          return
        }
        if (evt.options.endpoint === "responses" && evt.sdk.responses) {
          evt.language = evt.sdk.responses(evt.model.api.id)
          return
        }
        if (evt.options.endpoint === "chat" && evt.sdk.chat) {
          evt.language = evt.sdk.chat(evt.model.api.id)
          return
        }
        const match = /^gpt-(\d+)/.exec(evt.model.api.id)
        // Copilot supports Responses for GPT-5 class models, except mini variants
        // which still need the chat-completions endpoint.
        evt.language =
          match && Number(match[1]) >= 5 && !evt.model.api.id.startsWith("gpt-5-mini") && evt.sdk.responses
            ? evt.sdk.responses(evt.model.api.id)
            : evt.sdk.chat(evt.model.api.id)
      }),
    )
  }),
}

export function copilotDeviceMethod(
  configuration = copilotOAuthConfiguration,
  oauth = createDeviceOAuth(),
): IntegrationOAuthMethodRegistration {
  const methodID = Integration.MethodID.make("vector-copilot-device")
  const registration = () => {
    const value = configuration()
    if (!value) throw new Error("Copilot sign-in is not enabled for this Vector build.")
    return value
  }
  const credential = (value: Awaited<ReturnType<typeof oauth.refresh>>) => {
    if (!ownedOAuthMatches(value, configuration())) throw new Error("Copilot registration changed. Sign in again.")
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
    integrationID: Integration.ID.make("github-copilot"),
    method: { id: methodID, type: "oauth", label: "Sign in with GitHub Copilot" },
    authorize: () =>
      Effect.gen(function* () {
        const abort = new AbortController()
        yield* Effect.addFinalizer(() => Effect.sync(() => abort.abort()))
        const device = yield* Effect.tryPromise({
          try: (signal) => oauth.authorize(registration(), AbortSignal.any([signal, abort.signal]), true),
          catch: (cause) => cause,
        })
        return {
          mode: "auto" as const,
          url: device.url,
          instructions: device.instructions,
          callback: Effect.tryPromise({ try: () => device.complete().then(credential), catch: (cause) => cause }).pipe(
            Effect.ensuring(Effect.sync(() => abort.abort())),
          ),
        }
      }),
    refresh: (value) =>
      Effect.tryPromise({
        try: (signal) => {
          const app = registration()
          if (!ownedOAuthMatches(value, app)) throw new Error("Copilot registration changed. Sign in again.")
          return oauth.refresh(app, value.refresh, signal).then(credential)
        },
        catch: (cause) => cause,
      }),
  }
}
