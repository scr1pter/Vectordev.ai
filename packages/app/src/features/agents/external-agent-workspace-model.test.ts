import { expect, test } from "bun:test"
import { externalAgentWorkspaceTabs } from "./external-agent-workspace-model"

test("external agents get the complete furnished workspace navigation", () => {
  expect(externalAgentWorkspaceTabs.map((tab) => tab.value)).toEqual([
    "chat",
    "files",
    "changes",
    "terminal",
    "browser",
    "activity",
  ])
})
