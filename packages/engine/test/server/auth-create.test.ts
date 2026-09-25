import { expect } from "bun:test"
import { Effect } from "effect"
import { HttpServer } from "effect/unstable/http"
import { createVectorClient } from "@vectordevai/sdk/v2"
import { testEffect } from "../lib/effect"
import { httpApiLayer } from "./httpapi-layer"

const it = testEffect(httpApiLayer)

it.live("auth presence is secret-free and create-only writes return a conflict", () =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer
    const client = createVectorClient({ baseUrl: HttpServer.formatAddress(server.address) })
    const providerID = "http-create-only-fixture"
    yield* Effect.promise(() => client.auth.remove({ providerID }, { throwOnError: true }))
    const absent = yield* Effect.promise(() => client.auth.exists({ providerID }, { throwOnError: true }))
    expect(absent.data).toBe(false)
    const saved = yield* Effect.promise(() =>
      client.auth.set({ providerID, ifAbsent: "true", auth: { type: "api", key: "first-fixture" } }),
    )
    expect(saved.response.status).toBe(200)
    const exists = yield* Effect.promise(() => client.auth.exists({ providerID }, { throwOnError: true }))
    expect(exists.data).toBe(true)
    expect(JSON.stringify(exists.data)).not.toContain("first-fixture")
    const conflict = yield* Effect.promise(() =>
      client.auth.set({ providerID, ifAbsent: "true", auth: { type: "api", key: "second-fixture" } }),
    )
    expect(conflict.response.status).toBe(409)
    expect(conflict.error).toMatchObject({ message: expect.stringContaining("already exists") })
    const replaced = yield* Effect.promise(() =>
      client.auth.set({ providerID, auth: { type: "api", key: "intentional-replacement" } }),
    )
    expect(replaced.response.status).toBe(200)
    yield* Effect.promise(() => client.auth.remove({ providerID }, { throwOnError: true }))
  }),
)
