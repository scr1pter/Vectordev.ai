import type { Hooks } from "@vectordevai/plugin"
import { providerOAuthAllowed } from "@vectordevai/core/provider-policy"
import {
  activateOAuthApproval,
  approvalValid,
  pluginCredentialAllowed,
  pluginCredentialMetadata,
  requirePluginAuthorization,
  requirePluginDestination,
  warning,
  type OAuthApproval,
} from "@vectordevai/core/plugin/oauth-approval"
import type { PluginLoader } from "./loader"

const approved = new WeakMap<NonNullable<Hooks["auth"]>, OAuthApproval>()
export function pluginOAuthAllowed(hook: NonNullable<Hooks["auth"]>) {
  const value = approved.get(hook)
  return providerOAuthAllowed(hook.provider, true) || Boolean(value && approvalValid(value))
}
export function protectPluginOAuth(hooks: Hooks, load: Pick<PluginLoader.Loaded, "oauthApprovals">): Hooks {
  if (!hooks.auth) return hooks
  const auth = hooks.auth
  const approval = load.oauthApprovals.find(
    (value) => value.declaration.provider === auth.provider && approvalValid(value),
  )
  const paused = !providerOAuthAllowed(auth.provider, true)
  if (!approval) {
    if (!paused) return hooks
    if (auth.methods.some((method) => method.type === "oauth"))
      console.warn(
        `OAuth for ${auth.provider} requires approval of this plugin's owned client. Run vector auth plugin approve for its resolved entrypoint. ${warning}`,
      )
    return {
      ...hooks,
      auth: {
        ...auth,
        methods: auth.methods.filter((method) => method.type !== "oauth"),
        ...(auth.loader
          ? {
              loader: async (getAuth, provider) => {
                const value = await getAuth()
                if (value.type === "oauth" || (value.type === "api" && value.metadata?.vector_plugin_oauth)) return {}
                return auth.loader!(getAuth, provider)
              },
            }
          : {}),
      },
    }
  }
  const release = activateOAuthApproval(approval)
  console.warn(`Approved OAuth plugin ${approval.plugin}@${approval.version} for ${auth.provider}. ${warning}`)
  const result: Hooks = {
    ...hooks,
    async dispose() {
      try {
        await hooks.dispose?.()
      } finally {
        release()
      }
    },
    auth: {
      ...auth,
      methods: auth.methods.map((method) =>
        method.type !== "oauth"
          ? method
          : {
              ...method,
              async authorize(inputs) {
                pluginCredentialMetadata(approval)
                const authorization = await method.authorize(inputs)
                requirePluginAuthorization(approval, authorization)
                const finish = async (code?: string) => {
                  pluginCredentialMetadata(approval)
                  const value =
                    authorization.method === "code"
                      ? await authorization.callback(code!)
                      : await authorization.callback()
                  if (value.type !== "success") return value
                  if (value.provider && value.provider !== auth.provider)
                    throw new Error("Plugin OAuth returned another provider's credential.")
                  if ("clientId" in value && value.clientId !== approval.declaration.clientId)
                    throw new Error("Plugin OAuth returned another client's credential.")
                  if ("enterpriseUrl" in value && value.enterpriseUrl !== approval.declaration.issuer)
                    throw new Error("Plugin OAuth returned another issuer's credential.")
                  return {
                    ...value,
                    metadata: { ...("metadata" in value ? value.metadata : {}), ...pluginCredentialMetadata(approval) },
                  }
                }
                return authorization.method === "code"
                  ? { ...authorization, callback: (code: string) => finish(code) }
                  : { ...authorization, callback: () => finish() }
              },
            },
      ),
      ...(auth.loader
        ? {
            loader: async (getAuth, provider) => {
              const initial = await getAuth()
              if (initial.type !== "oauth" && !(initial.type === "api" && initial.metadata?.vector_plugin_oauth))
                return auth.loader!(getAuth, provider)
              if (!pluginCredentialAllowed(auth.provider, initial, approval.id)) return {}
              requirePluginDestination(approval, provider.options?.baseURL)
              const guarded = async () => {
                const value = await getAuth()
                if (value.type === "wellknown" || !pluginCredentialAllowed(auth.provider, value, approval.id))
                  throw new Error("Plugin OAuth approval or credential changed. Reconnect to continue.")
                return value
              }
              const options = await auth.loader!(guarded, provider)
              requirePluginDestination(approval, options.baseURL)
              const send = typeof options.fetch === "function" ? options.fetch : fetch
              return {
                ...options,
                fetch: async (request: RequestInfo | URL, init?: RequestInit) => {
                  requirePluginDestination(approval, request instanceof Request ? request.url : String(request))
                  await guarded()
                  return send(request, { ...init, redirect: "error" })
                },
              }
            },
          }
        : {}),
    },
  }
  approved.set(result.auth!, approval)
  return result
}
