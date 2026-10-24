import { expect, test } from "@playwright/test"
import { mockVectorServer } from "../utils/mock-server"

// The rules for running a user's own coding agent, as its conversation shows them: a failed check waits for the user
// to choose Try a fix instead of the agent running again by itself, and what the agent said about its usage stays on
// its reply word for word. The desktop bridge is a fake that records every call, so no agent CLI ever runs.
const directory = "/tmp/vector-external-rules"
const parentSessionId = "ses_external_rules_parent"
const workspaceId = "workspace-rules"
const failure = "src/search.ts(4,7): error TS2322: Type 'string' is not assignable to type 'number'."

test("a failed check waits for Try a fix, which sends it once as the user's message", async ({ page }, testInfo) => {
  await mockVectorServer(page, {
    directory,
    project: { id: "project-external-rules", worktree: directory, vcs: "git", name: "External Rules" },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: parentSessionId,
        title: "External rules parent",
        directory,
        projectID: "project-external-rules",
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ directory, parentSessionId, workspaceId, failure }) => {
      localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
      localStorage.setItem(
        "vector.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      const calls: { method: string; id: string }[] = []
      const workspace = {
        id: workspaceId,
        name: "Fix the search types",
        taskPrompt: "Make the search result count a number.",
        runtime: "claude-code",
        provider: "Claude Code",
        model: "Runtime default",
        sourcePath: directory,
        parentSessionId,
        isolatedPath: `${directory}/isolated`,
        isolation: "git-worktree",
        gitBranch: "vector-parallel/rules",
        externalSessionId: "claude-session",
        excludedFromLearning: true,
        status: "needs review",
        progress: 100,
        lastAction: "A check failed. Try a fix sends it to Claude Code.",
        createdAt: "2026-10-23T10:00:00.000Z",
        lastActivityAt: "2026-10-23T10:01:00.000Z",
        changedFilesCount: 1,
        riskLevel: "high",
        estimatedCost: "Reported by runtime when available",
        finalSummary: "Changed the count.\n\nGuardrails: Typecheck failed after the isolated edit.",
        mergeState: "none",
        logs: [],
        terminalOutput: [],
        browserResults: [],
        changedFiles: ["src/search.ts"],
        diff: "",
        error: `bun run typecheck failed:\n${failure}`,
        validationPassed: false,
        validationReport: {
          startedAt: "2026-10-23T10:00:30.000Z",
          completedAt: "2026-10-23T10:00:40.000Z",
          passed: false,
          hadChecks: true,
          failureSummary: `bun run typecheck failed:\n${failure}`,
          checks: [
            {
              id: "typecheck",
              label: "Typecheck",
              command: "bun",
              args: ["run", "typecheck"],
              reason: "package.json script",
              status: "failed",
              exitCode: 2,
              durationMs: 900,
              output: failure,
            },
          ],
        },
        turns: [
          {
            id: "user-1",
            role: "user",
            text: "Make the search result count a number.",
            at: "2026-10-23T10:00:00.000Z",
            state: "done",
          },
          {
            id: "agent-1",
            role: "agent",
            text: "Changed the count.",
            at: "2026-10-23T10:00:20.000Z",
            state: "done",
            messages: [{ id: "message-1", text: "Changed the count to a number." }],
            notices: ["You've used 90% of your 5-hour limit · resets 3pm"],
          },
        ],
      }
      const api = {
        list: async () => [structuredClone(workspace)],
        refresh: async () => structuredClone(workspace),
        repair: async (id: string) => {
          calls.push({ method: "repair", id })
          workspace.status = "editing"
          workspace.turns.push({
            id: "user-2",
            role: "user",
            text: `This check failed after the changes in this folder. Please fix what makes it fail, then run it again.\n\n${workspace.validationReport.failureSummary}`,
            at: "2026-10-23T10:02:00.000Z",
            state: "done",
          })
          workspace.turns.push({
            id: "agent-2",
            role: "agent",
            text: "",
            at: "2026-10-23T10:02:01.000Z",
            state: "running",
          })
          return structuredClone(workspace)
        },
        followUp: async (id: string) => {
          calls.push({ method: "followUp", id })
          return structuredClone(workspace)
        },
        stop: async (id: string) => structuredClone(workspace),
        recordedCalls: () => calls,
      }
      Object.defineProperty(window, "api", { configurable: true, value: { parallelWorkspaces: api } })
    },
    { directory, parentSessionId, workspaceId, failure },
  )

  await page.goto(
    `/parallel-workspaces/${workspaceId}?${new URLSearchParams({ project: directory, parentSession: parentSessionId })}`,
  )
  const workspace = page.locator("[data-vector-external-agent-workspace]")
  await expect(workspace).toHaveAttribute("data-workspace-id", workspaceId)
  const conversation = workspace.locator("[data-vector-agent-conversation]")

  // The agent's own words about its usage, unchanged, under its reply.
  await expect(conversation.locator("[data-agent-notices] li")).toHaveText([
    "You've used 90% of your 5-hour limit · resets 3pm",
  ])

  // The failed check, its command and output, and the one way the agent runs on it again.
  const card = workspace.locator("[data-agent-check-failed]")
  await expect(card).toBeVisible()
  await expect(card).toContainText("Typecheck failed")
  await expect(card).toContainText("bun run typecheck")
  await expect(card).toContainText(failure)
  await expect(card).toContainText("Vector doesn't run Claude Code again on its own.")
  // The failure is shown once, in the card, not again as an error banner above the conversation.
  await expect(workspace.locator(".vector-agent-chat-error")).toHaveCount(0)
  await workspace.screenshot({ path: testInfo.outputPath("external-agent-try-a-fix.png") })

  await card.getByRole("button", { name: "Try a fix", exact: true }).click()
  await expect(conversation.locator('[data-agent-turn="user"]').last()).toContainText(
    "This check failed after the changes in this folder.",
  )
  await expect(conversation.locator('[data-agent-turn="user"]').last()).toContainText(failure)
  // Running again, so the card is gone until the checks fail again.
  await expect(card).toHaveCount(0)
  const calls = await page.evaluate(() => {
    const boundary = window as unknown as { api: { parallelWorkspaces: { recordedCalls: () => unknown } } }
    return boundary.api.parallelWorkspaces.recordedCalls()
  })
  expect(calls).toEqual([{ method: "repair", id: workspaceId }])
})
