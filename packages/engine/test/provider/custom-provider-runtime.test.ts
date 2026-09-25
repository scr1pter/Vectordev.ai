import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

cliIt.live(
  "an isolated Ollama configuration loads in the CLI and provider API and uses its stored key",
  ({ llm, vector, home }) =>
    Effect.gen(function* () {
      const authorization: (string | null)[] = []
      using proxy = Bun.serve({
        port: 0,
        async fetch(request) {
          authorization.push(request.headers.get("authorization"))
          return fetch(new URL(new URL(request.url).pathname, llm.url), {
            method: request.method,
            headers: request.headers,
            body: await request.text(),
          })
        },
      })
      yield* Effect.promise(() =>
        Bun.write(
          path.join(home, ".config/vector/vector.json"),
          JSON.stringify({
            formatter: false,
            lsp: false,
            model: "ollama/local-coder",
            provider: {
              ollama: {
                name: "My Ollama",
                npm: "@ai-sdk/openai-compatible",
                options: { baseURL: new URL("v1", proxy.url).href },
                models: { "local-coder": { limit: { context: 100_000, output: 10_000 }, tool_call: true } },
              },
            },
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(home, ".local/share/vector/auth.json"),
          JSON.stringify({ ollama: { type: "api", key: "fixture-local-provider-key" } }),
        ),
      )
      const env = { VECTOR_CONFIG_CONTENT: "{}" }
      const models = yield* vector.spawn(["models"], { env })
      vector.expectExit(models, 0)
      expect(models.stdout).toContain("ollama/local-coder")

      const server = yield* vector.serve({ env, readyTimeoutMs: 45_000 })
      const providers = yield* Effect.promise(async () => {
        const response = await fetch(`${server.url}/provider`)
        expect(response.status).toBe(200)
        return response.json() as Promise<{ connected: string[]; all: { id: string; source: string }[] }>
      })
      expect(providers.connected).toContain("ollama")
      expect(providers.all).toContainEqual(expect.objectContaining({ id: "ollama", source: "config" }))
      server.kill()

      yield* llm.text("custom provider reached")
      const result = yield* vector.run("say hi", { model: "ollama/local-coder", env })
      vector.expectExit(result, 0)
      expect(result.stdout).toBe("custom provider reached\n")
      expect(new Set(authorization)).toEqual(new Set(["Bearer fixture-local-provider-key"]))
    }),
  120_000,
)
