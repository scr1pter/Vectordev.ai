import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/NoGlobalTabs"
const sessionID = "ses_no_global_tabs"

test("the redesigned workspace never renders the retired global session strip", async ({ page }, testInfo) => {
  await mockOpenCodeServer(page, {
    directory,
    project: { id: "project-no-global-tabs", worktree: directory, vcs: "git", name: "No Global Tabs" },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: sessionID,
        title: "No global tabs regression",
        directory,
        projectID: "project-no-global-tabs",
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ projectDirectory, session }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
      localStorage.setItem(
        "vector.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: projectDirectory, expanded: true }] },
          lastProject: { local: projectDirectory },
        }),
      )
      localStorage.setItem(
        "vector.window.browser.dat:tabs",
        JSON.stringify([{ type: "session", server: "local", sessionId: session }]),
      )
    },
    { projectDirectory: directory, session: sessionID },
  )

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, "No global tabs regression")
  await expect(page.locator("[data-vector-shell]")).toBeVisible()
  await expect(page.locator('[data-slot="titlebar-tabs"], [data-titlebar-tab-slot]')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath("workspace-without-global-tabs.png") })
})
