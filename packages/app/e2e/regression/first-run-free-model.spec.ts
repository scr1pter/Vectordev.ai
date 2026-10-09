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
 * A fresh profile with no provider, optionally with one project draft open. OpenRouter's PKCE
 * callback completes only when `authorize()` is called.
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

async function signInOnOpenRouter(page: Page, start: () => Promise<void>, authorize: () => void) {
  const popup = page.waitForEvent("popup")
  await start()
  const signIn = await popup
  await expect(signIn.getByText("Synthetic OpenRouter sign-in")).toBeVisible()
  await signIn.close()
  await page.bringToFront()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText("Finish in your browser: sign in to OpenRouter and approve Vector.")
  await expect(dialog).toContainText("No payment or credits needed.")
  await expect(dialog.getByRole("textbox")).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath("03-openrouter-waiting.png"), animations: "disabled" })
  authorize()
  await expect(dialog).toHaveCount(0)
}

test("fresh profile starts free from the composer and keeps the draft ready to send", async ({ page }) => {
  const { state, authorize } = await setup(page, { draft: true })
  await page.goto(`/new-session?draftId=${draftID}`)

  const card = page.locator('[data-component="free-model-start"]')
  await expect(card).toBeVisible()
  await expect(card).toContainText("Connect a model to start")
  await expect(card).toContainText("No payment or credits needed")
  await expect(card).toContainText("OpenRouter and its model providers process your prompts.")
  const start = card.getByRole("button", { name: "Start free with OpenRouter" })
  await page.screenshot({ path: test.info().outputPath("01-composer-no-model.png"), animations: "disabled" })

  await card.getByRole("button", { name: "Use my own API key" }).click()
  await expect(page.getByPlaceholder("Search providers")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByPlaceholder("Search providers")).toHaveCount(0)

  const editor = page.locator('[data-component="prompt-input"]').filter({ visible: true }).first()
  await editor.click()
  await page.keyboard.type(draft)
  await page.keyboard.press("Enter")
  await expect(page.getByText("Connect a model to send this prompt", { exact: true })).toBeVisible()
  await expect(start).toBeFocused()
  await expect(editor).toHaveText(draft)
  await page.screenshot({ path: test.info().outputPath("02-send-without-model.png"), animations: "disabled" })

  await signInOnOpenRouter(page, () => start.click(), authorize)
  expect(state.methods).toEqual([0])

  await expect(card).toHaveCount(0)
  const picker = page.locator('[data-action="prompt-model"]').filter({ visible: true }).first()
  await expect(picker).toContainText("Maker Big")
  await expect(picker).not.toContainText("Paid Giant")
  await expect(page.getByText("Maker Big is selected. Your prompt is ready to send.", { exact: true })).toBeVisible()
  await expect(editor).toBeFocused()
  await expect(editor).toHaveText(draft)
  expect(state.prompts).toEqual([])
  await page.screenshot({ path: test.info().outputPath("04-composer-ready.png"), animations: "disabled" })
})

test("the first-run checklist starts free and returns to the next step", async ({ page }) => {
  const { state, authorize } = await setup(page, { draft: false })
  await page.goto("/")
  const checklist = page.getByRole("heading", { name: /first steps/i })
  await expect(checklist).toBeVisible()
  await expect(checklist).toContainText("0 of 3")
  await expect(page.getByText("Start free with your own OpenRouter account", { exact: false })).toBeVisible()
  await expect(page.getByRole("button", { name: "Use my own API key" })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("05-checklist-start-free.png"), animations: "disabled" })

  await signInOnOpenRouter(page, () => page.getByRole("button", { name: "Start free →" }).click(), authorize)
  expect(state.methods).toEqual([0])

  await expect(checklist).toContainText("1 of 3")
  await expect(page.getByText("Connected. Run the safe first task below", { exact: false })).toBeVisible()
  await expect(
    page.getByText("Maker Big is ready. Open a project to send your first prompt.", { exact: true }),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Start free →" })).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath("06-checklist-connected.png"), animations: "disabled" })
})
