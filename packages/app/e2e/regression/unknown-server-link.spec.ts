import { expect, test } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/UnknownServerLink"
const sessionID = "ses_unknown_server_link"
const project = { id: "project-unknown-server-link", worktree: directory, vcs: "git", name: "Unknown server link" }

test("a link to a session on a server outside the list, followed from an open session, says so", async ({ page }) => {
  await mockVectorServer(page, {
    directory,
    project,
    provider: { all: [], connected: [], default: {} },
    sessions: [{ id: sessionID, title: "Unknown server link", directory, projectID: project.id, time: { created: 1, updated: 1 } }],
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

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, "Unknown server link")

  // In-app navigation, as a clicked link or Back/Forward would do. The tab bar and the tab store used to
  // re-add and drop a tab for the unknown server forever, so the page never answered again.
  const link = `/server/${base64Encode("http://203.0.113.9:4096")}/session/ses_elsewhere`
  const answered = await Promise.race([
    page.evaluate((next) => {
      history.pushState({}, "", next)
      dispatchEvent(new PopStateEvent("popstate"))
      return new Promise<string>((resolve) => setTimeout(() => resolve("answered"), 250))
    }, link),
    new Promise<string>((resolve) => setTimeout(() => resolve("frozen"), 10_000)),
  ])
  expect(answered).toBe("answered")
  await expect(page.getByText("not in your server list", { exact: false })).toBeVisible()
  expect(await page.evaluate(() => "still responsive")).toBe("still responsive")
})
