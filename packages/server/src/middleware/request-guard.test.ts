import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { requestGuard } from "./request-guard"

function run(headers: Record<string, string>, authenticationRequired = false, path = "/probe") {
  return Effect.runPromise(
    requestGuard(
      { guardedHostname: "127.0.0.1" },
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

  test("validates Origin on password-protected WebSocket upgrades", async () => {
    expect(
      (await run({ host: "localhost", origin: "https://attacker.example", upgrade: "websocket" }, true)).status,
    ).toBe(403)
    expect((await run({ host: "localhost", origin: "http://localhost", upgrade: "websocket" }, true)).status).toBe(204)
  })
})
