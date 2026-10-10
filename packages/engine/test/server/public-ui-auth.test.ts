import { describe, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"

function app() {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            VECTOR_SERVER_USERNAME: "vector",
            VECTOR_SERVER_PASSWORD: "secret",
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler
  return (path: string, init?: RequestInit) =>
    Promise.resolve(handler(new Request(new URL(path, "http://localhost"), init), HttpApiApp.context))
}

describe("public UI authentication boundary", () => {
  test("allows UI bootstrap while keeping documentation and APIs authenticated", async () => {
    const request = app()
    const [ui, queryCredential, asset, doc, api] = await Promise.all([
      request("/"),
      request("/?auth_token=secret"),
      request("/site.webmanifest"),
      request("/doc"),
      request("/api/session"),
    ])

    expect(ui.status).not.toBe(401)
    expect(queryCredential.status).toBe(401)
    expect(asset.status).not.toBe(401)
    expect(doc.status).toBe(401)
    expect(api.status).toBe(401)
  })
})
