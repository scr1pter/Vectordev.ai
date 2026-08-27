import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/Vector/CanvasProviderRegression"
const sessionID = "ses_canvas_provider_regression"

test("Canvas code editor opens a file with its prompt contexts mounted", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))

  await mockOpenCodeServer(page, {
    directory,
    project: { id: "project-canvas-provider", worktree: directory, vcs: "git", name: "Canvas Provider" },
    provider: {},
    sessions: [
      {
        id: sessionID,
        title: "Canvas provider regression",
        directory,
        projectID: "project-canvas-provider",
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    fileList: (path) =>
      path
        ? []
        : [
            {
              name: "README.md",
              path: "README.md",
              absolute: `${directory}/README.md`,
              type: "file",
              ignored: false,
            },
          ],
    fileContent: (path) => ({ type: "text", content: path === "README.md" ? "# Vector Canvas\n" : "" }),
  })
  await page.route("**/lsp/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: "[]",
    }),
  )
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
  await expect(page.getByText("Canvas provider regression", { exact: true }).first()).toBeVisible()
  await page.locator("button[data-vector-nav-item]").filter({ hasText: /^Canvas$/ }).first().click()
  await expect(page.locator(".vcanvas-brand")).toHaveText("Vector Canvas")

  await page.getByRole("button", { name: "Add window" }).click()
  await page.locator(".vcanvas-launcher-item").filter({ hasText: /Code editor/ }).click()
  const readme = page.getByRole("button", { name: /README\.md/ })
  await expect(readme).toBeVisible()
  await readme.click()
  await expect(page.locator(".monaco-editor")).toBeVisible()

  expect(errors).toEqual([])
})
