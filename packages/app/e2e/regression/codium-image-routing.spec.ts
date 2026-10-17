import { expect, test } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/CodiumImageRouting"
const sessionID = "ses_codium_image_routing"
const project = { id: "project-codium-image-routing", worktree: directory, vcs: "git", name: "Codium image routing" }

const model = (id: string, name: string, providerID: string, image: boolean) => ({
  id,
  name,
  providerID,
  limit: { context: 128000, output: 8000 },
  cost: { input: 1, output: 2, cache: { read: 0.1, write: 1.25 } },
  variants: {},
  capabilities: { toolcall: true, input: { text: true, image }, output: { text: true } },
  modalities: { input: image ? ["text", "image"] : ["text"], output: ["text"] },
  tool_call: true,
})

test("an attached image never moves the prompt onto Vector Codium", async ({ page }) => {
  const prompts: unknown[] = []
  await mockVectorServer(page, {
    directory,
    project,
    provider: {
      all: [
        { id: "anthropic", name: "Anthropic", source: "api", models: { "maker/text": model("maker/text", "Maker Text", "anthropic", false) } },
        {
          id: "vector-plan",
          name: "Vector Codium",
          source: "custom",
          models: { "codium/vision": model("codium/vision", "Codium Vision", "vector-plan", true) },
        },
      ],
      connected: ["anthropic", "vector-plan"],
      default: { anthropic: "maker/text", "vector-plan": "codium/vision" },
    },
    sessions: [{ id: sessionID, title: "Codium image routing", directory, projectID: project.id, time: { created: 1, updated: 1 } }],
    pageMessages: () => ({ items: [] }),
  })
  await page.route(/\/session\/[^/]+\/prompt_async(?:\?|$)/, (route) => {
    prompts.push(route.request().postDataJSON())
    return route.fulfill({ status: 204, body: "" })
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
  await expectSessionTitle(page, "Codium image routing")
  const picker = page.locator('[data-action="prompt-model"]').filter({ visible: true }).first()
  await expect(picker).toContainText("Maker Text")

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  )
  await page.locator('input[type="file"]').first().setInputFiles({ name: "screen.png", mimeType: "image/png", buffer: png })
  await page.locator('[data-component="prompt-input"]').filter({ visible: true }).first().click()
  await page.keyboard.type("What is wrong in this screenshot?")
  await page.keyboard.press("Enter")

  await expect(page.getByText("Vector never switches to Vector Codium on its own", { exact: false })).toBeVisible()
  await page.waitForTimeout(500)
  expect(prompts).toEqual([])
  await expect(picker).toContainText("Maker Text")
})
