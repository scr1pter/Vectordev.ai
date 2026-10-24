import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"

// Choosing the model a Claude Code, Codex or Cursor workspace runs, from its own composer. The desktop bridge is a
// fake that records what the picker sends, so no CLI and no model provider is involved.
const directory = "/tmp/vector-external-model"
const parentSessionId = "ses_external_model_parent"
const runtimes = [
  { id: "claude-code", label: "Claude Code", pick: "Opus (latest)", value: "opus" },
  { id: "codex", label: "Codex", pick: "GPT-5.5", value: "gpt-5.5" },
  { id: "cursor", label: "Cursor Agent", pick: "Composer 2.5", value: "composer-2.5" },
]

for (const runtime of runtimes) {
  test(`${runtime.label} workspace keeps a model picker in its composer`, async ({ page }, testInfo) => {
    const workspaceId = `workspace-model-${runtime.id}`
    await mockVectorServer(page, {
      directory,
      project: { id: "project-external-model", worktree: directory, vcs: "git", name: "External Model" },
      provider: { all: [], connected: [], default: {} },
      sessions: [
        {
          id: parentSessionId,
          title: "External model parent",
          directory,
          projectID: "project-external-model",
          time: { created: 1, updated: 1 },
        },
      ],
      pageMessages: () => ({ items: [] }),
    })
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
        const calls: { id: string; model?: string }[] = []
        const workspace: Record<string, unknown> = {
          id: workspaceId,
          revision: 1,
          name: "Tidy the search module",
          taskPrompt: "Tidy the search module.",
          runtime: runtime.id,
          provider: runtime.label,
          model: "Runtime default",
          sourcePath: directory,
          parentSessionId,
          isolatedPath: `${directory}/${runtime.id}`,
          isolation: "git-worktree",
          gitBranch: `test-${runtime.id}`,
          externalSessionId: `external-${runtime.id}`,
          status: "complete",
          progress: 100,
          lastAction: "Done",
          createdAt: "2026-10-23T10:00:00.000Z",
          lastActivityAt: "2026-10-23T10:01:00.000Z",
          changedFilesCount: 0,
          riskLevel: "low",
          estimatedCost: "",
          finalSummary: "Tidied.",
          mergeState: "none",
          logs: [],
          terminalOutput: [],
          browserResults: [],
          changedFiles: [],
          diff: "",
          turns: [
            {
              id: "user-1",
              role: "user",
              text: "Tidy the search module.",
              at: "2026-10-23T10:00:00.000Z",
              state: "done",
            },
            {
              id: "agent-1",
              role: "agent",
              text: "Tidied.",
              at: "2026-10-23T10:01:00.000Z",
              state: "done",
              messages: [{ id: "message-1", text: "Tidied." }],
              activity: [],
            },
          ],
        }
        const api = {
          list: async () => [structuredClone(workspace)],
          refresh: async () => structuredClone(workspace),
          setRuntimeModel: async (id: string, model?: string) => {
            calls.push({ id, model })
            workspace.runtimeModel = model
            workspace.model = model ?? "Runtime default"
            workspace.revision = Number(workspace.revision) + 1
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
    const composer = page.locator("[data-agent-chat-composer]")
    const chip = composer.getByRole("button", { name: `${runtime.label} model: Agent default`, exact: true })
    await expect(chip).toBeVisible()

    await chip.click()
    const picker = page.locator(".vector-model-popover")
    await expect(picker).toBeVisible()
    // Vector's picker, over the runtime's own models: the default is the current model, the runtime is the section,
    // and there is no provider to connect.
    await expect(picker.locator('[data-model-section="recent"]')).toContainText("Current model")
    await expect(picker.locator('[data-model-section="provider"]')).toContainText(runtime.label)
    await expect(picker.getByText("Connect provider")).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`${runtime.id}-model-picker.png`) })
    await picker.getByRole("menuitemradio", { name: `${runtime.pick}, ${runtime.label}`, exact: true }).click()

    await expect(
      composer.getByRole("button", { name: `${runtime.label} model: ${runtime.pick}`, exact: true }),
    ).toBeVisible()
    const calls = await page.evaluate(() => {
      const boundary = window as unknown as { api: { parallelWorkspaces: { recordedCalls: () => unknown } } }
      return boundary.api.parallelWorkspaces.recordedCalls()
    })
    expect(calls).toEqual([{ id: workspaceId, model: runtime.value }])

    // The pick is remembered for this runtime and leads the picker next time.
    await composer.getByRole("button", { name: `${runtime.label} model: ${runtime.pick}`, exact: true }).click()
    await expect(picker.locator('[data-model-section="recent"]')).toContainText("Recently used")
    await expect(picker.locator('[data-model-section="recent"]')).toContainText(runtime.pick)
  })
}

test("the agent launcher picks the model a new Claude Code agent starts on", async ({ page }, testInfo) => {
  const directory = "/tmp/vector-external-model-launch"
  const sessionID = "ses_external_model_launch"
  await mockVectorServer(page, {
    directory,
    project: { id: "project-external-model-launch", worktree: directory, vcs: "git", name: "Model Launch" },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: sessionID,
        title: "Model launch",
        directory,
        projectID: "project-external-model-launch",
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript((projectDirectory) => {
    localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
    localStorage.setItem(
      "vector.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: projectDirectory, expanded: true }] },
        lastProject: { local: projectDirectory },
      }),
    )
    const created: Record<string, unknown>[] = []
    const api = {
      parallelWorkspaces: {
        list: async () => [],
        create: async (input: Record<string, unknown>) => {
          created.push(input)
          throw new Error("fixture stops before provisioning")
        },
        recordedCreates: () => created,
      },
      externalAgents: {
        detect: async () => [
          {
            id: "claude-code",
            name: "Claude Code",
            cli: "claude",
            installed: true,
            signedIn: true,
            version: "2.1.215",
          },
        ],
      },
    }
    Object.defineProperty(window, "api", { configurable: true, value: api })
  }, directory)

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await page.getByRole("button", { name: "New workspace", exact: true }).click()
  const launcher = page.getByRole("dialog", { name: "New isolated agent" })
  await expect(launcher).toBeVisible()
  // Vector's own runtime picks its model from the providers; the CLI model control is for the external runtimes.
  await expect(launcher.getByRole("button", { name: /model: Agent default$/ })).toHaveCount(0)

  await chooseInHostLocally(page, "Claude Code")
  const control = launcher.getByRole("button", { name: "Claude Code model: Agent default", exact: true })
  await expect(control).toBeVisible()
  await control.click()
  await page
    .locator(".vector-model-popover")
    .getByRole("menuitemradio", { name: "Sonnet (latest), Claude Code", exact: true })
    .click()
  await expect(launcher.getByRole("button", { name: "Claude Code model: Sonnet (latest)", exact: true })).toBeVisible()
  await launcher.screenshot({ path: testInfo.outputPath("launcher-model.png") })

  await launcher.getByLabel("Agent instructions").fill("Tidy the search module.")
  await launcher.getByRole("button", { name: "Launch agent", exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const boundary = window as unknown as {
          api: { parallelWorkspaces: { recordedCreates: () => { runtime?: string; runtimeModel?: string }[] } }
        }
        return boundary.api.parallelWorkspaces.recordedCreates().map((input) => [input.runtime, input.runtimeModel])
      }),
    )
    .toEqual([["claude-code", "sonnet"]])
})

test("a model Claude Code refused is not a new agent's start model until it is picked again", async ({ page }) => {
  const directory = "/tmp/vector-external-model-refused"
  const sessionID = "ses_external_model_refused"
  await mockVectorServer(page, {
    directory,
    project: { id: "project-external-model-refused", worktree: directory, vcs: "git", name: "Model Refused" },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: sessionID,
        title: "Model refused",
        directory,
        projectID: "project-external-model-refused",
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ directory, sessionID }) => {
      localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
      localStorage.setItem(
        "vector.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      // Claude Fable 5.1 was the last pick, and the agent launched on it came back refused a minute later.
      const now = Date.now()
      localStorage.setItem(
        "vector.global.dat:external-agent-models",
        JSON.stringify({
          picks: {
            "claude-code": [
              { id: "claude-fable-5-1", at: now - 120_000 },
              { id: "sonnet", at: now - 180_000 },
            ],
          },
        }),
      )
      const refused = {
        id: "workspace-model-refused",
        revision: 2,
        name: "Tidy the search module",
        taskPrompt: "Tidy the search module.",
        runtime: "claude-code",
        provider: "Claude Code",
        model: "Runtime default",
        refusedRuntimeModel: { model: "claude-fable-5-1", at: new Date(now - 60_000).toISOString() },
        sourcePath: directory,
        parentSessionId: sessionID,
        isolatedPath: `${directory}/claude-code`,
        isolation: "git-worktree",
        gitBranch: "test-claude-code",
        status: "failed",
        progress: 100,
        lastAction: "Failed",
        createdAt: new Date(now - 90_000).toISOString(),
        lastActivityAt: new Date(now - 60_000).toISOString(),
        changedFilesCount: 0,
        riskLevel: "low",
        estimatedCost: "",
        finalSummary: "",
        mergeState: "none",
        logs: [],
        terminalOutput: [],
        browserResults: [],
        changedFiles: [],
        diff: "",
        error: "There's an issue with the selected model (claude-fable-5-1).",
      }
      const created: Record<string, unknown>[] = []
      const api = {
        parallelWorkspaces: {
          list: async () => [structuredClone(refused)],
          refresh: async () => structuredClone(refused),
          create: async (input: Record<string, unknown>) => {
            created.push(input)
            throw new Error("fixture stops before provisioning")
          },
          recordedCreates: () => created,
        },
        externalAgents: {
          detect: async () => [
            {
              id: "claude-code",
              name: "Claude Code",
              cli: "claude",
              installed: true,
              signedIn: true,
              version: "2.1.215",
            },
          ],
        },
      }
      Object.defineProperty(window, "api", { configurable: true, value: api })
    },
    { directory, sessionID },
  )

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await page.getByRole("button", { name: "New workspace", exact: true }).click()
  const launcher = page.getByRole("dialog", { name: "New isolated agent" })
  await expect(launcher).toBeVisible()
  await chooseInHostLocally(page, "Claude Code")

  // The refused model left Recently used, so the launcher starts on the pick before it.
  const control = launcher.getByRole("button", { name: "Claude Code model: Sonnet (latest)", exact: true })
  await expect(control).toBeVisible()
  await control.click()
  const picker = page.locator(".vector-model-popover")
  const recent = picker.locator('[data-model-section="recent"]')
  await expect(recent).toContainText("Recently used")
  await expect(recent).toContainText("Sonnet (latest)")
  await expect(recent).not.toContainText("Claude Fable 5.1")

  // Picking it again is the way back to it, and the refusal the next poll still lists does not undo that pick.
  await picker.getByRole("menuitemradio", { name: "Claude Fable 5.1, Claude Code", exact: true }).click()
  const repicked = launcher.getByRole("button", { name: "Claude Code model: Claude Fable 5.1", exact: true })
  await expect(repicked).toBeVisible()

  await launcher.getByLabel("Agent instructions").fill("Tidy the search module.")
  await launcher.getByRole("button", { name: "Launch agent", exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const boundary = window as unknown as {
          api: { parallelWorkspaces: { recordedCreates: () => { runtime?: string; runtimeModel?: string }[] } }
        }
        return boundary.api.parallelWorkspaces.recordedCreates().map((input) => [input.runtime, input.runtimeModel])
      }),
    )
    .toEqual([["claude-code", "claude-fable-5-1"]])
})

// The agent launcher's coding agents live in Host locally: open it, open the agent, and use it for this launch.
async function chooseInHostLocally(page: Page, name: string) {
  await page.locator("[data-vector-host-locally-tile]").click()
  const host = page.getByRole("dialog", { name: "Coding agents" })
  await host.getByRole("button", { name: new RegExp(`^${name},`) }).click()
  await host.getByRole("button", { name: `Use ${name}`, exact: true }).click()
  await expect(host).toHaveCount(0)
}
