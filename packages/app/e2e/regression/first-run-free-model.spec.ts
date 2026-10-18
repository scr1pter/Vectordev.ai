import { expect, test, type Page } from "@playwright/test"
import { mockVectorServer } from "../utils/mock-server"

const directory = "C:/Vector/FirstRun"
const draftID = "draft_first_run"
const draft = "Summarize this repository without changing files"

function catalog(connected: boolean) {
  const models = {
    "maker/coder:free": { name: "Maker Coder:free", context: 128_000, free: true },
    "maker/big:free": { name: "Maker Big:free", context: 256_000, free: true },
    // Larger and the account default, so choosing it would mean the free path fell back to paid.
    "maker/giant": { name: "Paid Giant", context: 1_000_000, free: false },
  }
  return {
    all: [
      {
        id: "openrouter",
        name: "OpenRouter",
        source: "api",
        models: Object.fromEntries(
          Object.entries(models).map(([id, model]) => [
            id,
            {
              id,
              providerID: "openrouter",
              name: model.name,
              limit: { context: model.context },
              cost: model.free ? { input: 0, output: 0 } : { input: 10, output: 30 },
              variants: {},
              ...(connected && model.free ? { freeModel: { source: "openrouter" } } : {}),
            },
          ]),
        ),
      },
    ],
    connected: connected ? ["openrouter"] : [],
    default: { openrouter: "maker/giant" },
  }
}

/**
 * A fresh profile with no provider, optionally with one repository draft open. OpenRouter's PKCE routes are mocked
 * only so a test can show the first run never starts them.
 */
async function setup(page: Page, input: { draft: boolean }) {
  const state = { connected: false, methods: [] as number[], prompts: [] as string[] }
  const callback = Promise.withResolvers<void>()
  await mockVectorServer(page, {
    directory,
    project: {
      id: "proj_first_run",
      worktree: directory,
      vcs: "git",
      name: "first-run",
      time: { created: 1, updated: 1 },
      sandboxes: [],
    },
    provider: catalog(false),
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  await page.route(/\/provider(?:\?|$)/, (route) => route.fulfill({ json: catalog(state.connected) }))
  await page.route("**/provider/auth*", (route) =>
    route.fulfill({
      json: {
        openrouter: [
          { type: "oauth", label: "Connect OpenRouter" },
          { type: "api", label: "Enter an OpenRouter API key" },
        ],
      },
    }),
  )
  await page.context().route("**/oauth-test", (route) => route.fulfill({ body: "Synthetic OpenRouter sign-in" }))
  await page.route("**/provider/openrouter/oauth/authorize*", (route) => {
    state.methods.push(route.request().postDataJSON().method)
    return route.fulfill({
      json: {
        method: "auto",
        url: `${new URL(page.url()).origin}/oauth-test`,
        instructions: "Finish in your browser.",
      },
    })
  })
  await page.route("**/provider/openrouter/oauth/callback*", async (route) => {
    await callback.promise
    state.connected = true
    return route.fulfill({ json: true })
  })
  await page.route("**/global/dispose*", (route) => route.fulfill({ json: true }))
  page.on("request", (request) => {
    if (request.method() !== "POST") return
    if (/\/session(?:\/[^/]+\/(?:message|prompt_async))?$/.test(new URL(request.url()).pathname))
      state.prompts.push(request.url())
  })
  if (!input.draft) return { state, authorize: () => callback.resolve() }
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  await page.addInitScript(
    (tab) => {
      localStorage.setItem(
        "vector.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: tab.directory, expanded: true }] },
          lastProject: { local: tab.directory },
        }),
      )
      localStorage.setItem(
        "vector.window.browser.dat:tabs",
        JSON.stringify([{ type: "draft", draftID: tab.draftID, server: tab.server, directory: tab.directory }]),
      )
    },
    { directory, draftID, server },
  )
  return { state, authorize: () => callback.resolve() }
}

// The owner's decision of 17 October 2026: free models run on Vector's shared allowance for every signed-in Vector
// account, so the first-run card and checklist offer signing in to Vector, never connecting an OpenRouter account. This
// web build has no desktop account bridge, so signing in itself is not offered here; a key the user has is.
test("fresh profile is told to sign in to Vector for free models and keeps the draft ready to send", async ({
  page,
}) => {
  const { state } = await setup(page, { draft: true })
  await page.goto(`/new-session?draftId=${draftID}`)

  const card = page.locator('[data-component="free-model-start"]')
  await expect(card).toBeVisible()
  await expect(card).toContainText("Choose a model to start")
  await expect(card).toContainText("Sign in to Vector to use free models.")
  await expect(card).toContainText("Vector's shared allowance")
  await expect(card).not.toContainText("OpenRouter")
  await expect(card.getByRole("button", { name: "Start free with OpenRouter" })).toHaveCount(0)
  const ownKey = card.getByRole("button", { name: "Use my own API key" })
  await page.screenshot({ path: test.info().outputPath("01-composer-no-model.png"), animations: "disabled" })

  await ownKey.click()
  await expect(page.getByPlaceholder("Search providers")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByPlaceholder("Search providers")).toHaveCount(0)

  const editor = page.locator('[data-component="prompt-input"]').filter({ visible: true }).first()
  await editor.click()
  await page.keyboard.type(draft)
  await page.keyboard.press("Enter")
  await expect(page.getByText("Connect a model to send this prompt", { exact: true })).toBeVisible()
  await expect(
    page.getByText("Sign in to Vector to use free models, or use an API key you already have."),
  ).toBeVisible()
  await expect(ownKey).toBeFocused()
  await expect(editor).toHaveText(draft)
  expect(state.prompts).toEqual([])
  expect(state.methods).toEqual([])
  await page.screenshot({ path: test.info().outputPath("02-send-without-model.png"), animations: "disabled" })
})

test("the first-run checklist offers signing in to Vector for free models, never OpenRouter", async ({ page }) => {
  const { state } = await setup(page, { draft: false })
  await page.goto("/")
  const checklist = page.getByRole("heading", { name: /first steps/i })
  await expect(checklist).toBeVisible()
  await expect(checklist).toContainText("0 of 3")
  await expect(page.getByText("Sign in to Vector to use free models", { exact: false })).toBeVisible()
  await expect(page.getByText("Start free with your own OpenRouter account", { exact: false })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Start free →" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Use my own API key" })).toBeVisible()
  expect(state.methods).toEqual([])
  await page.screenshot({ path: test.info().outputPath("05-checklist-start-free.png"), animations: "disabled" })
})
