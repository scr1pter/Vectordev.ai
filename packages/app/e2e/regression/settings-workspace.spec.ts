import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/SettingsWorkspaceRegression"
const sessionID = "ses_settings_workspace_regression"

test("full-screen Settings is searchable and returns to the active task", async ({ page }, testInfo) => {
  await mockOpenCodeServer(page, {
    directory,
    project: { id: "project-settings-workspace", worktree: directory, vcs: "git", name: "Settings Workspace" },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: sessionID,
        title: "Settings workspace regression",
        directory,
        projectID: "project-settings-workspace",
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript((projectDirectory) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
    localStorage.setItem(
      "vector.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: projectDirectory, expanded: true }] },
        lastProject: { local: projectDirectory },
      }),
    )
  }, directory)

  const sessionPath = `/${base64Encode(directory)}/session/${sessionID}`
  await page.goto(sessionPath)
  await expectSessionTitle(page, "Settings workspace regression")
  await page.getByRole("button", { name: "Settings", exact: true }).click()

  const settings = page.locator(".settings-v2-workspace")
  await expect(settings).toBeVisible()
  await expect
    .poll(() =>
      settings.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return Math.max(
          Math.abs(bounds.x),
          Math.abs(bounds.y),
          Math.abs(bounds.width - window.innerWidth),
          Math.abs(bounds.height - window.innerHeight),
        )
      }),
    )
    .toBeLessThanOrEqual(1)
  await expect(settings.getByRole("tab", { name: "General", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(settings.getByRole("complementary", { name: "Settings categories" })).toBeVisible()

  const search = settings.getByRole("searchbox", { name: "Search settings" })
  await search.fill("memory")
  await expect(settings.getByRole("tab", { name: "Personalization", exact: true })).toBeVisible()
  await expect(settings.getByRole("tab", { name: "General", exact: true })).toBeVisible()
  await expect(settings.getByRole("tab", { name: "Appearance", exact: true })).toHaveCount(0)
  await settings.getByRole("tab", { name: "Personalization", exact: true }).click()
  await expect(settings.getByRole("tab", { name: "Personalization", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  )

  await search.fill("no-matching-vector-setting")
  await expect(settings.getByText("No settings found", { exact: true })).toBeVisible()
  await expect(settings.getByRole("tab")).toHaveCount(0)
  await settings.getByRole("button", { name: "Clear settings search" }).click()
  await expect(search).toHaveValue("")
  await expect(settings.getByRole("tab", { name: "Appearance", exact: true })).toBeVisible()

  await search.fill("update")
  await expect(settings.getByRole("tab")).toHaveCount(1)
  await settings.getByRole("tab", { name: "Updates & about", exact: true }).click()
  await expect(settings.getByRole("heading", { name: "Updates & about", exact: true })).toBeVisible()
  await expect(settings.getByRole("heading", { name: "Updates are managed by your deployment" })).toBeVisible()
  await expect(settings.locator(".settings-update-indicator")).toHaveAttribute("data-state", "web")
  await expect(settings.getByRole("button", { name: "Latest installers", exact: true })).toBeVisible()
  await expect(settings.getByRole("button", { name: "Release notes", exact: true })).toBeVisible()
  await expect(settings.getByRole("button", { name: "Latest installers", exact: true }).locator("use")).toHaveAttribute(
    "href",
    "#opencode-v2-icon-download",
  )
  await expect(settings.getByRole("button", { name: "Release notes", exact: true }).locator("use")).toHaveAttribute(
    "href",
    "#opencode-v2-icon-link",
  )
  await page.screenshot({ path: testInfo.outputPath("settings-updates.png") })

  await settings.getByRole("button", { name: "Back", exact: true }).click()
  await expect(settings).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`${sessionID}$`))
  await expectSessionTitle(page, "Settings workspace regression")
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible()
})
