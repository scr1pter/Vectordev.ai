import { expect, test } from "bun:test"
import { ServerConnection } from "@/context/server"
import { sessionHref } from "@/utils/session-route"
import {
  materializeParallelWorkspaceParent,
  parallelWorkspaceComposerAvailable,
  parallelWorkspaceHref,
  parallelWorkspaceIDFromPath,
  parallelWorkspaceNavigation,
  parallelWorkspacePresentation,
  parallelWorkspaceToolDirectory,
  parallelWorkspaceView,
} from "./layout-workspace-launch"

test("a project-backed Start building draft can open the workspace launcher", () => {
  expect(
    parallelWorkspaceComposerAvailable({
      projectPath: "/repo",
      taskOpen: false,
      draftOpen: true,
      returnTaskOpen: false,
    }),
  ).toBe(true)
})

test("a remembered project alone does not unlock workspaces from Overview", () => {
  expect(
    parallelWorkspaceComposerAvailable({
      projectPath: "/repo",
      taskOpen: false,
      draftOpen: false,
      returnTaskOpen: false,
    }),
  ).toBe(false)
})

test("a draft becomes the parent task shared by single-agent and coordinated launchers", async () => {
  const calls: string[] = []
  const scope = await materializeParallelWorkspaceParent({
    scope: { sourcePath: "/repo", parentSessionId: undefined },
    draftID: "draft-1",
    createSession: async (sourcePath) => {
      calls.push(`create:${sourcePath}`)
      return { id: "session-1" }
    },
    rememberSession: (session) => calls.push(`remember:${session.id}`),
    promoteDraft: (draftID, sessionID) => calls.push(`promote:${draftID}:${sessionID}`),
  })

  expect(scope).toEqual({ sourcePath: "/repo", parentSessionId: "session-1" })
  expect(calls).toEqual(["create:/repo", "remember:session-1", "promote:draft-1:session-1"])
})

test("an existing task is reused without creating another parent", async () => {
  let created = false
  const scope = await materializeParallelWorkspaceParent({
    scope: { sourcePath: "/repo", parentSessionId: "session-existing" },
    draftID: "draft-1",
    createSession: async () => {
      created = true
      return { id: "session-new" }
    },
    rememberSession: () => undefined,
    promoteDraft: () => undefined,
  })

  expect(scope).toEqual({ sourcePath: "/repo", parentSessionId: "session-existing" })
  expect(created).toBe(false)
})

const externalRuntimes = ["claude-code", "codex", "cursor"] as const

test.each([...externalRuntimes])("%s opens as a dedicated workspace", (runtime) => {
  expect(
    parallelWorkspaceNavigation({
      workspaceID: "workspace-1",
      runtime,
      server: ServerConnection.Key.make("sidecar"),
      scope: { projectPath: "/Users/me/Vector App", taskId: "session-parent" },
    }),
  ).toEqual({
    mode: "external-workspace",
    href: "/parallel-workspaces/workspace-1?project=%2FUsers%2Fme%2FVector+App&parentSession=session-parent",
  })
})

test("external presentation never waits for a Vector session", () => {
  expect(parallelWorkspacePresentation("claude-code")).toBe("external-workspace")
  expect(parallelWorkspacePresentation("codex")).toBe("external-workspace")
  expect(parallelWorkspacePresentation("cursor")).toBe("external-workspace")
  expect(
    parallelWorkspaceNavigation({
      workspaceID: "workspace-1",
      runtime: "codex",
      agentSessionID: "an-irrelevant-vector-session",
      server: ServerConnection.Key.make("sidecar"),
      scope: { projectPath: "/repo", taskId: "session-parent" },
    }).mode,
  ).toBe("external-workspace")
})

test("Vector keeps its full session destination", () => {
  const server = ServerConnection.Key.make("sidecar")
  expect(
    parallelWorkspaceNavigation({
      workspaceID: "workspace-1",
      runtime: "vector",
      agentSessionID: "session-agent",
      server,
      scope: { projectPath: "/repo", taskId: "session-parent" },
    }),
  ).toEqual({
    mode: "session",
    href: `${sessionHref(server, "session-agent")}?project=%2Frepo&parentSession=session-parent`,
  })
})

test("only Vector without a session remains pending", () => {
  expect(
    parallelWorkspaceNavigation({
      workspaceID: "workspace-1",
      runtime: "vector",
      server: ServerConnection.Key.make("sidecar"),
      scope: { projectPath: "/repo", taskId: "session-parent" },
    }),
  ).toEqual({ mode: "pending" })
})

test("workspace routes preserve scope, view, and encoded ids", () => {
  const href = parallelWorkspaceHref({
    workspaceID: "agent/claude",
    scopeSearch: "?project=%2Frepo&parentSession=session-parent",
    view: "changes",
  })
  expect(href).toBe("/parallel-workspaces/agent%2Fclaude?project=%2Frepo&parentSession=session-parent&view=changes")
  expect(parallelWorkspaceIDFromPath(href.split("?")[0]!)).toBe("agent/claude")
  expect(parallelWorkspaceIDFromPath("/parallel-workspaces/swarm/run-1")).toBeUndefined()
  expect(parallelWorkspaceView("changes")).toBe("changes")
  expect(parallelWorkspaceView("files")).toBe("files")
  expect(parallelWorkspaceView("terminal")).toBe("terminal")
  expect(parallelWorkspaceView("browser")).toBe("browser")
  expect(parallelWorkspaceView("unknown")).toBe("chat")
})

test("external workspace tools are scoped to the isolated checkout", () => {
  expect(
    parallelWorkspaceToolDirectory({
      sourcePath: "/repo/main",
      isolatedPath: "/repo/.vector/workspaces/claude-1",
    }),
  ).toBe("/repo/.vector/workspaces/claude-1")
})
