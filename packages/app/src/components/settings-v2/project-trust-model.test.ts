import { describe, expect, test } from "bun:test"
import { projectTrustSummary } from "./project-trust-model"

const status = (input: { trusted: boolean; ignored: boolean; settings: boolean }) => ({
  workspace: "/work/app",
  ...input,
})

describe("projectTrustSummary", () => {
  test("offers trust for a project whose own settings are ignored", () => {
    const summary = projectTrustSummary(status({ trusted: false, ignored: true, settings: true }), "app")
    expect(summary.state).toBe("untrusted")
    expect(summary.canTrust).toBe(true)
    expect(summary.description).toContain("Vector ignores them until you trust the project")
  })

  test("offers trust when only the user's own language servers, formatters and MCP servers are held back", () => {
    const summary = projectTrustSummary(status({ trusted: false, ignored: true, settings: false }), "app")
    expect(summary.state).toBe("untrusted")
    expect(summary.canTrust).toBe(true)
    expect(summary.description).toContain("has no Vector settings of its own")
  })

  test("a trusted project has nothing to approve and says a change asks again", () => {
    const summary = projectTrustSummary(status({ trusted: true, ignored: false, settings: true }), "app")
    expect(summary.state).toBe("trusted")
    expect(summary.canTrust).toBe(false)
    expect(summary.description).toContain("until you trust the project again")
  })

  test("--pure leaves project settings off and cannot be trusted around", () => {
    const summary = projectTrustSummary(status({ trusted: false, ignored: false, settings: true }), "app")
    expect(summary.state).toBe("pure")
    expect(summary.canTrust).toBe(false)
  })

  test("a project with nothing to hold back has nothing to trust", () => {
    const summary = projectTrustSummary(status({ trusted: false, ignored: false, settings: false }), "app")
    expect(summary.state).toBe("none")
    expect(summary.canTrust).toBe(false)
  })

  test("an unreadable status never offers trust", () => {
    const summary = projectTrustSummary(undefined, "app")
    expect(summary.state).toBe("unknown")
    expect(summary.canTrust).toBe(false)
  })
})
