import { expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

cliIt.live(
  "a real CLI process with only GITHUB_TOKEN cannot connect Copilot",
  ({ vector }) =>
    Effect.gen(function* () {
      const env = {
        GITHUB_TOKEN: "fixture-github-token",
        OPENAI_API_KEY: "",
        VECTOR_CONFIG_CONTENT: "{}",
        VECTOR_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
      }
      const models = yield* vector.spawn(["models"], { env })
      vector.expectExit(models, 0)
      expect(models.stdout).not.toContain("github-copilot/")
      const connection = yield* vector.spawn(["providers", "login", "--provider", "github-copilot"], { env })
      expect(connection.stderr + connection.stdout).toContain("paused")
      expect(connection.stderr + connection.stdout).not.toContain("TypeError")
      const server = yield* vector.serve({ env, readyTimeoutMs: 45_000 })
      const providers = yield* Effect.promise(async () => {
        const response = await fetch(`${server.url}/provider`)
        expect(response.status).toBe(200)
        return response.json() as Promise<{ connected: string[]; all: { id: string }[] }>
      })
      expect(providers.connected.some((id) => id.startsWith("github-copilot"))).toBe(false)
      expect(providers.all.some((provider) => provider.id.startsWith("github-copilot"))).toBe(false)
      server.kill()
    }),
  120_000,
)
