import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"

const directory = "C:/Vector/FreeModels"
const sessionID = "ses_free_models"
const modelID = "maker/coder:free"
const assistantID = "msg_free_assistant"
const title = "Free model conversation"

function catalog(input: { enabled: boolean; own?: boolean }) {
  const model = {
    id: modelID,
    name: "Maker Coder:free",
    limit: { context: 128000 },
    cost: { input: 0, output: 0 },
    variants: {},
  }
  return {
    all: [
      {
        id: "vector",
        name: "Vector",
        source: "custom",
        models: input.enabled ? { [modelID]: { ...model, providerID: "vector", freeModel: { source: "shared" } } } : {},
      },
      {
        id: "openrouter",
        name: "OpenRouter",
        source: "api",
        models: {
          [modelID]: {
            ...model,
            providerID: "openrouter",
            ...(input.enabled ? { freeModel: { source: "openrouter" } } : {}),
          },
        },
      },
    ],
    connected: [...(input.enabled ? ["vector"] : []), ...(input.own === false ? [] : ["openrouter"])],
    default: { openrouter: modelID, ...(input.enabled ? { vector: modelID } : {}) },
  }
}

async function setup(
  page: Page,
  input: { enabled: boolean; limited?: boolean; own?: boolean; resumed?: () => boolean; paidAgent?: boolean },
) {
  const messages = () => ({
    items: input.limited
      ? [
          {
            info: {
              id: "msg_free_user",
              role: "user",
              sessionID,
              agent: "build",
              model: { providerID: "vector", modelID },
              time: { created: 1 },
            },
            parts: [
              {
                id: "prt_free_user",
                messageID: "msg_free_user",
                sessionID,
                type: "text",
                text: "Please continue this exact task",
              },
            ],
          },
          {
            info: {
              id: assistantID,
              role: "assistant",
              sessionID,
              parentID: "msg_free_user",
              agent: "build",
              mode: "build",
              providerID: "vector",
              modelID,
              time: { created: 2, completed: 3 },
              path: { cwd: directory, root: directory },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              finish: "error",
              error: input.resumed?.()
                ? undefined
                : {
                    name: "FreeModelsLimitError",
                    data: {
                      code: "VECTOR_FREE_MODELS_LIMIT",
                      reason: "user_daily",
                      resetAt: 1893542400000,
                      message: "RAW_UPSTREAM_QUOTA_DETAILS_MUST_NOT_RENDER",
                    },
                  },
            },
            parts: [],
          },
        ]
      : [],
  })
  await mockVectorServer(page, {
    directory,
    project: {
      id: "proj_free_models",
      worktree: directory,
      vcs: "git",
      name: "free-models",
      time: { created: 1, updated: 1 },
      sandboxes: [],
    },
    provider: catalog(input),
    sessions: [
      {
        id: sessionID,
        slug: "free-models",
        projectID: "proj_free_models",
        directory,
        title,
        version: "dev",
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: messages,
    events: () =>
      input.resumed?.()
        ? [{ directory, payload: { type: "message.updated", properties: { info: messages().items[1]?.info } } }]
        : [],
    eventRetry: 100,
  })
  if (input.paidAgent) {
    await page.route(/\/agent(?:\?|$)/, (route) =>
      route.fulfill({
        json: [
          { name: "build", mode: "primary" },
          { name: "specialist", mode: "primary", model: { providerID: "openrouter", modelID: "maker/paid" } },
        ],
      }),
    )
    await page.route(/\/provider(?:\?|$)/, (route) => {
      const provider = catalog(input)
      const router = provider.all.find((item) => item.id === "openrouter")!
      Object.assign(router.models, {
        "maker/paid": {
          id: "maker/paid",
          name: "Paid Specialist",
          providerID: "openrouter",
          limit: { context: 128000 },
          cost: { input: 10, output: 10 },
          variants: {},
        },
      })
      return route.fulfill({ json: provider })
    })
  }
  await page.addInitScript(
    (showCustomAgents) =>
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true, showCustomAgents } })),
    input.paidAgent ?? false,
  )
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expect(page.locator('[data-component="session-composer"]')).toBeVisible()
  await expect(page.locator("#vector-launch")).toHaveCount(0)
}

test("groups free models once, prefers own account, and hides the group when OFF", async ({ page }, testInfo) => {
  await setup(page, { enabled: true })
  await page.locator('[data-action="prompt-model"]').filter({ visible: true }).first().click()
  await expect(
    page.locator('[data-slot="model-section-name"]').filter({ hasText: "Free models inside of Vector" }),
  ).toBeVisible()
  const free = page.locator('[data-option-key="openrouter:maker/coder:free"]')
  await expect(free).toHaveCount(1)
  await expect(free).toContainText("Maker Coder")
  await expect(free).toContainText("Your OpenRouter account")
  await expect(page.locator('[data-option-key="vector:maker/coder:free"]')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath("free-model-picker.png") })
  await page.keyboard.press("Escape")
  await page.unrouteAll({ behavior: "wait" })
  await setup(page, { enabled: false })
  await page.locator('[data-action="prompt-model"]').filter({ visible: true }).first().click()
  await expect(
    page.locator('[data-slot="model-section-name"]').filter({ hasText: "Free models inside of Vector" }),
  ).toHaveCount(0)
  await expect(page.locator('[data-option-key="openrouter:maker/coder:free"]')).toBeVisible()
})

test("switching agents preserves the selected free model until an explicit paid model choice", async ({ page }) => {
  await setup(page, { enabled: true, paidAgent: true })
  const picker = page.locator('[data-action="prompt-model"]').filter({ visible: true }).first()
  await expect(picker).toContainText("Maker Coder")
  const agent = page.locator('[data-action="prompt-agent"]').filter({ visible: true }).first()
  await agent.click()
  await page.getByRole("option", { name: "specialist", exact: true }).click()
  await expect(agent).toContainText("specialist")
  await expect(picker).toContainText("Maker Coder")

  await picker.click()
  await page.locator('[data-option-key="openrouter:maker/paid"]').click()
  await expect(picker).toContainText("Paid Specialist")
})

test("quota recovery resumes the same failed turn without submitting a new prompt", async ({ page }, testInfo) => {
  await setup(page, { enabled: true, limited: true })
  const posts: Array<{ path: string; data: unknown }> = []
  await page.route(`**/session/${sessionID}/free-models/resume*`, (route) => {
    posts.push({ path: new URL(route.request().url()).pathname, data: route.request().postDataJSON() })
    return route.fulfill({ json: true })
  })
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/session\/[^/]+\/(message|prompt_async)$/.test(new URL(request.url()).pathname)
    )
      posts.push({ path: "unexpected-prompt", data: request.postDataJSON() })
  })
  const card = page.locator("[data-free-models-limit]")
  await expect(card).toBeVisible()
  await expect(card).toContainText("You've used today's shared free models inside of Vector")
  await expect(card).toContainText("2030")
  await expect(page.getByText("RAW_UPSTREAM_QUOTA_DETAILS_MUST_NOT_RENDER")).toHaveCount(0)
  await expect(page.getByText("Build · Maker Coder:free")).toHaveCount(0)
  await expect(page.getByText("Build · Maker Coder", { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("free-model-quota.png") })
  await card.getByRole("button", { name: "Continue with connected OpenRouter" }).click()
  await expect(card).toContainText("Continuing this conversation with your OpenRouter account.")
  expect(posts).toEqual([
    { path: `/session/${sessionID}/free-models/resume`, data: { messageID: assistantID, modelID } },
  ])
  await expect(page.getByText("Please continue this exact task", { exact: true })).toHaveCount(1)
  await expect(page.locator('[data-action="prompt-model"]').filter({ visible: true }).first()).toContainText(
    "Maker Coder",
  )
})

test("Connect OpenRouter starts PKCE and resumes the same conversation after authorization", async ({ page }) => {
  let accepted = false
  await setup(page, { enabled: true, limited: true, own: false, resumed: () => accepted })
  let connected = false
  const providerReads: string[] = []
  await page.route(/\/provider(?:\?|$)/, (route) => {
    if (connected) providerReads.push(new URL(route.request().url()).searchParams.get("directory") ?? "global")
    return route.fulfill({ json: catalog({ enabled: true, own: connected }) })
  })
  const methods: number[] = []
  const resumed: unknown[] = []
  const prompts: string[] = []
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/session\/[^/]+\/(message|prompt_async)$/.test(new URL(request.url()).pathname)
    )
      prompts.push(request.url())
  })
  await page.context().route("**/oauth-test", (route) => route.fulfill({ body: "Synthetic authorization callback" }))
  await page.route("**/provider/auth*", (route) =>
    route.fulfill({
      json: {
        openrouter: [
          { type: "oauth", label: "Connect OpenRouter" },
          { type: "api", label: "API key" },
        ],
      },
    }),
  )
  await page.route("**/provider/openrouter/oauth/authorize*", (route) => {
    methods.push(route.request().postDataJSON().method)
    return route.fulfill({
      json: {
        method: "auto",
        url: `${new URL(page.url()).origin}/oauth-test`,
        instructions: "Complete authorization in your browser.",
      },
    })
  })
  await page.route("**/provider/openrouter/oauth/callback*", (route) => {
    connected = true
    return route.fulfill({ json: true })
  })
  await page.route("**/global/dispose*", (route) => route.fulfill({ json: true }))
  await page.route(`**/session/${sessionID}/free-models/resume*`, (route) => {
    resumed.push(route.request().postDataJSON())
    accepted = true
    return route.fulfill({ json: true })
  })
  const card = page.locator("[data-free-models-limit]")
  const popup = page.waitForEvent("popup")
  await card.getByRole("button", { name: "Connect OpenRouter", exact: true }).click()
  const authorizationPage = await popup
  await expect(authorizationPage.getByText("Synthetic authorization callback")).toBeVisible()
  await authorizationPage.close()
  await page.bringToFront()
  await expect
    .poll(() => ({ methods, resumed, connected }))
    .toEqual({ methods: [0], resumed: [{ messageID: assistantID, modelID }], connected: true })
  expect(providerReads).toEqual(expect.arrayContaining(["global", directory]))
  expect(prompts).toEqual([])
  await page.locator('[data-action="prompt-model"]').filter({ visible: true }).first().click()
  await expect(page.locator('[data-option-key="openrouter:maker/coder:free"]')).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(card).toHaveCount(0)
  await expect(page.getByText("Please continue this exact task", { exact: true })).toHaveCount(1)
})
