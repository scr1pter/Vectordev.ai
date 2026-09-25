import type { Hooks } from "@vectordevai/plugin"
import { OpenRouterOAuth } from "@vectordevai/core/oauth/openrouter"

export async function OpenRouterAuthPlugin(): Promise<Hooks> {
  const pending = new Set<Awaited<ReturnType<typeof OpenRouterOAuth.authorize>>>()
  return {
    dispose: async () => {
      for (const attempt of pending) attempt.close()
    },
    auth: {
      provider: "openrouter",
      methods: [
        {
          type: "oauth",
          label: "Connect OpenRouter",
          async authorize() {
            const attempt = await OpenRouterOAuth.authorize()
            pending.add(attempt)
            void attempt.key.finally(() => pending.delete(attempt)).catch(() => undefined)
            return {
              url: attempt.url,
              instructions:
                "Uses your own free OpenRouter account: 50 requests a day, or 1,000 if you've ever added $10 of OpenRouter credits. Finish connecting in a browser on this computer. For a remote engine, forward the loopback callback port or use an API key.",
              method: "auto",
              callback: async () => ({ type: "success", key: await attempt.key }),
            }
          },
        },
        { type: "api", label: "Enter an OpenRouter API key" },
      ],
    },
  }
}
