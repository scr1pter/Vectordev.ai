import { describe, expect, test } from "bun:test"

import { parallelSessionCreateRequest } from "./parallel-session-scope"

describe("parallel agent session scope", () => {
  test("creates a regular engine session inside the isolated folder and associates it with its task", () => {
    const request = parallelSessionCreateRequest({
      workspaceId: "workspace-1",
      workspaceName: "Build authentication",
      isolatedPath: "/tmp/Vector runs/workspace-1",
      sourcePath: "/repo",
      parentSessionId: "ses_parent",
      provider: "anthropic",
      model: "claude-sonnet",
      agent: "build",
    })

    expect(request.path).toBe("/session?directory=%2Ftmp%2FVector+runs%2Fworkspace-1")
    expect(request.body).toMatchObject({
      title: "Build authentication",
      model: { providerID: "anthropic", id: "claude-sonnet" },
      metadata: {
        vector: {
          kind: "parallel-agent",
          workspaceId: "workspace-1",
          sourcePath: "/repo",
          parentSessionId: "ses_parent",
        },
      },
    })
    expect(request.body).not.toHaveProperty("parentID")
    expect(request.body).not.toHaveProperty("agent")
    expect(request.body).not.toHaveProperty("location")
  })

  test("uses the real task parent for internally scoped swarm workspaces", () => {
    const request = parallelSessionCreateRequest({
      workspaceId: "worker-1",
      workspaceName: "Worker",
      isolatedPath: "C:\\Vector\\worker-1",
      sourcePath: "C:\\repo",
      parentSessionId: "swarm:internal-scope",
      engineParentSessionId: "ses_main_task",
    })

    expect(request.body).not.toHaveProperty("parentID")
    expect(request.body.metadata.vector.parentSessionId).toBe("ses_main_task")
  })
})
