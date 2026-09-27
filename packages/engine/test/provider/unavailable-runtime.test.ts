import { expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

cliIt.live(
  "ignored credentials are explained by the real CLI, provider API and explicit model errors",
  ({ vector, home }) =>
    Effect.gen(function* () {
      const oauth = { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 0 }
      const env = {
        OPENAI_API_KEY: "",
        VECTOR_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
        VECTOR_CONFIG_CONTENT: JSON.stringify({
          disabled_providers: ["anthropic"],
          provider: {
            "company-gateway": {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: "http://127.0.0.1:9/v1" },
              models: { coder: { name: "Coder" } },
            },
          },
        }),
        VECTOR_AUTH_CONTENT: JSON.stringify({
          "github-copilot": oauth,
          openai: oauth,
          xai: oauth,
          poe: oauth,
          gitlab: oauth,
          digitalocean: { type: "api", key: "fixture-do-access", metadata: { oauth_access: "true" } },
          "removed-fixture": { type: "api", key: "fixture-removed-key" },
          anthropic: { type: "api", key: "fixture-disabled-key" },
          deepseek: { type: "api", key: "fixture-working-key" },
          "company-gateway": { type: "api", key: "fixture-custom-key" },
        }),
      }
      yield* Effect.promise(() => Bun.write(path.join(home, ".local/share/vector/auth.json"), env.VECTOR_AUTH_CONTENT))
      const list = yield* vector.spawn(["providers", "list"], { env })
      vector.expectExit(list, 0)
      expect(list.stdout).toContain("(ignored:")
      expect(list.stdout).toContain("sign-in is paused")
      expect(list.stdout).toContain("vector providers logout xai")
      // ChatGPT sign-in is supported again, so a saved OpenAI OAuth credential is used, not ignored.
      expect(list.stdout).not.toContain("vector providers logout openai")
      expect(list.stdout).toContain("provider is not configured")
      expect(list.stdout).toContain("provider is disabled")
      expect(list.stdout).not.toContain("fixture-access")
      expect(list.stdout).not.toContain("fixture-working-key")
      const server = yield* vector.serve({ env, readyTimeoutMs: 45_000 })
      const providers = yield* Effect.promise(async () => {
        const response = await fetch(`${server.url}/provider`)
        expect(response.status).toBe(200)
        return response.json() as Promise<{
          connected: string[]
          unavailable: { id: string; reason: string; message: string }[]
        }>
      })
      expect(providers.connected).toEqual(expect.arrayContaining(["deepseek", "company-gateway"]))
      expect(providers.unavailable.map((item) => [item.id, item.reason])).toEqual([
        ["github-copilot", "sign-in-paused"],
        ["xai", "sign-in-paused"],
        ["poe", "sign-in-paused"],
        ["gitlab", "sign-in-paused"],
        ["digitalocean", "sign-in-paused"],
        ["removed-fixture", "provider-not-configured"],
        ["anthropic", "disabled"],
      ])
      expect(JSON.stringify(providers.unavailable)).not.toContain("fixture-access")
      server.kill()
      const run = yield* vector.run("hello", { model: "github-copilot/gpt-4.1", format: "json", env })
      const errors = run.stdout
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map(
          (line) =>
            JSON.parse(line) as {
              type?: string
              error?: { data?: { message?: string } }
            },
        )
        .filter((event) => event.type === "error")
      expect(errors.some((event) => event.error?.data?.message?.includes("sign-in is paused"))).toBe(true)
      expect(run.stdout + run.stderr).toContain("Model unavailable: github-copilot/gpt-4.1")
      expect(run.stdout + run.stderr).not.toContain("Model not found: github-copilot/gpt-4.1")
      expect(run.stdout + run.stderr).toContain("sign-in is paused")
      expect(run.stdout + run.stderr).toContain("vector providers logout github-copilot")
      expect(run.stdout + run.stderr).not.toContain("Did you mean")
    }),
  120_000,
)
