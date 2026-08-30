import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/AgentLauncherRegression"
const sessionID = "ses_agent_launcher_regression"

test("the project launcher is a single accessible Vector creation sheet", async ({ page }, testInfo) => {
  await mockOpenCodeServer(page, {
    directory,
    project: { id: "project-agent-launcher", worktree: directory, vcs: "git", name: "Agent Launcher" },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "launcher-model": {
              id: "launcher-model",
              name: "Launcher Model",
              limit: { context: 200_000 },
            },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "launcher-model" },
    },
    sessions: [
      {
        id: sessionID,
        title: "Agent launcher regression",
        directory,
        projectID: "project-agent-launcher",
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript((projectDirectory) => {
    localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: projectDirectory, expanded: true }] },
        lastProject: { local: projectDirectory },
      }),
    )
  }, directory)

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, "Agent launcher regression")
  await expect(page.locator('[data-slot="titlebar-tabs"]')).toHaveCount(0)

  const create = page.getByRole("button", { name: "New workspace", exact: true })
  await expect(create).toHaveCount(1)
  await expect(page.getByRole("button", { name: "Coordinate agents", exact: true })).toHaveCount(0)
  await create.click()

  const launcher = page.getByRole("dialog", { name: "New isolated agent" })
  await expect(launcher).toBeVisible()
  await expect(launcher).toHaveAttribute("aria-modal", "true")
  await expect(launcher.getByRole("button", { name: "One agent" })).toHaveAttribute("aria-pressed", "true")
  await expect(launcher.getByRole("button", { name: "Vector" })).toHaveAttribute("aria-pressed", "true")
  await expect(launcher.getByLabel("Agent instructions")).toBeFocused()

  const appearance = await launcher.evaluate((element) => {
    const style = getComputedStyle(element)
    const field = element.querySelector<HTMLInputElement>("#vector-agent-workspace-name")
    const prompt = element.querySelector<HTMLTextAreaElement>(".vx-launcher__prompt")
    const label = element.querySelector<HTMLElement>(".vx-launcher__section-label")
    return {
      background: style.backgroundImage,
      border: field ? getComputedStyle(field).borderTopStyle : "",
      promptBorder: prompt ? getComputedStyle(prompt).borderTopStyle : "",
      promptOutline: prompt ? getComputedStyle(prompt).outlineStyle : "",
      labelTransform: label ? getComputedStyle(label).textTransform : "",
    }
  })
  expect(appearance.background).toContain("gradient")
  expect(appearance.border).toBe("none")
  expect(appearance.promptBorder).toBe("none")
  expect(appearance.promptOutline).toBe("none")
  expect(appearance.labelTransform).toBe("none")

  await launcher.screenshot({ path: testInfo.outputPath("agent-launcher.png") })
  await page.keyboard.press("Escape")
  await expect(launcher).not.toBeVisible()
  await expect(create).toBeFocused()
})
