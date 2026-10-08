import { expect, test } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/VectorscopeStable"
const first = "ses_vectorscope_stable_one"
const second = "ses_vectorscope_stable_two"

// The panel's project path is re-derived whenever the app's routing or workspace state is rebuilt, which happens
// every few seconds. Only a real change of project may reload it; reloading on every rebuild refetched GitHub
// constantly and made the panel flicker.
test("Vectorscope loads pull requests once while the app changes around it in the same project", async ({ page }) => {
  await mockVectorServer(page, {
    directory,
    project: { id: "project-vectorscope-stable", worktree: directory, vcs: "git", name: "Vectorscope" },
    provider: { all: [], connected: [], default: {} },
    sessions: [first, second].map((id, index) => ({
      id,
      title: `Stable session ${index + 1}`,
      directory,
      projectID: "project-vectorscope-stable",
      time: { created: index + 1, updated: index + 1 },
    })),
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
    const calls = { list: 0 }
    Object.defineProperty(window, "__vectorscopeCalls", { value: calls })
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        pullRequests: {
          status: async () => ({ authenticated: true, configured: true, login: "mira", source: "vector", detail: "" }),
          list: async () => {
            calls.list += 1
            return [
              {
                number: 7,
                title: "Keep the review pinned to its commit",
                author: "mira",
                state: "OPEN",
                isDraft: true,
                baseRefName: "main",
                headRefName: "pin-review",
                additions: 12,
                deletions: 3,
                changedFiles: 2,
                url: "https://github.com/acme/app/pull/7",
                updatedAt: "2026-10-08T10:00:00Z",
              },
            ]
          },
        },
        ci: { runs: async () => ({ ok: true, runs: [] }) },
      },
    })
  }, directory)

  await page.goto(`/${base64Encode(directory)}/session/${first}`)
  await expectSessionTitle(page, "Stable session 1")
  await page.locator('[data-tour="nav-pull-requests"]').click()
  const panel = page.getByRole("dialog", { name: "Vectorscope" })
  await expect(panel.getByText("Keep the review pinned to its commit")).toBeVisible()
  const calls = () =>
    page.evaluate(() => (window as unknown as { __vectorscopeCalls: { list: number } }).__vectorscopeCalls.list)
  expect(await calls()).toBe(1)

  // Another session of the same project, behind the open panel.
  await page.evaluate(
    (path) => {
      history.pushState(null, "", path)
      dispatchEvent(new PopStateEvent("popstate"))
    },
    `/${base64Encode(directory)}/session/${second}`,
  )
  await page.waitForTimeout(1_500)
  expect(await calls()).toBe(1)
  await expect(panel.getByRole("button", { name: "New pull request" })).toBeEnabled()
})
