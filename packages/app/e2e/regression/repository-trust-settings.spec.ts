import { expect, test } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const repository = "C:/Vector/TrustRepository"
// An agent workspace is its own folder, so the engine keeps a separate trust for it.
const workspace = "C:/Vector/.vector/workspaces/agent-1/TrustRepository"
const parentID = "ses_trust_settings_parent"
const agentID = "ses_trust_settings_agent"

test("Repository trust checks the folder an agent workspace session runs in, then its repository", async ({ page }) => {
  await mockVectorServer(page, {
    directory: repository,
    project: { id: "project-trust-settings", worktree: repository, vcs: "git", name: "Trust Repository" },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: parentID,
        title: "Repository task",
        directory: repository,
        projectID: "project-trust-settings",
        time: { created: 1, updated: 1 },
      },
      {
        id: agentID,
        title: "Agent workspace task",
        directory: workspace,
        projectID: "project-trust-settings",
        time: { created: 2, updated: 2 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  // The repository was trusted earlier; the agent workspace never was, and holds back the user's own tools.
  const statuses: Record<string, { trusted: boolean; ignored: boolean; settings: boolean }> = {
    [repository]: { trusted: true, ignored: false, settings: true },
    [workspace]: { trusted: false, ignored: true, settings: false },
  }
  const approvals: string[] = []
  await page.route(
    (url) => url.pathname === "/config/trust",
    (route) => {
      const url = new URL(route.request().url())
      const directory =
        url.searchParams.get("directory") ?? decodeURIComponent(route.request().headers()["x-vector-directory"] ?? "")
      if (route.request().method() === "POST") {
        approvals.push(directory)
        statuses[directory] = { ...statuses[directory]!, trusted: true, ignored: false }
      }
      return route.fulfill({ json: { workspace: directory, ...statuses[directory] } })
    },
  )
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
  }, repository)

  // How the app opens an agent workspace's session: its own folder, scoped to the task in the repository it came from.
  const server = base64Encode(`http://127.0.0.1:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`)
  await page.goto(
    `/server/${server}/session/${agentID}?project=${encodeURIComponent(repository)}&parentSession=${parentID}`,
  )
  await expectSessionTitle(page, "Agent workspace task")
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-workspace")
  await settings.getByRole("tab", { name: "Repository trust", exact: true }).click()

  const cards = settings.locator('[data-component="settings-project-trust"]')
  await expect(cards).toHaveCount(2)
  await expect(cards.nth(0)).toContainText("This session's folder")
  await expect(cards.nth(0)).toContainText(workspace)
  await expect(cards.nth(0)).toContainText("Not trusted")
  await expect(cards.nth(1)).toContainText("Repository")
  await expect(cards.nth(1)).toContainText(repository)
  await expect(cards.nth(1)).toContainText("Trusted")

  await cards.nth(0).getByRole("button", { name: "Trust this repository" }).click()
  await expect(cards.nth(0)).toContainText("Trusted")
  expect(approvals).toEqual([workspace])
})
