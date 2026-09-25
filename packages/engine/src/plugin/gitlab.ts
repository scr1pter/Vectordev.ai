import type { Hooks, PluginInput } from "@vectordevai/plugin"
import {
  gitlabOAuthConfiguration,
  gitlabCredentialMatches,
  providerCredentialAllowed,
} from "@vectordevai/core/provider-policy"
import { createGitlabOAuth } from "@vectordevai/core/oauth/gitlab"

export async function GitlabAuthPlugin(input: PluginInput): Promise<Hooks> {
  return gitlabAuthHooks(input, gitlabOAuthConfiguration)
}

/** The factory keeps protocol tests independent of the release enablement gate. */
export function gitlabAuthHooks(
  input: PluginInput,
  configuration: typeof gitlabOAuthConfiguration,
  oauth = createGitlabOAuth(),
): Hooks {
  let active = new AbortController()
  const instance = (value?: string) => new URL(value || process.env.GITLAB_INSTANCE_URL || "https://gitlab.com").origin
  const prompts = [
    {
      type: "text" as const,
      key: "instanceUrl",
      message: "GitLab instance URL",
      placeholder: process.env.GITLAB_INSTANCE_URL || "https://gitlab.com",
      validate(value: string) {
        if (!value) return
        const url = URL.parse(value)
        return url &&
          ["https:", "http:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname === "/"
          ? undefined
          : "Enter your GitLab instance origin without a path or credentials"
      },
    },
  ]
  const registration = () => {
    const value = configuration()
    if (!value) throw new Error("GitLab Duo sign-in is not enabled for this Vector build. Use a personal access token.")
    return value
  }
  return {
    async dispose() {
      active.abort()
    },
    auth: {
      provider: "gitlab",
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type === "api") {
          if (!providerCredentialAllowed("gitlab", auth)) return {}
          return { apiKey: auth.key, instanceUrl: instance(auth.metadata?.instanceUrl) }
        }
        if (auth.type !== "oauth" || !gitlabCredentialMatches(auth, configuration())) return {}
        const app = registration()
        const value = auth.expires > Date.now() + 60_000 ? auth : await oauth.refresh(app, auth.refresh, active.signal)
        if (!gitlabCredentialMatches(value, configuration()))
          throw new Error("GitLab application configuration changed. Sign in again.")
        if (value !== auth) await input.client.auth.set({ path: { id: "gitlab" }, body: { ...value, type: "oauth" } })
        return { apiKey: value.access, instanceUrl: app.origin, clientId: app.clientId }
      },
      methods: [
        ...(configuration()
          ? [
              {
                type: "oauth" as const,
                label: "Sign in with GitLab (device code)",
                prompts,
                async authorize(inputs?: Record<string, string>) {
                  const app = registration()
                  if (inputs?.instanceUrl && instance(inputs.instanceUrl) !== app.origin)
                    throw new Error(
                      "Set GITLAB_INSTANCE_URL and your own GITLAB_OAUTH_CLIENT_ID for this instance before signing in.",
                    )
                  active.abort()
                  const flow = new AbortController()
                  active = flow
                  const device = await oauth.authorize(app, flow.signal)
                  return {
                    method: "auto" as const,
                    url: device.url,
                    instructions: device.instructions,
                    async callback() {
                      const value = await device.complete()
                      if (!gitlabCredentialMatches(value, configuration()))
                        throw new Error("GitLab application configuration changed. Sign in again.")
                      return { ...value, type: "success" as const }
                    },
                  }
                },
              },
            ]
          : []),
        { type: "api", label: "GitLab Personal Access Token", prompts },
      ],
    },
  }
}
