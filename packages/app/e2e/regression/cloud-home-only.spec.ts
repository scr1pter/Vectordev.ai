import { expect, test } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/CloudHomeOnly"
const sessionID = "ses_cloud_home_only"

test("Vector Cloud opens from Home, and a task's view has no Cloud controls", async ({ page }, testInfo) => {
  await mockVectorServer(page, {
    directory,
    project: { id: "project-cloud-home-only", worktree: directory, vcs: "git", name: "Cloud Home Only" },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: sessionID,
        title: "Add sign-in with a users table",
        directory,
        projectID: "project-cloud-home-only",
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript((projectDirectory) => {
    // The desktop's Cloud bridge, which every task view used to read for its Cloud button.
    Object.assign(window, {
      api: {
        cloud: {
          overview: async (path: string) => ({
            projectPath: path,
            directory: path,
            hosting: { provider: "Vercel", connected: false },
            database: { provider: "Supabase", accountConnected: false, connected: false },
          }),
          onChange: () => () => undefined,
        },
      },
    })
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

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, "Add sign-in with a users table")
  const controls = page.locator("[data-vector-session-controls]")
  await expect(controls).toBeVisible()
  await expect(controls.getByRole("button", { name: /Vector Cloud/ })).toHaveCount(0)
  await expect(page.locator("[data-vector-cloud-card]")).toHaveCount(0)
  await expect(page.getByText("This looks like it needs a database")).toHaveCount(0)
  await expect(page.locator("#vector-launch")).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath("task-view.png") })

  await page.goto("/")
  const cloud = page.getByRole("button", { name: "Vector Cloud", exact: true })
  await expect(cloud).toBeVisible()
  await cloud.click()
  await expect(page).toHaveURL(/\/cloud/)
  await expect(page.locator("[data-vector-cloud-home]")).toBeVisible()
  await expect(page.locator("#vector-launch")).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath("cloud-from-home.png") })
})
