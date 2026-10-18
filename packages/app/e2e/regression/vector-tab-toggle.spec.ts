import { expect, test } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/VectorTabToggle"
const sessionID = "ses_vector_tab_toggle"

// Settings has no Editor page, so the editor's status bar is where Vector Tab is switched on and off.
test("Vector Tab keeps a saved off and switches from the editor's status bar", async ({ page }) => {
  await mockVectorServer(page, {
    directory,
    project: { id: "project-vector-tab", worktree: directory, vcs: "git", name: "Vector Tab" },
    provider: {
      all: [
        {
          id: "anthropic",
          name: "Anthropic",
          models: { tab: { id: "tab", name: "Tab", limit: { context: 200_000 } } },
        },
      ],
      connected: ["anthropic"],
      default: { providerID: "anthropic", modelID: "tab" },
    },
    sessions: [
      {
        id: sessionID,
        title: "Vector Tab toggle",
        directory,
        projectID: "project-vector-tab",
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    fileList: (path) =>
      path
        ? []
        : [{ name: "README.md", path: "README.md", absolute: `${directory}/README.md`, type: "file", ignored: false }],
    fileContent: (path) => ({ type: "text", content: path === "README.md" ? "# Vector Tab\n" : "" }),
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
    if (sessionStorage.getItem("seeded")) return
    sessionStorage.setItem("seeded", "1")
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({ general: { newLayoutDesigns: true }, editor: { aiAutocomplete: false } }),
    )
    localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
    localStorage.setItem(
      "vector.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: projectDirectory, expanded: true }] },
        lastProject: { local: projectDirectory },
      }),
    )
  }, directory)

  const editor = page.locator("[data-vector-codespace]")
  const toggle = editor.getByRole("button", { name: "Vector Tab", exact: true })
  const saved = () =>
    page.evaluate(
      () => JSON.parse(localStorage.getItem("settings.v3") ?? "{}").editor?.aiAutocomplete as boolean | undefined,
    )

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, "Vector Tab toggle")
  await page.locator("[data-vector-mode-switch]").getByRole("button", { name: "editor" }).click()
  await editor
    .getByRole("button", { name: /README\.md/ })
    .first()
    .click()
  await expect(editor.locator(".monaco-editor")).toBeVisible()
  // A saved off is honoured: suggestions spend the selected model's tokens.
  await expect(toggle).toHaveText("Vector Tab off")
  await expect(toggle).toHaveAttribute("aria-pressed", "false")

  await toggle.click()
  await expect(toggle).toHaveText("Vector Tab on")
  await expect(toggle).toHaveAttribute("aria-pressed", "true")
  await expect.poll(saved).toBe(true)

  await toggle.focus()
  await page.keyboard.press("Enter")
  await expect(toggle).toHaveText("Vector Tab off")
  await expect.poll(saved).toBe(false)

  // The editor comes back on its own after a reload; the file is opened again.
  await page.reload()
  await editor
    .getByRole("button", { name: /README\.md/ })
    .first()
    .click()
  await expect(editor.locator(".monaco-editor")).toBeVisible()
  await expect(toggle).toHaveText("Vector Tab off")
  await expect(toggle).toHaveAttribute("aria-pressed", "false")
})
