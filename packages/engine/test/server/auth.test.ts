import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Option, Redacted } from "effect"
import { Flag } from "@vectordevai/core/flag/flag"
import { legacyName } from "@vectordevai/core/flag/legacy"
import { ServerAuth } from "../../src/server/auth"

const original = {
  VECTOR_SERVER_PASSWORD: Flag.VECTOR_SERVER_PASSWORD,
  VECTOR_SERVER_USERNAME: Flag.VECTOR_SERVER_USERNAME,
}

afterEach(() => {
  Flag.VECTOR_SERVER_PASSWORD = original.VECTOR_SERVER_PASSWORD
  Flag.VECTOR_SERVER_USERNAME = original.VECTOR_SERVER_USERNAME
})

describe("ServerAuth", () => {
  test("does not emit auth headers without a password", () => {
    Flag.VECTOR_SERVER_PASSWORD = undefined
    Flag.VECTOR_SERVER_USERNAME = "alice"

    expect(ServerAuth.header()).toBeUndefined()
    expect(ServerAuth.headers()).toBeUndefined()
  })

  test("defaults to the vector username", () => {
    Flag.VECTOR_SERVER_PASSWORD = "secret"
    Flag.VECTOR_SERVER_USERNAME = undefined

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("vector:secret").toString("base64")}`,
    })
  })

  test("uses the configured username", () => {
    Flag.VECTOR_SERVER_PASSWORD = "secret"
    Flag.VECTOR_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("alice:secret").toString("base64")}`,
    })
  })

  test("prefers explicit credentials", () => {
    Flag.VECTOR_SERVER_PASSWORD = "secret"
    Flag.VECTOR_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers({ password: "cli-secret", username: "bob" })).toEqual({
      Authorization: `Basic ${Buffer.from("bob:cli-secret").toString("base64")}`,
    })
  })

  test("validates decoded credentials against effect config", () => {
    const config = { password: Option.some("secret"), username: "alice" }

    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.authorized({ username: "alice", password: Redacted.make("secret") }, config)).toBe(true)
    expect(ServerAuth.authorized({ username: "vector", password: Redacted.make("secret") }, config)).toBe(false)
  })
})

test("server identities require an exact configured username and password", () => {
  for (const configured of ["vector", "custom"]) {
    const config = { password: Option.some("secret"), username: configured }
    expect(ServerAuth.identity({ username: configured, password: Redacted.make("secret") }, config)).toBe("owner")
    expect(ServerAuth.identity({ username: configured, password: Redacted.make("wrong") }, config)).toBeUndefined()
    expect(ServerAuth.identity({ username: "unrelated", password: Redacted.make("secret") }, config)).toBeUndefined()
  }
})

function loadConfig(input: Record<string, string>) {
  return Effect.runPromise(
    ServerAuth.Config.pipe(
      Effect.provide(ServerAuth.Config.layer),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(input))),
    ),
  )
}

test("saved connections using the earlier default username keep working while no username is configured", async () => {
  const config = await loadConfig({ VECTOR_SERVER_PASSWORD: "secret" })
  expect(config.username).toBe("vector")
  for (const username of ["vector", legacyName!])
    expect(ServerAuth.identity({ username, password: Redacted.make("secret") }, config)).toBe("owner")
  expect(ServerAuth.identity({ username: legacyName!, password: Redacted.make("wrong") }, config)).toBeUndefined()
  expect(ServerAuth.identity({ username: "unrelated", password: Redacted.make("secret") }, config)).toBeUndefined()
})

test("a configured username is the only owner username", async () => {
  const config = await loadConfig({ VECTOR_SERVER_PASSWORD: "secret", VECTOR_SERVER_USERNAME: "alice" })
  expect(ServerAuth.identity({ username: "alice", password: Redacted.make("secret") }, config)).toBe("owner")
  for (const username of ["vector", legacyName!])
    expect(ServerAuth.identity({ username, password: Redacted.make("secret") }, config)).toBeUndefined()
})
