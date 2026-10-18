import { expect, test, type Page } from "@playwright/test"
import { mockVectorServer } from "../utils/mock-server"

const directory = "C:/Vector/FirstRun"
const draftID = "draft_first_run"
const draft = "Summarize this repository without changing files"

/**
 * What the engine lists before and after it is signed in to Vector. Signed in, Free models inside of Vector run on
 * Vector's shared allowance: a no-training model, a may-train one with a larger context, and OpenRouter's Free Models
 * Router. The engine's default for the shared models is the no-training one, never the router (Provider.sort). A paid
 * OpenRouter model, not connected, is the account default throughout.
 */
function catalog(signedIn: boolean) {
  const shared = {
    "maker/coder:free": { name: "Maker Coder:free", context: 128_000, dataPolicy: "no-training" },
    "maker/big:free": { name: "Maker Big:free", context: 256_000, dataPolicy: "may-train" },
    "openrouter/free": { name: "Free Models Router", context: 200_000, dataPolicy: "may-train" },
  }
  return {
    all: [
      {
        id: "vector",
        name: "Vector",
        source: "custom",
        models: signedIn
          ? Object.fromEntries(
              Object.entries(shared).map(([id, model]) => [
                id,
                {
                  id,
                  providerID: "vector",
                  name: model.name,
                  limit: { context: model.context },
                  cost: { input: 0, output: 0 },
                  variants: {},
                  freeModel: { source: "shared", dataPolicy: model.dataPolicy },
                },
              ]),
            )
          : {},
      },
      {
        id: "openrouter",
        name: "OpenRouter",
        source: "api",
        models: {
          "maker/giant": {
            id: "maker/giant",
            providerID: "openrouter",
            name: "Paid Giant",
            limit: { context: 1_000_000 },
            cost: { input: 10, output: 30 },
            variants: {},
          },
        },
      },
    ],
    connected: signedIn ? ["vector"] : [],
    default: { openrouter: "maker/giant", ...(signedIn ? { vector: "maker/coder:free" } : {}) },
  }
}

/**
 * A fresh profile with no provider, optionally with one repository draft open. OpenRouter's PKCE routes are mocked
 * only so a test can show the first run never starts them. Setting `state.signedIn` stands for `vector login` on the
 * engine's computer and a restart, after which the engine lists the shared allowance.
 */
async function setup(page: Page, input: { draft: boolean }) {
  const state = { signedIn: false, methods: [] as number[], prompts: [] as string[] }
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
  await page.route(/\/provider(?:\?|$)/, (route) => route.fulfill({ json: catalog(state.signedIn) }))
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
  await page.route("**/provider/openrouter/oauth/authorize*", (route) => {
    state.methods.push(route.request().postDataJSON().method)
    return route.fulfill({ json: { method: "auto", url: "about:blank", instructions: "Finish in your browser." } })
  })
  await page.route("**/global/dispose*", (route) => route.fulfill({ json: true }))
  page.on("request", (request) => {
    if (request.method() !== "POST") return
    if (/\/session(?:\/[^/]+\/(?:message|prompt_async))?$/.test(new URL(request.url()).pathname))
      state.prompts.push(request.url())
  })
  if (!input.draft) return { state }
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
  return { state }
}

// The owner's decision of 17 October 2026: free models run on Vector's shared allowance for every signed-in Vector
// account, so the first-run card and checklist offer signing in to Vector, never connecting an OpenRouter account. This
// web build has no desktop account bridge, so the card says where to sign in (vector login on the engine's computer)
// instead of offering a sign-in it cannot start, and offers a key the user has. Once the engine is signed in, the
// shared allowance's models load, the card goes away and a no-training free model is chosen, the draft still in place.
test("fresh profile is told how to sign in to Vector, then starts on the shared allowance with its draft", async ({
  page,
}) => {
  const { state } = await setup(page, { draft: true })
  await page.goto(`/new-session?draftId=${draftID}`)

  const card = page.locator('[data-component="free-model-start"]')
  await expect(card).toBeVisible()
  await expect(card).toContainText("Choose a model to start")
  await expect(card).toContainText("To use free models, sign in to Vector on the computer this page connects to")
  await expect(card).toContainText("run vector login there")
  await expect(card.getByRole("button", { name: "Sign in to Vector" })).toHaveCount(0)
  // The card says who processes prompts on the shared allowance; naming OpenRouter there promotes nothing.
  await expect(card).toContainText("Vector's shared allowance")
  await expect(card).toContainText("OpenRouter and the model's provider process your prompts.")
  // It never asks anyone to bring an OpenRouter account of their own.
  await expect(card).not.toContainText(/connect (?:your own )?(?:free )?openrouter/i)
  await expect(card).not.toContainText(/your own (?:free )?openrouter/i)
  await expect(card).not.toContainText(/start free with/i)
  await expect(card.getByRole("button", { name: /openrouter/i })).toHaveCount(0)
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
    page.getByText(
      "Your prompt is kept. To use free models, run vector login on the computer this page connects to, then restart Vector. Or use an API key you already have.",
    ),
  ).toBeVisible()
  await expect(ownKey).toBeFocused()
  await expect(editor).toHaveText(draft)
  await page.screenshot({ path: test.info().outputPath("02-send-without-model.png"), animations: "disabled" })

  // vector login on the engine's computer, a restart, and the page loaded again.
  state.signedIn = true
  await page.reload()
  await expect(page.locator('[data-component="prompt-input"]').filter({ visible: true }).first()).toBeVisible()
  await expect(card).toHaveCount(0)
  const picker = page.locator('[data-action="prompt-model"]').filter({ visible: true }).first()
  await expect(picker).toContainText("Maker Coder")
  for (const other of ["Maker Big", "Free Models Router", "Paid Giant"]) await expect(picker).not.toContainText(other)
  await expect(editor).toHaveText(draft)
  expect(state.prompts).toEqual([])
  expect(state.methods).toEqual([])
  await page.screenshot({ path: test.info().outputPath("03-composer-shared-allowance.png"), animations: "disabled" })
})

test("the first-run checklist says how to sign in to Vector for free models, never OpenRouter", async ({ page }) => {
  const { state } = await setup(page, { draft: false })
  await page.goto("/")
  const checklist = page.getByRole("heading", { name: /first steps/i })
  await expect(checklist).toBeVisible()
  await expect(checklist).toContainText("0 of 3")
  // The web build cannot sign in itself, so the step says where to, and offers a key the user has instead.
  await expect(
    page.getByText(
      "To use free models, sign in to Vector on the computer this page connects to: run vector login there",
      { exact: false },
    ),
  ).toBeVisible()
  await expect(page.getByText("Start free with your own OpenRouter account", { exact: false })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Start free →" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Use my own API key →" })).toBeVisible()
  expect(state.methods).toEqual([])
  await page.screenshot({ path: test.info().outputPath("05-checklist-start-free.png"), animations: "disabled" })
})
