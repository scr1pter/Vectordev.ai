import { describe, expect, test } from "bun:test"
import { Option, Redacted } from "effect"
import { ServerAuth } from "./auth"

describe("server authentication", () => {
  test("an empty owner password cannot bypass guest authentication", () => {
    const config = {
      password: Option.some(""),
      username: "vector",
      guestPassword: Option.some("guest-secret"),
    }

    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.identity({ username: "vector", password: Redacted.make("") }, config)).toBeUndefined()
    expect(ServerAuth.identity({ username: "guest", password: Redacted.make("guest-secret") }, config)).toBe("guest")
  })

  test("nonempty owner credentials remain valid", () => {
    const config = { password: Option.some("owner-secret"), username: "vector" }
    expect(ServerAuth.identity({ username: "vector", password: Redacted.make("owner-secret") }, config)).toBe("owner")
    expect(ServerAuth.identity({ username: "vector", password: Redacted.make("") }, config)).toBeUndefined()
  })

  test("Teams routes require the server owner", () => {
    expect(ServerAuth.isOwnerOnlyRequest("GET", "/experimental/console")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRequest("GET", "/experimental/console/orgs")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRequest("POST", "/experimental/console/switch")).toBe(true)
  })

  test("encoded owner-only routes remain owner-only", () => {
    expect(ServerAuth.isOwnerOnlyRequest("POST", "/api/%70ty")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRequest("POST", "/%63onfig")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRequest("POST", "/m%2563p")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRequest("GET", "/api/session/ses_%31")).toBe(false)
    expect(ServerAuth.isOwnerOnlyRequest("GET", "/api/%ZZ")).toBe(true)
  })

  test("reusable passwords require loopback or encrypted transport", () => {
    expect(() => ServerAuth.assertSecurePasswordTransport("127.0.0.1", "secret")).not.toThrow()
    expect(() => ServerAuth.assertSecurePasswordTransport("http://localhost:4096", "secret")).not.toThrow()
    expect(() => ServerAuth.assertSecurePasswordTransport("https://vector.example", "secret")).not.toThrow()
    expect(() => ServerAuth.assertSecurePasswordTransport("http://vector.example", "secret")).toThrow("cleartext")
    expect(() => ServerAuth.assertSecurePasswordTransport("0.0.0.0", "secret")).toThrow("cleartext")
    expect(() => ServerAuth.assertSecurePasswordTransport("http://vector.example", undefined)).not.toThrow()
  })
})
