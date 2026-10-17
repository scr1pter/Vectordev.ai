import { expect, test } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/SettingsServerMenu"
const sessionID = "ses_settings_server_menu"
const project = { id: "project-settings-server-menu", worktree: directory, vcs: "git", name: "Server menu" }
const second = "127.0.0.1:4197"

test("a server's menu in full-screen Settings opens above Settings and deletes the server", async ({ page }) => {
  await mockVectorServer(page, {
    directory,
    project,
    provider: { all: [], connected: [], default: {} },
    sessions: [{ id: sessionID, title: "Server menu regression", directory, projectID: project.id, time: { created: 1, updated: 1 } }],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    (setup) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
      localStorage.setItem(
        "vector.global.dat:server",
        JSON.stringify({
          list: [`http://${setup.second}`],
          projects: { local: [{ worktree: setup.directory, expanded: true }] },
          lastProject: { local: setup.directory },
        }),
      )
    },
    { directory, second },
  )

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, "Server menu regression")
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-workspace")
  await settings.getByRole("tab", { name: "Environment & servers", exact: true }).click()
  const row = settings.locator(".settings-v2-servers-row").filter({ hasText: second })
  await expect(row).toBeVisible()

  await row.getByRole("button", { name: "More options" }).click()
  const remove = page.getByRole("menuitem", { name: "Delete" })
  await expect(remove).toBeVisible()
  expect(
    await remove.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2))
    }),
  ).toBe(true)
  await remove.click()
  await expect(row).toHaveCount(0)
})
