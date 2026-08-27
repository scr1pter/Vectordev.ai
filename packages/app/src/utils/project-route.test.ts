import { describe, expect, test } from "bun:test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { decodeRouteSegment, projectPathFromWorkspaceRoute, sessionIDFromRouteValue } from "./project-route"

describe("projectPathFromWorkspaceRoute", () => {
  test("decodes a legacy repository route", () => {
    const directory = "/Users/me/Vector"
    expect(projectPathFromWorkspaceRoute(`/${base64Encode(directory)}/session/ses_1`)).toBe(directory)
  })

  test.each([
    ["home", "/"],
    ["new session", "/new-session"],
    ["server session", "/server/bG9jYWw=/session/ses_1"],
    ["code", "/code"],
    ["work", "/work"],
    ["cloud", "/cloud"],
    ["canvas", "/canvas"],
    ["browser agent", "/browser-agent"],
    ["parallel workspaces", "/parallel-workspaces"],
    ["parallel workspace", "/parallel-workspaces/run-1"],
    ["parallel workspace swarm", "/parallel-workspaces/swarm/swarm-1"],
    [
      "parallel workspace session",
      "/parallel-workspaces/run-1/server/bG9jYWw=/session/ses_1",
    ],
  ])("never decodes the %s application route as a repository path", (_name, pathname) => {
    expect(projectPathFromWorkspaceRoute(pathname)).toBe("")
  })

  test.each(["%", "%E0%A4%A"])("returns an empty segment for malformed URI encoding %s", (value) => {
    expect(decodeRouteSegment(value)).toBe("")
  })

  test("decodes a valid route segment", () => {
    expect(decodeRouteSegment("ses%5F123")).toBe("ses_123")
  })

  test("accepts only clean session query values", () => {
    expect(sessionIDFromRouteValue("ses_123")).toBe("ses_123")
    expect(sessionIDFromRouteValue("evt_123")).toBe("")
    expect(sessionIDFromRouteValue("ses_123\nother")).toBe("")
    expect(sessionIDFromRouteValue("%")).toBe("")
  })
})
