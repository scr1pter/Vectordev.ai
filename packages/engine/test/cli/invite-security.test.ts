import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@vectordevai/core/flag/flag"
import { configureInviteAccess, inviteLink, publicInviteURL } from "../../src/cli/cmd/invite"
import { resolveNetworkOptionsNoConfig } from "../../src/cli/network"

const environmentKeys = [
  "VECTOR_SERVER_USERNAME",
  "VECTOR_SERVER_PASSWORD",
  "VECTOR_SERVER_GUEST_USERNAME",
  "VECTOR_SERVER_GUEST_PASSWORD",
  "VECTOR_SERVER_GUEST_WORKSPACES",
  "VECTOR_SERVER_GUEST_SESSIONS",
  "VECTOR_WORKSPACE_ID",
] as const
const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]))
const originalFlags = {
  username: Flag.VECTOR_SERVER_USERNAME,
  password: Flag.VECTOR_SERVER_PASSWORD,
  workspaceID: Flag.VECTOR_WORKSPACE_ID,
}

afterEach(() => {
  for (const key of environmentKeys) {
    const value = originalEnvironment[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  Flag.VECTOR_SERVER_USERNAME = originalFlags.username
  Flag.VECTOR_SERVER_PASSWORD = originalFlags.password
  Flag.VECTOR_WORKSPACE_ID = originalFlags.workspaceID
})

describe("invite security", () => {
  test("puts credentials only in the URL fragment", () => {
    const url = new URL(inviteLink("https://invite.example", "guest", "secret"))

    expect(url.search).toBe("")
    expect(url.username).toBe("")
    expect(url.password).toBe("")
    expect(new URLSearchParams(url.hash.slice(1)).get("auth_token")).toBe(btoa("guest:secret"))
  })

  test("accepts only credential-free HTTPS public origins", () => {
    expect(publicInviteURL("https://invite.example")?.origin).toBe("https://invite.example")
    for (const value of [
      "http://invite.example",
      "https://guest:secret@invite.example",
      "https://invite.example/path",
      "https://invite.example?token=secret",
      "https://invite.example#token=secret",
    ]) {
      expect(() => publicInviteURL(value)).toThrow()
    }
  })

  test("keeps the default listener on loopback", () => {
    expect(
      resolveNetworkOptionsNoConfig({
        hostname: "127.0.0.1",
        port: 0,
        mdns: false,
        "mdns-domain": "vector.local",
        unsecured: false,
        cors: [],
      }).hostname,
    ).toBe("127.0.0.1")
  })

  test("scopes guest credentials and the live listener to one workspace", () => {
    Flag.VECTOR_WORKSPACE_ID = undefined
    process.env.VECTOR_SERVER_GUEST_SESSIONS = "ses_inherited"
    const workspaceID = configureInviteAccess(
      { username: "owner", password: "owner-secret" },
      { username: "guest", password: "guest-secret" },
    )

    expect(workspaceID.startsWith("wrk_")).toBe(true)
    expect(process.env.VECTOR_SERVER_GUEST_WORKSPACES).toBe(workspaceID)
    expect(process.env.VECTOR_SERVER_GUEST_SESSIONS).toBeUndefined()
    expect(process.env.VECTOR_WORKSPACE_ID).toBe(workspaceID)
    expect(String(Flag.VECTOR_WORKSPACE_ID)).toBe(workspaceID)
  })
})
