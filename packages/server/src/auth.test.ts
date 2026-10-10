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

  test("host commands and permission answers require the server owner", () => {
    expect(ServerAuth.isOwnerOnlyRequest("POST", "/session/ses_1/shell")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRequest("POST", "/session/ses_1/command")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRequest("POST", "/session/ses_1/%73hell")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRequest("POST", "/permission/per_1/reply")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRequest("POST", "/session/ses_1/permissions/per_1")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRequest("POST", "/api/session/ses_1/permission/per_1/reply")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRequest("GET", "/api/permission/request")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRequest("GET", "/api/question/request")).toBe(true)
    // Trusting a project lets its config run code, so it is the owner's call too.
    expect(ServerAuth.isOwnerOnlyRequest("POST", "/config/trust")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRequest("GET", "/config/trust")).toBe(false)
    // The app bootstraps from these, so a guest reads them, narrowed to its workspace by their handlers.
    for (const route of ["/global/health", "/global/event", "/global/config", "/project", "/project/current"])
      expect(ServerAuth.isOwnerOnlyRequest("GET", route)).toBe(false)
    expect(ServerAuth.isOwnerOnlyRequest("PATCH", "/global/config")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRequest("POST", "/global/dispose")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRequest("GET", "/project/prj_1/directories")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRequest("PATCH", "/project/prj_1")).toBe(true)
    // A guest still prompts, reads its own pending requests and answers its own questions.
    expect(ServerAuth.isOwnerOnlyRequest("POST", "/session/ses_1/message")).toBe(false)
    expect(ServerAuth.isOwnerOnlyRequest("POST", "/session/ses_1/prompt_async")).toBe(false)
    expect(ServerAuth.isOwnerOnlyRequest("GET", "/permission")).toBe(false)
    expect(ServerAuth.isOwnerOnlyRequest("GET", "/api/session/ses_1/permission")).toBe(false)
    expect(ServerAuth.isOwnerOnlyRequest("POST", "/question/que_1/reply")).toBe(false)
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
