import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "/tmp/vector-external-chat"
const parentSessionId = "ses_external_chat_parent"
const runtimes = [
  { id: "codex", label: "Codex" },
  { id: "claude-code", label: "Claude Code" },
  { id: "cursor", label: "Cursor Agent" },
]

for (const runtime of runtimes) {
  test(`${runtime.label} workspace is a conversation with safe running follow-ups`, async ({ page }, testInfo) => {
    const workspaceId = `workspace-${runtime.id}`
    const nativePrompts: string[] = []
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/session\/[^/]+\/(message|prompt_async)(?:\?|$)/.test(request.url())) {
        nativePrompts.push(request.url())
      }
    })
    await mockOpenCodeServer(page, {
      directory,
      project: { id: "project-external-chat", worktree: directory, vcs: "git", name: "External Chat" },
      provider: { all: [], connected: [], default: {} },
      sessions: [
        {
          id: parentSessionId,
          title: "External chat parent",
          directory,
          projectID: "project-external-chat",
          time: { created: 1, updated: 1 },
        },
      ],
      pageMessages: () => ({ items: [] }),
      fileList: (path) =>
        path
          ? []
          : [
              {
                name: "search.ts",
                path: "search.ts",
                absolute: `${directory}/${runtime.id}/search.ts`,
                type: "file",
                ignored: false,
              },
            ],
      fileContent: () => ({ type: "text", content: "export const searchKeyboardAccessible = true\n" }),
    })
    await page.route("**/lsp/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: "[]",
      }),
    )
    await page.addInitScript(
      ({ directory, parentSessionId, runtime, workspaceId }) => {
        localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
        localStorage.setItem(
          "vector.global.dat:server",
          JSON.stringify({
            projects: { local: [{ worktree: directory, expanded: true }] },
            lastProject: { local: directory },
          }),
        )
        const calls: { method: string; id: string; runtime: string; text?: string }[] = []
        const workspace = {
          id: workspaceId,
          name: "Improve the search experience",
          taskPrompt: "Make search keyboard accessible.",
          runtime: runtime.id,
          provider: "external",
          model: "fixture-model",
          sourcePath: directory,
          parentSessionId,
          isolatedPath: `${directory}/${runtime.id}`,
          isolation: "git-worktree",
          gitBranch: `test-${runtime.id}`,
          externalSessionId: `external-${runtime.id}`,
          status: "complete",
          progress: 100,
          lastAction: "Completed search updates",
          createdAt: "2026-08-30T10:00:00.000Z",
          lastActivityAt: "2026-08-30T10:01:00.000Z",
          changedFilesCount: 1,
          riskLevel: "low",
          estimatedCost: 0,
          actualCost: 0.02,
          finalSummary: "Legacy summary should not duplicate the response",
          mergeState: "none",
          logs: ['RAW_TRANSPORT_ONLY {"type":"thread.started"}'],
          terminalOutput: ["RAW_TRANSPORT_ONLY process log"],
          browserResults: [],
          changedFiles: ["search.ts"],
          diff: "",
          turns: [
            {
              id: "user-1",
              role: "user",
              text: "Make search keyboard accessible.",
              at: "2026-08-30T10:00:00.000Z",
              state: "done",
              messages: [],
              activity: [],
            },
            {
              id: "agent-1",
              role: "agent",
              text: "Legacy summary should not duplicate the response",
              at: "2026-08-30T10:01:00.000Z",
              state: "done",
              messages: [
                {
                  id: "message-1",
                  text: "## Search is ready\n\n- Added keyboard navigation\n- Preserved focus after selection\n\n```ts\nconst accessible = true\n```",
                },
              ],
              activity: [
                { id: "tool-1", label: "Read search.ts", kind: "tool", state: "done" },
                { id: "tool-2", label: "Run keyboard navigation tests", kind: "tool", state: "done" },
              ],
              streamTail: ['RAW_TRANSPORT_ONLY {"type":"item.completed"}'],
            },
          ],
        }
        const api = {
          list: async () => [structuredClone(workspace)],
          refresh: async () => structuredClone(workspace),
          followUp: async (id: string, text: string) => {
            calls.push({ method: "followUp", id, runtime: workspace.runtime, text })
            workspace.status = "editing"
            workspace.turns.push({
              id: "user-2",
              role: "user",
              text,
              at: "2026-08-30T10:02:00.000Z",
              state: "done",
              messages: [],
              activity: [],
            })
            workspace.turns.push({
              id: "agent-2",
              role: "agent",
              text: "",
              at: "2026-08-30T10:02:01.000Z",
              state: "running",
              messages: [],
              activity: [{ id: "tool-3", label: "Inspect focus behavior", kind: "tool", state: "running" }],
              streamTail: [],
            })
            return structuredClone(workspace)
          },
          stop: async (id: string) => {
            calls.push({ method: "stop", id, runtime: workspace.runtime })
            workspace.status = "stopped"
            workspace.turns[workspace.turns.length - 1].state = "stopped"
            return structuredClone(workspace)
          },
          recordedCalls: () => calls,
        }
        Object.defineProperty(window, "api", { configurable: true, value: { parallelWorkspaces: api } })
      },
      { directory, parentSessionId, runtime, workspaceId },
    )

    await page.goto(
      `/parallel-workspaces/${workspaceId}?${new URLSearchParams({ project: directory, parentSession: parentSessionId })}`,
    )
    const workspace = page.locator("[data-vector-external-agent-workspace]")
    await expect(workspace).toHaveAttribute("data-workspace-id", workspaceId)
    const conversation = workspace.locator("[data-vector-agent-conversation]")
    await expect(conversation.locator('[data-agent-turn="user"]')).toContainText("Make search keyboard accessible.")
    await expect(conversation.locator('[data-agent-turn="agent"] .vector-agent-reply ul li')).toHaveText([
      "Added keyboard navigation",
      "Preserved focus after selection",
    ])
    await expect(conversation.locator("pre code")).toContainText("const accessible = true")
    await expect(conversation).not.toContainText("RAW_TRANSPORT_ONLY")
    await expect(conversation).not.toContainText("Legacy summary should not duplicate")
    await expect(workspace.getByText("Agent summary", { exact: true })).toHaveCount(0)
    for (const label of ["Added", "Removed", "Risk", "Spend"]) {
      await expect(workspace.getByText(label, { exact: true })).toHaveCount(0)
    }
    await expect(page.locator('[data-slot="titlebar-tabs"]')).toHaveCount(0)
    await expect(workspace.getByRole("tablist")).toHaveCount(0)
    const activity = conversation.locator("[data-agent-tool-activity]").first()
    await expect(activity).not.toHaveAttribute("open", "")
    await activity.locator("summary").click()
    await expect(activity).toHaveAttribute("open", "")
    await expect(activity.getByText("Read search.ts", { exact: true })).toBeVisible()
    await expect(activity.getByText("Run keyboard navigation tests", { exact: true })).toBeVisible()
    await activity.locator("summary").click()
    await workspace.screenshot({ path: testInfo.outputPath(`${runtime.id}-workspace-chat.png`) })

    const composer = workspace.locator("[data-agent-chat-composer]")
    const prompt = composer.getByRole("textbox", { name: `Follow up with ${runtime.label}`, exact: true })
    await prompt.fill("Also test Escape to dismiss search.")
    await workspace.getByRole("button", { name: "Files", exact: true }).click()
    const editor = workspace.locator("[data-vector-codespace]")
    await expect(editor).toBeVisible()
    await editor
      .getByRole("button", { name: /search\.ts/ })
      .first()
      .click()
    await expect(editor.locator(".monaco-editor")).toBeVisible()
    await expect.poll(async () => (await editor.locator(".monaco-editor").boundingBox())?.width ?? 0).toBeGreaterThan(320)
    await expect(editor.locator(".monaco-editor")).toContainText("searchKeyboardAccessible")
    await expect(editor.getByText("Vector Agent", { exact: true })).toHaveCount(0)
    await expect(editor.locator("[data-vector-agent-conversation] .vector-agent-reply pre code")).toContainText(
      "const accessible = true",
    )
    await expect(prompt).toHaveValue("Also test Escape to dismiss search.")
    await workspace.screenshot({ path: testInfo.outputPath(`${runtime.id}-editor-companion.png`) })
    await workspace.getByRole("button", { name: "Back to conversation", exact: true }).click()
    await expect(prompt).toHaveValue("Also test Escape to dismiss search.")
    await workspace.getByRole("button", { name: "Files", exact: true }).click()
    await expect(editor).toBeVisible()
    await expect(prompt).toHaveValue("Also test Escape to dismiss search.")
    await composer.getByRole("button", { name: /send/i }).click()
    await expect(conversation.locator('[data-agent-turn="user"]').last()).toContainText(
      "Also test Escape to dismiss search.",
    )
    await expect(prompt).toBeEditable()
    await prompt.fill("Keep this draft while the agent works.")
    await expect(composer.getByRole("button", { name: /send/i }).and(composer.locator(":enabled"))).toHaveCount(0)
    await prompt.press("Enter")
    await expect(prompt).toHaveValue("Keep this draft while the agent works.")
    await workspace.getByRole("button", { name: /stop/i }).click()
    await expect(prompt).toHaveValue("Keep this draft while the agent works.")
    await expect(composer.getByRole("button", { name: /send/i })).toBeEnabled()
    const calls = await page.evaluate(() => {
      const boundary = window as unknown as { api: { parallelWorkspaces: { recordedCalls: () => unknown } } }
      return boundary.api.parallelWorkspaces.recordedCalls()
    })
    expect(calls).toEqual([
      { method: "followUp", id: workspaceId, runtime: runtime.id, text: "Also test Escape to dismiss search." },
      { method: "stop", id: workspaceId, runtime: runtime.id },
    ])
    expect(nativePrompts).toEqual([])
    await workspace.getByRole("button", { name: "Back to conversation", exact: true }).click()
    await expect(prompt).toHaveValue("Keep this draft while the agent works.")
    await expect(workspace).toHaveAttribute("data-workspace-id", workspaceId)
  })
}
