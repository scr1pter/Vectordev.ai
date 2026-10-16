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
    // Nor does any website, Vector's own included: a script there must not run commands on this computer.
    expect((await run({ host, origin: "https://vectordev.ai" })).status).toBe(403)
    expect((await run({ host, origin: "https://vectordev.ai", upgrade: "websocket" })).status).toBe(403)
    expect((await run({ host })).status).toBe(204)
    // Explicitly configured origins, or an explicit opt-in, still work.
    expect(
      (await run({ host, origin: "http://localhost:3000" }, false, "/probe", { cors: ["http://localhost:3000"] }))
        .status,
    ).toBe(204)
    expect(
      (await run({ host, origin: "http://localhost:5173" }, false, "/probe", { loopbackOrigins: true })).status,
    ).toBe(204)
    // With a password, local pages stay trusted unless the listener turns that off (release builds do).
    expect((await run({ host, origin: "http://localhost:5173" }, true)).status).toBe(204)
    expect((await run({ host, origin: "http://localhost:5173", upgrade: "websocket" }, true)).status).toBe(204)
  })

  test("a password server refuses other sites' pages even with credentials the browser cached", async () => {
    const host = "192.168.1.20:4096"
    // A form post or no-cors fetch from another site carries the Basic credentials a browser cached for this server.
    for (const origin of ["https://attacker.example", "null", "http://192.168.1.20:5173"])
      for (const site of ["cross-site", "same-site", undefined])
        expect(
          (await run({ host, origin, ...(site ? { "sec-fetch-site": site } : {}) }, true)).status,
          `${origin} ${site}`,
        ).toBe(403)
    // Vector's website is another site too, unless the server lists it.
    expect((await run({ host, origin: "https://vectordev.ai", "sec-fetch-site": "cross-site" }, true)).status).toBe(403)
    expect(
      (
        await run({ host, origin: "https://vectordev.ai", "sec-fetch-site": "cross-site" }, true, "/probe", {
          cors: ["https://vectordev.ai"],
        })
      ).status,
    ).toBe(204)
    // The server's own pages, the app's origins, configured origins and clients outside a browser still work.
    expect((await run({ host, origin: "http://192.168.1.20:4096" }, true)).status).toBe(204)
    expect((await run({ host, origin: "oc://renderer" }, true)).status).toBe(204)
    expect(
      (await run({ host, origin: "https://team.example" }, true, "/probe", { cors: ["https://team.example"] })).status,
    ).toBe(204)
    expect((await run({ host }, true)).status).toBe(204)
    // Behind a proxy that rewrites Host, the browser's own same-origin flag vouches for the app's page.
    expect(
      (await run({ host: "127.0.0.1:4096", origin: "https://vector.team.example", "sec-fetch-site": "same-origin" }, true))
        .status,
    ).toBe(204)
  })

  test("validates Origin on password-protected WebSocket upgrades", async () => {
    expect(
      (await run({ host: "localhost", origin: "https://attacker.example", upgrade: "websocket" }, true)).status,
    ).toBe(403)
    expect((await run({ host: "localhost", origin: "http://localhost", upgrade: "websocket" }, true)).status).toBe(204)
  })
})
