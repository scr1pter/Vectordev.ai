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
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/experimental/console")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/experimental/console/orgs")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/experimental/console/switch")).toBe(true)
  })

  test("host commands and permission answers require the server owner", () => {
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/pty")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/pty/:ptyID/connect-token")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/api/pty")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/session/:sessionID/shell")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/session/:sessionID/command")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/session/:sessionID/init")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/permission/:requestID/reply")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/session/:sessionID/permissions/:permissionID")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/api/session/:sessionID/permission/:requestID/reply")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/api/permission/request")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/api/question/request")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("PUT", "/auth/:providerID")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("PATCH", "/config")).toBe(true)
    // Trusting a project lets its config run code, so it is the owner's call too.
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/config/trust")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/config/trust")).toBe(false)
    // Accepting that free models may train on prompts is the owner's choice; a guest may only read it.
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/provider/free-models/consent")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/provider/free-models/consent")).toBe(false)
    // The app bootstraps from these, so a guest reads them, narrowed to its workspace by their handlers.
    for (const route of ["/global/health", "/global/event", "/global/config", "/project", "/project/current"])
      expect(ServerAuth.isOwnerOnlyRoute("GET", route)).toBe(false)
    expect(ServerAuth.isOwnerOnlyRoute("PATCH", "/global/config")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/global/dispose")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/project/:projectID/directories")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("PATCH", "/project/:projectID")).toBe(true)
    // A new worktree runs startup commands; removing or resetting one discards work outside the guest's workspace.
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/experimental/worktree")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("DELETE", "/experimental/worktree")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/experimental/worktree/reset")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/experimental/worktree")).toBe(false)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/vcs/commit")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/vcs/switch")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/vcs/apply")).toBe(false)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/vcs/status")).toBe(false)
    // A guest still prompts, reads its own pending requests and answers its own questions.
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/session/:sessionID/message")).toBe(false)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/session/:sessionID/prompt_async")).toBe(false)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/permission")).toBe(false)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/api/session/:sessionID/permission")).toBe(false)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/question/:requestID/reply")).toBe(false)
  })

  test("reusable passwords require loopback or encrypted transport", () => {
    expect(() => ServerAuth.assertSecurePasswordTransport("127.0.0.1", "secret")).not.toThrow()
    expect(() => ServerAuth.assertSecurePasswordTransport("http://localhost:4096", "secret")).not.toThrow()
    expect(() => ServerAuth.assertSecurePasswordTransport("https://vector.example", "secret")).not.toThrow()
    for (const host of ["10.0.0.2", "192.168.1.4", "172.20.0.5", "100.64.0.1", "vector.local", "vector", "[fd00::1]"]) {
      expect(() => ServerAuth.assertSecurePasswordTransport(`http://${host}:4096`, "secret")).not.toThrow()
    }
    expect(() => ServerAuth.assertSecurePasswordTransport("http://vector.example", "secret")).toThrow("cleartext")
    expect(() => ServerAuth.assertSecurePasswordTransport("0.0.0.0", "secret")).toThrow("cleartext")
    expect(() => ServerAuth.assertSecurePasswordTransport("http://vector.example", undefined)).not.toThrow()
  })

  test("a password listener binds off loopback only on a network marked trusted, like vector serve", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"])
      expect(() => ServerAuth.assertSecurePasswordListen(host, "secret", false)).not.toThrow()
    for (const host of ["0.0.0.0", "::", "192.168.1.4", "10.0.0.2", "vector.local", "vector", "vector.example"]) {
      expect(() => ServerAuth.assertSecurePasswordListen(host, "secret", false)).toThrow("--trusted-network")
      expect(() => ServerAuth.assertSecurePasswordListen(host, "secret", true)).not.toThrow()
    }
    expect(() => ServerAuth.assertSecurePasswordListen("0.0.0.0", undefined, false)).not.toThrow()
  })
})
