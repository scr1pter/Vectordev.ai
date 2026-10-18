import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/ComposerHandoff"
const sessionID = "ses_composer_handoff"
const title = "Tidy the review panel"
const ask = "Fix the finding in src/review.ts"

test("the task on screen takes a handed-over prompt and sends it, but never over an unsent draft", async ({ page }) => {
  const prompts = await setup(page)
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  const composer = page.locator('[data-component="prompt-input"]').filter({ visible: true }).first()
  await expect(composer).toBeVisible()

  // Taken here, the caller ("Ask the agent", say) starts no new task.
  expect(await handOff(page, { text: ask, send: true })).toBe(true)
  await expect.poll(() => prompts.length).toBe(1)
  expect(JSON.stringify(prompts[0])).toContain(ask)

  await composer.click()
  await page.keyboard.type("half-written")
  expect(await handOff(page, { text: ask, send: true })).toBe(false)
  await expect(composer).toContainText("half-written")
  expect(prompts).toHaveLength(1)
})

test("the new-task composer takes a handed-over prompt", async ({ page }) => {
  await setup(page)
  await page.goto(`/${base64Encode(directory)}/session`)
  await expect(page).toHaveURL(/\/new-session\?draftId=/)
  const composer = page.locator('[data-component="prompt-input"]').filter({ visible: true }).first()
  await expect(composer).toBeVisible({ timeout: 30_000 })

  expect(await handOff(page, { text: ask, send: false })).toBe(true)
  await expect(composer).toContainText(ask)
})

// Calls the app's own hand-off module, served by the dev server, so the request is exactly what a caller sends.
function handOff(page: Page, request: { text: string; send: boolean }) {
  return page.evaluate(
    async (input) => {
      const handoff: { requestComposerPrompt: (request: { text: string; send: boolean }) => boolean } = await import(
        input.module
      )
      return handoff.requestComposerPrompt(input.request)
    },
    { module: "/src/utils/composer-handoff.ts", request },
  )
}

async function setup(page: Page) {
  const prompts: unknown[] = []
  await mockVectorServer(page, {
    directory,
    project: { id: "project-composer-handoff", worktree: directory, vcs: "git", name: "Composer Handoff" },
    // A send goes through the composer's own submission, which needs a model.
    provider: {
      all: [
        {
          id: "anthropic",
          name: "Anthropic",
          source: "api",
          models: {
            "maker/text": {
              id: "maker/text",
              name: "Maker Text",
              providerID: "anthropic",
              limit: { context: 128000, output: 8000 },
              cost: { input: 1, output: 2, cache: { read: 0.1, write: 1.25 } },
              variants: {},
              capabilities: { toolcall: true, input: { text: true, image: false }, output: { text: true } },
              modalities: { input: ["text"], output: ["text"] },
              tool_call: true,
            },
          },
        },
      ],
      connected: ["anthropic"],
      default: { anthropic: "maker/text" },
    },
    sessions: [
      {
        id: sessionID,
        title,
        directory,
        projectID: "project-composer-handoff",
        time: { created: 1, updated: 1 },
      },
    ],
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
  return prompts
}
