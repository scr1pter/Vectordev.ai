import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import type { CorsOptions } from "../cors"
import { requestGuard } from "./request-guard"

function run(
  headers: Record<string, string>,
  authenticationRequired = false,
  path = "/probe",
  options: CorsOptions = {},
) {
  return Effect.runPromise(
    requestGuard(
      { guardedHostname: "127.0.0.1", ...options },
      authenticationRequired,
    )(Effect.succeed(HttpServerResponse.empty({ status: 204 }))).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request(new URL(path, "http://localhost"), { headers })),
      ),
    ),
  )
}

describe("request transport guard", () => {
  test("rejects hostile Host and Origin on passwordless routes", async () => {
    expect((await run({ host: "attacker.example" })).status).toBe(403)
    expect((await run({ host: "localhost", origin: "https://attacker.example" })).status).toBe(403)
  })

  test("rejects query-string credentials on public and authenticated routes", async () => {
    expect((await run({ host: "localhost" }, false, "/?auth_token=secret")).status).toBe(401)
    expect((await run({ host: "localhost" }, true, "/?auth_token=secret")).status).toBe(401)
  })

  test("a passwordless listener trusts only its own origin among local pages", async () => {
    const host = "127.0.0.1:4096"
    // Another page on this machine, such as a repository's dev server, must not drive a passwordless listener.
    expect((await run({ host, origin: "http://localhost:5173" })).status).toBe(403)
    expect((await run({ host, origin: "http://127.0.0.1:3000", upgrade: "websocket" })).status).toBe(403)
    expect((await run({ host, origin: "http://127.0.0.1:4096" })).status).toBe(204)
    expect((await run({ host, origin: "https://vectordev.ai" })).status).toBe(204)
    expect((await run({ host })).status).toBe(204)
    // Explicitly configured origins, or an explicit opt-in, still work.
    expect(
      (await run({ host, origin: "http://localhost:3000" }, false, "/probe", { cors: ["http://localhost:3000"] }))
        .status,
    ).toBe(204)
    expect(
      (await run({ host, origin: "http://localhost:5173" }, false, "/probe", { loopbackOrigins: true })).status,
    ).toBe(204)
    // A password stops the attack instead, so local pages keep working there.
    expect((await run({ host, origin: "http://localhost:5173" }, true)).status).toBe(204)
    expect((await run({ host, origin: "http://localhost:5173", upgrade: "websocket" }, true)).status).toBe(204)
  })

  test("validates Origin on password-protected WebSocket upgrades", async () => {
    expect(
      (await run({ host: "localhost", origin: "https://attacker.example", upgrade: "websocket" }, true)).status,
    ).toBe(403)
    expect((await run({ host: "localhost", origin: "http://localhost", upgrade: "websocket" }, true)).status).toBe(204)
  })
})
