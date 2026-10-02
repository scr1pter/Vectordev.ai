import type { Hooks } from "@vectordevai/plugin"
import { OpenRouterOAuth } from "@vectordevai/core/oauth/openrouter"
import { OPENROUTER_ACCOUNT_COPY } from "@vectordevai/core/free-model-choice"

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
              instructions: `${OPENROUTER_ACCOUNT_COPY} Finish connecting in a browser on this computer. For a remote engine, forward the loopback callback port or use an API key.`,
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
