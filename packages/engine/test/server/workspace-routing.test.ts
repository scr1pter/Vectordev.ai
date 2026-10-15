import { describe, expect, test } from "bun:test"
import {
  isLocalWorkspaceRoute,
  getWorkspaceRouteSessionID,
  workspaceProxyURL,
} from "../../src/server/shared/workspace-routing"
import { SessionID } from "../../src/session/schema"

describe("isLocalWorkspaceRoute", () => {
  test("GET /session is local", () => {
    expect(isLocalWorkspaceRoute("GET", "/session")).toBe(true)
  })

  test("GET /session/ses_abc is local (prefix match)", () => {
    expect(isLocalWorkspaceRoute("GET", "/session/ses_abc")).toBe(true)
  })

  test("POST /session is not local (method mismatch)", () => {
    expect(isLocalWorkspaceRoute("POST", "/session")).toBe(false)
  })

  test("/session/status is forwarded regardless of method", () => {
    expect(isLocalWorkspaceRoute("GET", "/session/status")).toBe(false)
    expect(isLocalWorkspaceRoute("POST", "/session/status")).toBe(false)
  })

  test("unrecognized paths are not local", () => {
    expect(isLocalWorkspaceRoute("GET", "/config")).toBe(false)
    expect(isLocalWorkspaceRoute("POST", "/session/ses_abc/message")).toBe(false)
  })
})

describe("getWorkspaceRouteSessionID", () => {
  test("reads the session ID the router matched", () => {
    expect(getWorkspaceRouteSessionID({ sessionID: "ses_abc123" })).toBe(SessionID.make("ses_abc123"))
  })

  test("returns null for routes without a session param", () => {
    expect(getWorkspaceRouteSessionID({})).toBeNull()
    expect(getWorkspaceRouteSessionID({ requestID: "per_abc" })).toBeNull()
  })

  test("an EventV2 id in a session param cannot defect workspace routing", () => {
    expect(getWorkspaceRouteSessionID({ sessionID: "evt_03fc0908d002MS3jl97PqVqBBt" })).toBeNull()
  })

  test("returns null for any malformed session id", () => {
    expect(getWorkspaceRouteSessionID({ sessionID: "not-a-session" })).toBeNull()
  })
})

describe("workspaceProxyURL", () => {
  test("appends request path to target", () => {
    const result = workspaceProxyURL("http://remote:8080/base", new URL("http://localhost/config"))
    expect(result.toString()).toBe("http://remote:8080/base/config")
  })

  test("strips trailing slash on target before appending", () => {
    const result = workspaceProxyURL("http://remote:8080/base/", new URL("http://localhost/session/abc"))
    expect(result.pathname).toBe("/base/session/abc")
  })

  test("preserves query params from request but removes workspace", () => {
    const url = new URL("http://localhost/config?workspace=ws_123&keep=yes")
    const result = workspaceProxyURL("http://remote:8080/base", url)
    expect(result.searchParams.get("workspace")).toBeNull()
    expect(result.searchParams.get("keep")).toBe("yes")
  })

  test("preserves hash from request", () => {
    const url = new URL("http://localhost/page#section")
    const result = workspaceProxyURL("http://remote:8080", url)
    expect(result.hash).toBe("#section")
  })

  test("works with URL object as target", () => {
    const target = new URL("http://remote:3000/api")
    const result = workspaceProxyURL(target, new URL("http://localhost/users"))
    expect(result.toString()).toBe("http://remote:3000/api/users")
  })
})
