import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"

const directory = "C:/Vector/FreeModels"
const sessionID = "ses_free_models"
const modelID = "maker/coder:free"
const assistantID = "msg_free_assistant"
const title = "Free model conversation"

function catalog(input: { enabled: boolean; own?: boolean; mayTrain?: boolean }) {
  // A model whose provider may train on prompts, on both routes, carries that policy in its free-model tag.
  const policy = input.mayTrain ? { dataPolicy: "may-train" } : {}
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
        models: input.enabled
          ? { [modelID]: { ...model, providerID: "vector", freeModel: { source: "shared", ...policy } } }
          : {},
      },
      {
        id: "openrouter",
        name: "OpenRouter",
        source: "api",
        models: {
          [modelID]: {
            ...model,
            providerID: "openrouter",
            ...(input.enabled ? { freeModel: { source: "openrouter", ...policy } } : {}),
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
  input: {
    enabled: boolean
    limited?: boolean
    own?: boolean
    resumed?: () => boolean
    paidAgent?: boolean
    mayTrain?: boolean
  },
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

test("groups both copies of a free model, the shared one first, and hides the group when OFF", async ({
  page,
}, testInfo) => {
  await setup(page, { enabled: true })
  await page.locator('[data-action="prompt-model"]').filter({ visible: true }).first().click()
  await expect(
    page.locator('[data-slot="model-section-name"]').filter({ hasText: "Free models inside of Vector" }),
  ).toBeVisible()
  // A connected OpenRouter account no longer hides the shared copy, which stays on Vector's shared allowance.
  const shared = page.locator('[data-option-key="vector:maker/coder:free"]')
  await expect(shared).toHaveCount(1)
  await expect(shared).toContainText("Maker Coder")
  await expect(shared).toContainText("Shared Vector allowance")
  const free = page.locator('[data-option-key="openrouter:maker/coder:free"]')
  await expect(free).toHaveCount(1)
  await expect(free).toContainText("Maker Coder")
  await expect(free).toContainText("Your OpenRouter account")
  const keys = await page
    .locator('[data-option-key$=":maker/coder:free"]')
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-option-key")))
  expect(keys.slice(0, 2)).toEqual(["vector:maker/coder:free", "openrouter:maker/coder:free"])
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

test("a selected free model that may train keeps its disclaimer under the composer and on its picker rows", async ({
  page,
}, testInfo) => {
  await setup(page, { enabled: true, mayTrain: true })
  const notice = page.locator('[data-component="free-model-training-notice"]')
  await expect(notice).toBeVisible()
  await expect(notice).toContainText("Your OpenRouter account · May train on your prompts")
  await expect(notice).toContainText("Vector itself never trains on your prompts.")
  await page.screenshot({ path: testInfo.outputPath("free-model-composer-notice.png") })
  await page.locator('[data-action="prompt-model"]').filter({ visible: true }).first().click()
  for (const key of ["vector:maker/coder:free", "openrouter:maker/coder:free"]) {
    const row = page.locator(`[data-option-key="${key}"]`)
    await expect(row.locator('[data-slot="model-row-training"]')).toHaveText("May train on your prompts")
    await expect(row.locator('[data-slot="model-row-training-detail"]')).toContainText(
      "Don't use it with private repositories, secrets or personal data.",
    )
  }
  await page.screenshot({ path: testInfo.outputPath("free-model-training-notice.png") })
})

test("a no-training free model shows no training notice", async ({ page }) => {
  await setup(page, { enabled: true })
  await expect(page.locator('[data-action="prompt-model"]').filter({ visible: true }).first()).toContainText(
    "Maker Coder",
  )
  await expect(page.locator('[data-component="free-model-training-notice"]')).toHaveCount(0)
  await page.locator('[data-action="prompt-model"]').filter({ visible: true }).first().click()
  await expect(page.locator('[data-option-key="vector:maker/coder:free"]')).toBeVisible()
  await expect(page.locator('[data-slot="model-row-training-detail"]')).toHaveCount(0)
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
  await expect(card).toContainText("You've used today's shared allowance for Free models inside of Vector")
  await expect(card).toContainText("2030")
  await expect(page.getByText("RAW_UPSTREAM_QUOTA_DETAILS_MUST_NOT_RENDER")).toHaveCount(0)
  await expect(page.getByText("Build · Maker Coder:free")).toHaveCount(0)
  await expect(page.getByText("Build · Maker Coder", { exact: true })).toBeVisible()
  // It says when the shared allowance resets and offers the user's own keys, never connecting OpenRouter.
  await expect(card).toContainText("add your own provider key in Settings → Providers")
  await expect(card.getByRole("button", { name: "Connect OpenRouter", exact: true })).toHaveCount(0)
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

test("without an OpenRouter account, the limit card offers the user's own keys and never OpenRouter", async ({
  page,
}) => {
  // The owner's decision of 17 October 2026: free models run on Vector's shared allowance, and its limit notice never
  // asks anyone to connect an OpenRouter account of their own.
  await setup(page, { enabled: true, limited: true, own: false })
  const prompts: string[] = []
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/session\/[^/]+\/(message|prompt_async)$/.test(new URL(request.url()).pathname)
    )
      prompts.push(request.url())
  })
  const card = page.locator("[data-free-models-limit]")
  await expect(card).toBeVisible()
  await expect(card).toContainText("The shared allowance is expected to reset at")
  await expect(card).toContainText("2030")
  await expect(card).toContainText("add your own provider key in Settings → Providers")
  await expect(card).not.toContainText("OpenRouter")
  await expect(card.getByRole("button", { name: "Continue with connected OpenRouter" })).toHaveCount(0)
  await card.getByRole("button", { name: "Use my own API key" }).click()
  await expect(page.getByPlaceholder("Search providers")).toBeVisible()
  await page.keyboard.press("Escape")
  expect(prompts).toEqual([])
  await expect(page.getByText("Please continue this exact task", { exact: true })).toHaveCount(1)
})
