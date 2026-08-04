import { beforeEach, describe, expect, test } from "bun:test"
import {
  bindWorkTaskSession,
  readWorkState,
  removeWorkProject,
  saveWorkProject,
  saveWorkTask,
  workProjectForTask,
  workTaskForDraft,
  workTaskForSession,
} from "./work-store"

const timestamp = "2026-08-04T12:00:00.000Z"

beforeEach(() => {
  localStorage.clear()
})

describe("Vector Work persistence", () => {
  test("persists a project and its task", () => {
    saveWorkProject({
      id: "project-1",
      name: "Launch",
      description: "Prepare Vector for launch",
      workspacePath: "/tmp/vector-launch",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    saveWorkTask({
      id: "task-1",
      projectId: "project-1",
      title: "Verify release",
      objective: "Build, test, and inspect the release",
      draftId: "draft-1",
      status: "draft",
      createdAt: timestamp,
      updatedAt: timestamp,
    })

    const state = readWorkState()
    expect(state.projects).toHaveLength(1)
    expect(state.tasks).toHaveLength(1)
    expect(workProjectForTask(state.tasks[0])?.name).toBe("Launch")
  })

  test("moves a task from its draft to the promoted agent session", () => {
    saveWorkTask({
      id: "task-1",
      projectId: "project-1",
      title: "Verify release",
      objective: "Build, test, and inspect the release",
      draftId: "draft-1",
      status: "draft",
      createdAt: timestamp,
      updatedAt: timestamp,
    })

    expect(workTaskForDraft("draft-1")?.status).toBe("draft")
    bindWorkTaskSession("draft-1", "session-1")

    expect(workTaskForDraft("draft-1")).toBeUndefined()
    expect(workTaskForSession("session-1")).toMatchObject({
      id: "task-1",
      status: "active",
      sessionId: "session-1",
    })
  })

  test("removing a project also removes its tasks", () => {
    saveWorkProject({
      id: "project-1",
      name: "Launch",
      description: "Prepare Vector for launch",
      workspacePath: "/tmp/vector-launch",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    saveWorkTask({
      id: "task-1",
      projectId: "project-1",
      title: "Verify release",
      objective: "Build, test, and inspect the release",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    })

    removeWorkProject("project-1")

    expect(readWorkState()).toEqual({ version: 1, projects: [], tasks: [] })
  })
})
