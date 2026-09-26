import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"

const directory = "C:/Vector/PluginConsent"
const sessionID = "ses_plugin_consent"

async function setup(page: Page, approved: boolean) {
  await mockVectorServer(page, {
    directory,
    project: {
      id: "proj_plugin_consent",
      worktree: directory,
      vcs: "git",
      name: "plugin-consent",
      time: { created: 1, updated: 1 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "github-copilot",
          name: "GitHub Copilot",
          source: "custom",
          options: approved ? { vectorOAuthPlugin: "a".repeat(64) } : {},
          models: {},
        },
        {
          id: "openai",
          name: "OpenAI",
          source: "api",
          models: {
            coding: {
              id: "coding",
              name: "Fixture Coder",
              providerID: "openai",
              limit: { context: 128000 },
              variants: {},
            },
          },
        },
      ],
      connected: ["openai"],
      default: { openai: "coding" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "consent",
        projectID: "proj_plugin_consent",
        directory,
        title: "Plugin consent",
        version: "1",
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    eventRetry: 100,
  })
  await page.addInitScript(() =>
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } })),
  )
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`, { waitUntil: "domcontentloaded" })
  await expect(page.locator('[data-component="session-composer"]')).toBeVisible()
  await expect(page.locator("#vector-launch")).toHaveCount(0)
  await page.locator('[data-action="prompt-model"]').filter({ visible: true }).first().click()
  await page.locator('[data-option-key="action:connect-provider"]').click()
}

test("an older server cannot expose the paused built-in Copilot sign-in", async ({ page }) => {
  await setup(page, false)
  await expect(page.getByText("GitHub Copilot", { exact: true })).toHaveCount(0)
  await expect(page.getByText("OpenAI", { exact: true })).toBeVisible()
})

test("a runtime-approved community plugin can complete its supplied OAuth method", async ({ page }) => {
  const requests: string[] = []
  const consent = Promise.withResolvers<void>()
  await setup(page, true)
  await page.route("**/provider/auth*", (route) =>
    route.fulfill({ json: { "github-copilot": [{ type: "oauth", label: "Approved fixture sign-in" }] } }),
  )
  await page.context().route("**/plugin-fixture-callback", (route) => {
    consent.resolve()
    return route.fulfill({ body: "Synthetic plugin authorization" })
  })
  await page.route("**/provider/github-copilot/oauth/authorize*", (route) => {
    requests.push("authorize")
    expect(route.request().postDataJSON()).toEqual({ method: 0 })
    return route.fulfill({
      json: {
        method: "auto",
        url: `${new URL(page.url()).origin}/plugin-fixture-callback`,
        instructions: "Complete the fixture sign-in.",
      },
    })
  })
  await page.route("**/provider/github-copilot/oauth/callback*", async (route) => {
    requests.push("callback")
    await consent.promise
    return route.fulfill({ json: true })
  })
  await page.route("**/global/dispose*", (route) => route.fulfill({ json: true }))
  await page.getByText("GitHub Copilot", { exact: true }).click()
  const popup = page.waitForEvent("popup")
  await page.getByRole("link", { name: "this link", exact: true }).click()
  const authorization = await popup
  await expect(authorization.getByText("Synthetic plugin authorization")).toBeVisible()
  await authorization.close()
  await expect.poll(() => requests).toEqual(["authorize", "callback"])
  await expect(page.getByText("GitHub Copilot connected", { exact: true })).toBeVisible()
})
