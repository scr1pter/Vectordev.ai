import { describe, expect, test } from "bun:test"
import { projectTrustFolders, projectTrustSummary, uniqueTrustWorkspaces } from "./project-trust-model"

const status = (input: { trusted: boolean; ignored: boolean; settings: boolean }) => ({
  workspace: "/work/app",
  ...input,
})

describe("projectTrustSummary", () => {
  test("offers trust for a repository whose own settings are ignored", () => {
    const summary = projectTrustSummary(status({ trusted: false, ignored: true, settings: true }), "app")
    expect(summary.state).toBe("untrusted")
    expect(summary.canTrust).toBe(true)
    expect(summary.description).toContain("Vector ignores them until you trust the repository")
  })

  test("offers trust when only the user's own language servers, formatters and MCP servers are held back", () => {
    const summary = projectTrustSummary(status({ trusted: false, ignored: true, settings: false }), "app")
    expect(summary.state).toBe("untrusted")
    expect(summary.canTrust).toBe(true)
    expect(summary.description).toContain("has no Vector settings of its own")
  })

  test("a trusted repository has nothing to approve and says a change asks again", () => {
    const summary = projectTrustSummary(status({ trusted: true, ignored: false, settings: true }), "app")
    expect(summary.state).toBe("trusted")
    expect(summary.canTrust).toBe(false)
    expect(summary.description).toContain("until you trust the repository again")
  })

  test("--pure leaves repository settings off and cannot be trusted around", () => {
    const summary = projectTrustSummary(status({ trusted: false, ignored: false, settings: true }), "app")
    expect(summary.state).toBe("pure")
    expect(summary.canTrust).toBe(false)
  })

  test("a repository with nothing to hold back has nothing to trust", () => {
    const summary = projectTrustSummary(status({ trusted: false, ignored: false, settings: false }), "app")
    expect(summary.state).toBe("none")
    expect(summary.canTrust).toBe(false)
  })

  test("every state says repository, never project", () => {
    const statuses = [
      undefined,
      ...[true, false].flatMap((trusted) =>
        [true, false].flatMap((ignored) => [true, false].map((settings) => status({ trusted, ignored, settings }))),
      ),
    ]
    const words = statuses
      .map((item) => projectTrustSummary(item, "app"))
      .map((item) => `${item.title} ${item.description}`)
    expect(words.filter((text) => /project/i.test(text))).toEqual([])
  })

  test("an unreadable status never offers trust", () => {
    const summary = projectTrustSummary(undefined, "app")
    expect(summary.state).toBe("unknown")
    expect(summary.canTrust).toBe(false)
  })
})

describe("projectTrustFolders", () => {
  test("checks an agent workspace session's own folder first, then the repository it came from", () => {
    expect(projectTrustFolders("/work/.vector/workspaces/agent-1/app", "/work/app")).toEqual([
      { path: "/work/.vector/workspaces/agent-1/app", kind: "session" },
      { path: "/work/app", kind: "repository" },
    ])
  })

  test("checks the repository once when the session runs in it", () => {
    expect(projectTrustFolders("/work/app", "/work/app")).toEqual([{ path: "/work/app", kind: "repository" }])
    expect(projectTrustFolders(undefined, "/work/app")).toEqual([{ path: "/work/app", kind: "repository" }])
    expect(projectTrustFolders("  ", " /work/app ")).toEqual([{ path: "/work/app", kind: "repository" }])
  })

  test("checks the session's folder when no repository is known, and nothing when neither is", () => {
    expect(projectTrustFolders("/work/scratch", undefined)).toEqual([{ path: "/work/scratch", kind: "session" }])
    expect(projectTrustFolders(undefined, undefined)).toEqual([])
  })
})

describe("uniqueTrustWorkspaces", () => {
  test("shows a session in a subfolder of its repository once, as the repository the engine trusts", () => {
    const entries = [
      { path: "/work/app/packages/web", kind: "session", status: { workspace: "/work/app" } },
      { path: "/work/app", kind: "repository", status: { workspace: "/work/app" } },
    ]
    expect(uniqueTrustWorkspaces(entries)).toEqual([entries[0]!])
  })

  test("keeps folders with their own trust, and folders whose status could not be read", () => {
    const entries = [
      { path: "/work/.vector/workspaces/agent-1/app", status: { workspace: "/work/.vector/workspaces/agent-1/app" } },
      { path: "/work/app", status: undefined },
    ]
    expect(uniqueTrustWorkspaces(entries)).toEqual(entries)
  })
})
