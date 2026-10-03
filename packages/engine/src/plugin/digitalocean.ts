import type { Hooks, PluginInput } from "@vectordevai/plugin"
import type { Model } from "@vectordevai/sdk/v2"
import { digitalOceanOAuthConfiguration, ownedOAuthMatches } from "@vectordevai/core/provider-policy"
import { createDigitalOceanOAuth } from "@vectordevai/core/oauth/digitalocean"
import { ownedOAuthFetch } from "@vectordevai/core/oauth/owned"
const DO_INFERENCE_BASE = "https://inference.do-ai.run/v1"

function routerModel(router: { name: string }, providerID: string): Model {
  const id = `router:${router.name}`
  return {
    id,
    providerID,
    name: router.name,
    family: "digitalocean-inference-routers",
    api: { id, url: DO_INFERENCE_BASE, npm: "@ai-sdk/openai-compatible" },
    status: "active",
    headers: {},
    options: {},
    // Routers bill whichever model they pick, so no single price applies.
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 }, unpriced: true },
    limit: { context: 128_000, output: 8_192 },
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

export async function DigitalOceanAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return digitalOceanAuthHooks()
}
export function digitalOceanAuthHooks(
  configuration = digitalOceanOAuthConfiguration,
  oauth = createDigitalOceanOAuth(),
): Hooks {
  let active = new AbortController()
  const registration = () => {
    const value = configuration()
    if (!value)
      throw new Error("DigitalOcean sign-in is not enabled for this Vector build. Use an inference access key.")
    return value
  }
  return {
    async dispose() {
      active.abort()
    },
    provider: {
      id: "digitalocean",
      async models(provider, ctx) {
        if (
          ctx.auth?.type !== "oauth" ||
          !ownedOAuthMatches(ctx.auth, configuration()) ||
          ctx.auth.expires <= Date.now()
        )
          return provider.models
        const routers = await oauth.routers(ctx.auth.access, active.signal)
        return {
          ...provider.models,
          ...Object.fromEntries(
            routers.map((router) => [`router:${router.name}`, routerModel(router, "digitalocean")]),
          ),
        }
      },
    },
    auth: {
      provider: "digitalocean",
      async loader(getAuth) {
        const saved = await getAuth()
        if (saved.type !== "oauth" || !ownedOAuthMatches(saved, configuration())) return {}
        return {
          apiKey: "",
          fetch: ownedOAuthFetch("https://inference.do-ai.run", async () => {
            const value = await getAuth()
            if (value.type !== "oauth" || !ownedOAuthMatches(value, configuration()) || value.expires <= Date.now())
              throw new Error("DigitalOcean sign-in expired or its registration changed. Reconnect to continue.")
            return value.access
          }),
        }
      },
      methods: [
        ...(configuration()
          ? [
              {
                type: "oauth" as const,
                label: "Sign in with DigitalOcean",
                async authorize() {
                  active.abort()
                  active = new AbortController()
                  const flow = await oauth.authorize(registration(), active.signal)
                  return {
                    url: flow.url,
                    instructions: flow.instructions,
                    method: "auto" as const,
                    async callback() {
                      const value = await flow.complete()
                      if (!ownedOAuthMatches(value, configuration()))
                        throw new Error("DigitalOcean registration changed. Sign in again.")
                      return { ...value, type: "success" as const }
                    },
                  }
                },
              },
            ]
          : []),
        { type: "api", label: "DigitalOcean inference access key" },
      ],
    },
  }
}
