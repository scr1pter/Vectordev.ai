import { afterAll, describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { ServerAuth } from "../auth"
import { Authorization, authorizationLayer } from "./authorization"

const Api = HttpApi.make("guest-gate").add(
  HttpApiGroup.make("test")
    .add(
      HttpApiEndpoint.post("pty", "/api/pty", { success: Schema.String }),
      HttpApiEndpoint.post("reply", "/api/session/:sessionID/permission/:requestID/reply", {
        params: { sessionID: Schema.String, requestID: Schema.String },
        success: Schema.String,
      }),
      HttpApiEndpoint.get("messages", "/api/session/:sessionID/message", {
        params: { sessionID: Schema.String },
        success: Schema.String,
      }),
    )
    .middleware(Authorization),
)

const handlers = HttpApiBuilder.group(Api, "test", (handlers) =>
  handlers
    .handle("pty", () => Effect.succeed("ran"))
    .handle("reply", () => Effect.succeed("ran"))
    .handle("messages", () => Effect.succeed("ran")),
)

const web = HttpRouter.toWebHandler(
  HttpApiBuilder.layer(Api).pipe(
    Layer.provide(handlers),
    Layer.provide(authorizationLayer),
    Layer.provide(
      ServerAuth.Config.configLayer({
        password: Option.some("owner-secret"),
        username: "vector",
        guestPassword: Option.some("guest-secret"),
        guestUsername: "guest",
      }),
    ),
    Layer.provide(HttpServer.layerServices),
  ),
  { disableLogger: true },
)
afterAll(() => web.dispose())

const send = (method: string, path: string, username: string, password: string) =>
  web
    .handler(
      new Request(`http://localhost${path}`, {
        method,
        headers: { authorization: ServerAuth.header({ username, password }) ?? "" },
      }),
    )
    .then((response) => response.status)

describe("guest owner-only gate", () => {
  // The router ignores case, repeated and trailing slashes and anything after ';', and a URL parser reads a
  // leading '//' as a host, so each of these runs the owner-only handler unless the gate judges the matched route.
  const spellings = (route: string) => [
    route,
    `/${route}`,
    `//${route}`,
    route.toUpperCase(),
    `${route}/`,
    `${route};x`,
    route.replace(/\/(?=[^/]*$)/, "//"),
  ]

  test("refuses a guest every spelling of an owner-only route", async () => {
    const attempts = [...spellings("/api/pty"), ...spellings("/api/session/ses_1/permission/per_1/reply")]
    const statuses = await Promise.all(attempts.map((route) => send("POST", route, "guest", "guest-secret")))
    expect(statuses.map((status, index) => ({ route: attempts[index], status }))).toEqual(
      attempts.map((route) => ({ route, status: 403 })),
    )
  })

  test("still serves the owner and a guest's own routes under the router's spellings", async () => {
    expect(await send("POST", "/API/PTY", "vector", "owner-secret")).toBe(200)
    expect(await send("POST", "/api//pty;x", "vector", "owner-secret")).toBe(200)
    expect(await send("GET", "/API/Session/ses_1/Message/", "guest", "guest-secret")).toBe(200)
  })
})
