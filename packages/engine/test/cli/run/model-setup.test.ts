import { expect } from "bun:test"
import { Effect } from "effect"
import { HttpClient } from "effect/unstable/http"
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
