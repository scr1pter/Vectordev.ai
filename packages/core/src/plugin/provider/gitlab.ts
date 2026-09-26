import os from "os"
import { InstallationVersion } from "../../installation/version"
import { Effect } from "effect"
import { define } from "../internal"
import { ProviderV2 } from "../../provider"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { createGitlabOAuth } from "../../oauth/gitlab"
import { gitlabCredentialMatches, gitlabOAuthConfiguration, requireGitlabOAuthEndpoint } from "../../provider-policy"
import type { IntegrationOAuthMethodRegistration } from "@vectordevai/plugin/v2/effect/integration"

export const GitLabPlugin = define({
  id: "gitlab",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.integration.transform((draft) => {
      if (gitlabOAuthConfiguration()) draft.method.update(gitlabDeviceMethod())
    })
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.package !== "gitlab-ai-provider") return
        const connection = yield* ctx.integration.connection.active("gitlab")
        const credential = connection
          ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.orDie)
          : undefined
        if (credential?.metadata?.vector_plugin_oauth) return
        const oauthOrigin =
          credential?.type === "oauth" ? requireGitlabOAuthEndpoint(credential, evt.options) : undefined
        const mod = yield* Effect.promise(() => import("gitlab-ai-provider"))
        evt.sdk = mod.createGitLab({
          ...evt.options,
          instanceUrl:
            oauthOrigin ??
            (typeof evt.options.instanceUrl === "string"
              ? evt.options.instanceUrl
              : (process.env.GITLAB_INSTANCE_URL ?? "https://gitlab.com")),
          apiKey: typeof evt.options.apiKey === "string" ? evt.options.apiKey : process.env.GITLAB_TOKEN,
          aiGatewayHeaders: {
            "User-Agent": `vector/${InstallationVersion} gitlab-ai-provider/${mod.VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`,
            "anthropic-beta": "context-1m-2025-08-07",
            ...evt.options.aiGatewayHeaders,
          },
          featureFlags: {
            duo_agent_platform_agentic_chat: true,
            duo_agent_platform: true,
            ...evt.options.featureFlags,
          },
        })
      }),
    )
    yield* ctx.aisdk.language(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== ProviderV2.ID.gitlab) return
        const featureFlags =
          typeof evt.options.featureFlags === "object" && evt.options.featureFlags ? evt.options.featureFlags : {}
        if (evt.model.api.id.startsWith("duo-workflow-")) {
          const gitlab = yield* Effect.promise(() => import("gitlab-ai-provider")).pipe(Effect.orDie)
          const workflowRef =
            typeof evt.model.request.body.workflowRef === "string" ? evt.model.request.body.workflowRef : undefined
          const workflowDefinition =
            typeof evt.model.request.body.workflowDefinition === "string"
              ? evt.model.request.body.workflowDefinition
              : undefined
          const language = evt.sdk.workflowChat(
            gitlab.isWorkflowModel(evt.model.api.id) ? evt.model.api.id : "duo-workflow",
            {
              featureFlags,
              workflowDefinition,
            },
          )
          if (workflowRef) language.selectedModelRef = workflowRef
          evt.language = language
          return
        }
        evt.language = evt.sdk.agenticChat(evt.model.api.id, {
          aiGatewayHeaders: evt.options.aiGatewayHeaders,
          featureFlags,
        })
      }),
    )
  }),
})

export function gitlabDeviceMethod(
  configuration = gitlabOAuthConfiguration,
  oauth = createGitlabOAuth(),
): IntegrationOAuthMethodRegistration {
  const methodID = Integration.MethodID.make("gitlab-device")
  const registration = () => {
    const value = configuration()
    if (!value) throw new Error("GitLab Duo sign-in is not enabled for this Vector build. Use a personal access token.")
    return value
  }
  const credential = (value: Awaited<ReturnType<typeof oauth.refresh>>) => {
    if (!gitlabCredentialMatches(value, configuration()))
      throw new Error("GitLab application configuration changed. Sign in again.")
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
    integrationID: Integration.ID.make("gitlab"),
    method: { id: methodID, type: "oauth", label: "Sign in with GitLab (device code)" },
    authorize: () =>
      Effect.gen(function* () {
        const abort = new AbortController()
        yield* Effect.addFinalizer(() => Effect.sync(() => abort.abort()))
        const device = yield* Effect.tryPromise({
          try: (signal) => oauth.authorize(registration(), AbortSignal.any([signal, abort.signal])),
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
          if (!gitlabCredentialMatches(value, app))
            throw new Error("This GitLab token belongs to another application or instance. Sign in again.")
          return oauth.refresh(app, value.refresh, signal).then(credential)
        },
        catch: (cause) => cause,
      }),
  }
}
