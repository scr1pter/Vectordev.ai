import { describe, expect, test } from "bun:test"
import {
  WORKSPACE_MODE_CHANGED_EVENT,
  announceWorkspaceMode,
  workspaceModeFromEvent,
} from "./workspace-mode"

describe("workspace mode events", () => {
  test("accepts only agent and editor mode announcements", () => {
    expect(workspaceModeFromEvent(new CustomEvent(WORKSPACE_MODE_CHANGED_EVENT, { detail: { mode: "agent" } }))).toBe(
      "agent",
    )
    expect(workspaceModeFromEvent(new CustomEvent(WORKSPACE_MODE_CHANGED_EVENT, { detail: { mode: "editor" } }))).toBe(
      "editor",
    )
    expect(workspaceModeFromEvent(new CustomEvent(WORKSPACE_MODE_CHANGED_EVENT, { detail: { mode: "canvas" } }))).toBe(
      undefined,
    )
    expect(workspaceModeFromEvent(new Event(WORKSPACE_MODE_CHANGED_EVENT))).toBe(undefined)
  })

  test("announces mode changes to the active window", () => {
    const modes: string[] = []
    const listener = (event: Event) => {
      const mode = workspaceModeFromEvent(event)
      if (mode) modes.push(mode)
    }

    window.addEventListener(WORKSPACE_MODE_CHANGED_EVENT, listener)
    announceWorkspaceMode("editor")
    announceWorkspaceMode("agent")
    window.removeEventListener(WORKSPACE_MODE_CHANGED_EVENT, listener)

    expect(modes).toEqual(["editor", "agent"])
  })
})
