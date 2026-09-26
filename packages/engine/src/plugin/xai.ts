import { xaiOAuthConfiguration, ownedOAuthMatches } from "@vectordevai/core/provider-policy"
import { createXaiOAuth } from "@vectordevai/core/oauth/xai"
import { ownedOAuthFetch } from "@vectordevai/core/oauth/owned"
import type { Hooks, PluginInput } from "@vectordevai/plugin"

export async function XaiAuthPlugin(input: PluginInput): Promise<Hooks> {
  return xaiAuthHooks(input)
}
export function xaiAuthHooks(
  input: PluginInput,
  configuration = xaiOAuthConfiguration,
  oauth = createXaiOAuth(),
): Hooks {
  let active = new AbortController()
  const registration = () => {
    const value = configuration()
    if (!value) throw new Error("xAI sign-in is not enabled for this Vector build. Use an API key.")
    return value
  }
  return {
    async dispose() {
      active.abort()
    },
    auth: {
      provider: "xai",
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type !== "oauth" || !ownedOAuthMatches(auth, configuration())) return {}
        let refreshing: Promise<string> | undefined
        return {
          apiKey: "",
          fetch: ownedOAuthFetch("https://api.x.ai", async () => {
            const saved = await getAuth()
            if (saved.type !== "oauth" || !ownedOAuthMatches(saved, configuration()))
              throw new Error("xAI registration changed. Sign in again.")
            if (saved.expires > Date.now() + 120_000) return saved.access
            refreshing ??= oauth
              .refresh(registration(), saved.refresh, active.signal)
              .then(async (value) => {
                if (!ownedOAuthMatches(value, configuration()))
                  throw new Error("xAI registration changed. Sign in again.")
                await input.client.auth.set({ path: { id: "xai" }, body: { ...value, type: "oauth" } })
                return value.access
              })
              .finally(() => {
                refreshing = undefined
              })
            return refreshing
          }),
        }
      },
      methods: [
        ...(configuration()
          ? (["browser", "device"] as const).map((mode) => ({
              type: "oauth" as const,
              label: mode === "browser" ? "Sign in with xAI (browser)" : "Sign in with xAI (device code)",
              async authorize() {
                active.abort()
                active = new AbortController()
                const flow = await oauth[mode](registration(), active.signal)
                return {
                  url: flow.url,
                  instructions: flow.instructions,
                  method: "auto" as const,
                  async callback() {
                    const value = await flow.complete()
                    if (!ownedOAuthMatches(value, configuration()))
                      throw new Error("xAI registration changed. Sign in again.")
                    return { ...value, type: "success" as const }
                  },
                }
              },
            }))
          : []),
        { type: "api", label: "xAI API key" },
      ],
    },
  }
}
