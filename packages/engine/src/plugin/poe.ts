import type { Hooks } from "@vectordevai/plugin"
import { poeOAuthConfiguration, ownedOAuthMatches } from "@vectordevai/core/provider-policy"
import { createPoeOAuth } from "@vectordevai/core/oauth/poe"
import { ownedOAuthFetch } from "@vectordevai/core/oauth/owned"

export async function PoeAuthPlugin(): Promise<Hooks> {
  return poeAuthHooks()
}
export function poeAuthHooks(configuration = poeOAuthConfiguration, oauth = createPoeOAuth()): Hooks {
  let active = new AbortController()
  return {
    async dispose() {
      active.abort()
    },
    auth: {
      provider: "poe",
      async loader(getAuth) {
        const value = await getAuth()
        if (value.type !== "oauth" || !ownedOAuthMatches(value, configuration())) return {}
        return {
          apiKey: "",
          fetch: ownedOAuthFetch("https://api.poe.com", async () => {
            const current = await getAuth()
            if (
              current.type !== "oauth" ||
              !ownedOAuthMatches(current, configuration()) ||
              current.expires <= Date.now()
            )
              throw new Error("Your Poe delegated key expired or its registration changed. Sign in again.")
            return current.access
          }),
        }
      },
      methods: [
        ...(configuration()
          ? [
              {
                type: "oauth" as const,
                label: "Sign in with Poe",
                async authorize() {
                  const app = configuration()
                  if (!app) throw new Error("Poe sign-in is not enabled for this Vector build. Use an API key.")
                  active.abort()
                  active = new AbortController()
                  const flow = await oauth.authorize(app, active.signal)
                  return {
                    url: flow.url,
                    instructions:
                      "Connect Vector in your browser. Poe issues a delegated API key; you can choose an expiry and revoke it in Poe's API-key settings.",
                    method: "auto" as const,
                    async callback() {
                      const value = await flow.complete()
                      if (!ownedOAuthMatches(value, configuration()))
                        throw new Error("Poe registration changed. Sign in again.")
                      return { ...value, type: "success" as const }
                    },
                  }
                },
              },
            ]
          : []),
        { type: "api", label: "Poe API key" },
      ],
    },
  }
}
