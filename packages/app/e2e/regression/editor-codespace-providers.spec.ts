import { expect, test } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/EditorProviderRegression"
const sessionID = "ses_editor_provider_regression"

test("Editor opens a project file beside the active Vector Agent", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))

  await mockVectorServer(page, {
    directory,
    project: { id: "project-editor-provider", worktree: directory, vcs: "git", name: "Editor Provider" },
    provider: {
      all: [
        {
          id: "anthropic",
          name: "Anthropic",
          models: {
            "editor-model": {
              id: "editor-model",
              name: "Editor Model",
              limit: { context: 200_000 },
            },
          },
        },
      ],
      connected: ["anthropic"],
      default: { providerID: "anthropic", modelID: "editor-model" },
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
      "vector.global.dat:server",
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

  // Inline edits use a hidden text helper. It must not be able to edit files with apply_patch/bash or strand a
  // permission/question request in a conversation the user cannot open.
  const helper: { created?: Record<string, unknown>; prompted?: Record<string, unknown> } = {}
  await page.route(/\/session(?:\?|$)/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    helper.created = route.request().postDataJSON()
    await route.fulfill({ json: { id: "ses_inline_helper", ...helper.created } })
  })
  await page.route(/\/session\/ses_inline_helper\/message(?:\?|$)/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    helper.prompted = route.request().postDataJSON()
    await route.fulfill({ json: { parts: [{ type: "text", text: "# Updated Vector Editor\n" }] } })
  })
  await editor.locator(".monaco-editor").click()
  // Monaco chooses its modifier from the browser user agent (the Desktop Chrome fixture emulates Windows).
  const modifier = await page.evaluate(() => (/Macintosh/.test(navigator.userAgent) ? "Meta" : "Control"))
  await page.keyboard.press(`${modifier}+k`)
  const instruction = editor.getByPlaceholder(/Describe how to change/)
  await expect(instruction).toBeVisible()
  await instruction.fill("Update the heading")
  await instruction.press("Enter")
  await expect.poll(() => helper.prompted).toBeDefined()
  expect(helper.created).toMatchObject({ internal: "codespace.edit", parentID: sessionID })
  expect(helper.prompted?.tools).toEqual({ "*": false })
  await expect(editor.locator(".monaco-editor .view-lines")).toContainText("Updated Vector Editor")

  expect(errors).toEqual([])
})
