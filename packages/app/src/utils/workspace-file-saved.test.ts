import { describe, expect, test } from "bun:test"
import {
  notifyWorkspaceFileSaved,
  WORKSPACE_FILE_SAVED_EVENT,
  workspaceFileSavedDetail,
  workspaceFileSavedMatchesDirectory,
} from "./workspace-file-saved"

describe("workspace file saved events", () => {
  test("delivers the saved workspace and file", () => {
    const target = new EventTarget()
    let received: Event | undefined
    target.addEventListener(WORKSPACE_FILE_SAVED_EVENT, (event) => {
      received = event
    })

    notifyWorkspaceFileSaved({ directory: "/tmp/project", path: "README.md" }, target)

    expect(workspaceFileSavedDetail(received!)).toEqual({ directory: "/tmp/project", path: "README.md" })
  })

  test("matches equivalent workspace paths", () => {
    const event = new CustomEvent(WORKSPACE_FILE_SAVED_EVENT, {
      detail: { directory: "C:\\Vector\\workspace\\", path: "README.md" },
    })

    expect(workspaceFileSavedMatchesDirectory(event, "C:\\Vector\\workspace")).toBe(true)
    expect(workspaceFileSavedMatchesDirectory(event, "C:\\Vector\\other")).toBe(false)
  })

  test("ignores malformed events", () => {
    expect(workspaceFileSavedDetail(new Event(WORKSPACE_FILE_SAVED_EVENT))).toBeUndefined()
    expect(
      workspaceFileSavedDetail(new CustomEvent(WORKSPACE_FILE_SAVED_EVENT, { detail: { directory: "/tmp" } })),
    ).toBeUndefined()
  })
})
