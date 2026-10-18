import { expect, test } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/SettingsWorkspaceRegression"
const sessionID = "ses_settings_workspace_regression"

test("full-screen Settings is searchable and returns to the active task", async ({ page }, testInfo) => {
  await mockVectorServer(page, {
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
  // Project rules, Appearance, Editor, Chat, Voice and Personalization are gone; Local memory stays in General.
  for (const removed of ["Project rules", "Appearance", "Editor", "Chat", "Voice", "Personalization"])
    await expect(settings.getByRole("tab", { name: removed, exact: true })).toHaveCount(0)
  await search.fill("memory")
  await expect(settings.getByRole("tab", { name: "General", exact: true })).toBeVisible()
  await expect(settings.getByRole("tab", { name: "Notifications", exact: true })).toHaveCount(0)
  await search.fill("notifications")
  await settings.getByRole("tab", { name: "Notifications", exact: true }).click()
  await expect(settings.getByRole("tab", { name: "Notifications", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  )

  await search.fill("no-matching-vector-setting")
  await expect(settings.getByText("No settings found", { exact: true })).toBeVisible()
  await expect(settings.getByRole("tab")).toHaveCount(0)
  await settings.getByRole("button", { name: "Clear settings search" }).click()
  await expect(search).toHaveValue("")
  await expect(settings.getByRole("tab", { name: "Accessibility", exact: true })).toBeVisible()

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
    "#vector-v2-icon-download",
  )
  await expect(settings.getByRole("button", { name: "Release notes", exact: true }).locator("use")).toHaveAttribute(
    "href",
    "#vector-v2-icon-link",
  )
  await page.screenshot({ path: testInfo.outputPath("settings-updates.png") })

  await settings.getByRole("button", { name: "Back", exact: true }).click()
  await expect(settings).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`${sessionID}$`))
  await expectSessionTitle(page, "Settings workspace regression")
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible()
  // The web build has no updater, so the gear is never replaced by Update.
  await expect(page.locator("[data-vector-update]")).toHaveCount(0)

  // Cmd+, opens Settings on a task route, on Home, and on the task again after Home (Home's own copy of the command
  // once outlived the page and swallowed the shortcut). The app picks Cmd or Ctrl from navigator.platform, which the
  // Desktop Chrome fixture may emulate as Windows.
  const shortcut = await page.evaluate(() =>
    /(Mac|iPod|iPhone|iPad)/.test(navigator.platform) ? "Meta+Comma" : "Control+Comma",
  )
  // Shortcuts wait while a dialog is still closing, so press until Settings opens.
  const openSettingsByKey = () =>
    expect(async () => {
      await page.keyboard.press(shortcut)
      await expect(settings).toBeVisible({ timeout: 1_000 })
    }).toPass()
  await openSettingsByKey()
  await settings.getByRole("button", { name: "Back", exact: true }).click()
  await expect(settings).toHaveCount(0)
  await page.locator("[data-vector-nav-home]").click()
  await expect(page).toHaveURL(/\/$/)
  await openSettingsByKey()
  await settings.getByRole("button", { name: "Back", exact: true }).click()
  await page.goBack()
  await expectSessionTitle(page, "Settings workspace regression")
  await openSettingsByKey()
})
