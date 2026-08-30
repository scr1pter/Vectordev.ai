import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/EditorProviderRegression"
const sessionID = "ses_editor_provider_regression"

test("Editor opens a project file beside the active Vector Agent", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))

  await mockOpenCodeServer(page, {
    directory,
    project: { id: "project-editor-provider", worktree: directory, vcs: "git", name: "Editor Provider" },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "editor-model": {
              id: "editor-model",
              name: "Editor Model",
              limit: { context: 200_000 },
            },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "editor-model" },
    },
    sessions: [
      {
        id: sessionID,
        title: "Editor provider regression",
        directory,
        projectID: "project-editor-provider",
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
    fileContent: (path) => ({ type: "text", content: path === "README.md" ? "# Vector Editor\n" : "" }),
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
  await expectSessionTitle(page, "Editor provider regression")
  await page.locator("[data-vector-mode-switch]").getByRole("button", { name: "editor" }).click()

  const editor = page.locator("[data-vector-codespace]")
  await expect(editor).toBeVisible()
  await expect(editor.getByRole("button", { name: "Editor", exact: true })).toHaveAttribute("aria-pressed", "true")
  const readme = editor.getByRole("button", { name: /README\.md/ }).first()
  await expect(readme).toBeVisible()
  await readme.click()
  await expect(editor.locator(".monaco-editor")).toBeVisible()
  await expect(editor.getByText("Vector Agent", { exact: true })).toBeVisible()
  const agentComposer = editor.locator(".vector-editor-agent-composer")
  await expect(agentComposer).toBeVisible()
  const inheritedControls = agentComposer.locator(
    '[data-component="prompt-agent-control"], [data-component="prompt-model-control"], [data-action="prompt-mode"], [data-component="prompt-variant-control"], [data-action="prompt-execution-mode"]',
  )
  expect(await inheritedControls.count()).toBeGreaterThan(0)
  for (const control of await inheritedControls.all()) await expect(control).toBeHidden()

  expect(errors).toEqual([])
})
