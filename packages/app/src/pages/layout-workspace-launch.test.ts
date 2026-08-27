import { expect, test } from "bun:test"
import { materializeParallelWorkspaceParent, parallelWorkspaceComposerAvailable } from "./layout-workspace-launch"

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
