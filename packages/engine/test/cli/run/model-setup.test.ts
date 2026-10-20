import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { HttpClient } from "effect/unstable/http"
import { FREE_MODELS_SIGN_IN_TERMINAL } from "@vectordevai/core/free-model-choice"
import { FREE_MODEL_FALLBACKS } from "@vectordevai/schema/free-model"
import { cliIt } from "../../lib/cli-process"

cliIt.live("first run without a provider explains how to connect one", ({ vector }) =>
  Effect.gen(function* () {
    const result = yield* vector.spawn(["run", "say hello"], {
      env: { VECTOR_CONFIG_CONTENT: '{"enabled_providers":[]}' },
    })
    expect(result.exitCode).toBe(1)
    expect(result.timedOut).toBe(false)
    expect(result.stderr).toContain("vector auth login")
    expect(result.stderr).toContain("local provider")
    expect(result.stderr).not.toContain("Unexpected server error")
    expect(result.stderr).not.toContain("runLoop")
  }),
)

cliIt.live("the session API returns provider setup guidance as a client error", ({ vector }) =>
  Effect.gen(function* () {
    const server = yield* vector.serve({ env: { VECTOR_CONFIG_CONTENT: '{"enabled_providers":[]}' } })
    const session = yield* HttpClient.post(`${server.url}/session`).pipe(Effect.flatMap((response) => response.json))
    const id = (session as { id: string }).id
    expect(id).toBeString()
    const response = yield* Effect.promise(() =>
      fetch(`${server.url}/session/${id}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "hello" }] }),
      }),
    )
    expect(response.status).toBe(400)
    const body = yield* Effect.promise(() => response.json())
    expect(body).toMatchObject({ _tag: "InvalidRequestError", kind: "model_setup" })
    expect(body.message).toContain("vector auth login")
  }),
)

// The verifier's low of 18 October 2026: signed out, `vector run` and `vector models` never said how to get the free
// models, though the shared catalog was on.
cliIt.live("signed out with free models on, run and models say to sign in to Vector", ({ vector, home }) =>
  Effect.gen(function* () {
    // The shared catalog as the engine cached it; model fetches are off in tests, so the engine serves this copy.
    yield* Effect.promise(() =>
      Bun.write(
        path.join(home, ".cache", "vector", "free-models-v2.json"),
        JSON.stringify({ enabled: true, updatedAt: Date.now(), models: [FREE_MODEL_FALLBACKS[0]] }),
      ),
    )
    // Only Vector's own provider may load, and there is neither a Vector token nor an OpenRouter key.
    const env = {
      VECTOR_CONFIG_CONTENT: '{"enabled_providers":["vector"]}',
      VECTOR_APP_NAMESPACE: "vector",
      VECTOR_CLI_TOKEN: "",
      OPENROUTER_API_KEY: "",
    }
    const run = yield* vector.spawn(["run", "say hello"], { env })
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toContain("vector auth login")
    expect(run.stderr).toContain(FREE_MODELS_SIGN_IN_TERMINAL)
    expect(run.stderr).not.toMatch(/openrouter/i)
    const models = yield* vector.spawn(["models"], { env })
    vector.expectExit(models, 0, "models")
    expect(models.stderr).toContain(FREE_MODELS_SIGN_IN_TERMINAL)
    expect(models.stdout).not.toContain(FREE_MODELS_SIGN_IN_TERMINAL)
  }),
)

cliIt.live("signed out with free models off, run says nothing of signing in for them", ({ vector }) =>
  Effect.gen(function* () {
    const env = {
      VECTOR_CONFIG_CONTENT: '{"enabled_providers":["vector"]}',
      VECTOR_CLI_TOKEN: "",
      OPENROUTER_API_KEY: "",
    }
    const run = yield* vector.spawn(["run", "say hello"], { env })
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toContain("vector auth login")
    expect(run.stderr).not.toContain(FREE_MODELS_SIGN_IN_TERMINAL)
  }),
)

// The owner's words of 17 October 2026: Vector's account serves the free models "no matter who uses" them.
cliIt.live(
  "an OpenRouter key never hides the shared models, and alone it still says to sign in to Vector",
  ({ vector, home }) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        Bun.write(
          path.join(home, ".cache", "vector", "free-models-v2.json"),
          JSON.stringify({ enabled: true, updatedAt: Date.now(), models: [FREE_MODEL_FALLBACKS[0]] }),
        ),
      )
      // Child processes never receive VECTOR_CLI_TOKEN, so the sign-in is the CLI's stored account token.
      const account = path.join(home, ".local", "share", "vector", "cli-auth.json")
      const env = {
        VECTOR_CONFIG_CONTENT: '{"enabled_providers":["vector","openrouter"]}',
        VECTOR_APP_NAMESPACE: "vector",
        OPENROUTER_API_KEY: "sk-or-synthetic-not-a-key",
      }
      const shared = `vector/${FREE_MODEL_FALLBACKS[0].id}`
      // Signed in, the shared model is listed beside the OpenRouter account and runs on the shared allowance.
      yield* Effect.promise(() => Bun.write(account, JSON.stringify({ token: "vct_synthetic" })))
      const signedIn = yield* vector.spawn(["models"], { env })
      vector.expectExit(signedIn, 0, "models")
      expect(signedIn.stdout.split("\n")).toContain(shared)
      expect(signedIn.stderr).toContain("Provided by Vector")
      expect(signedIn.stderr).not.toContain(FREE_MODELS_SIGN_IN_TERMINAL)
      // With the OpenRouter key alone, the shared allowance is not listed, and the CLI says how to get it.
      yield* Effect.promise(() => Bun.file(account).delete())
      const keyOnly = yield* vector.spawn(["models"], { env })
      vector.expectExit(keyOnly, 0, "models")
      expect(keyOnly.stdout.split("\n")).not.toContain(shared)
      expect(keyOnly.stderr).toContain(FREE_MODELS_SIGN_IN_TERMINAL)
    }),
  60_000,
)
