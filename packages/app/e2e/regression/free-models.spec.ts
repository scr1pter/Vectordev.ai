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

/** A section's header opens and closes its rows. Every section below Recently used starts closed, and its header is a
    button even when it is the only one. */
async function openSection(page: Page, label: string) {
  const header = page.locator("button[data-model-section-toggle]").filter({ hasText: label })
  await expect(header).toBeVisible()
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click()
  await expect(header).toHaveAttribute("aria-expanded", "true")
}

const openFreeModels = (page: Page) => openSection(page, "Free models inside of Vector")

test("lists both copies of a free model once each, under Recently used first, and hides the group when OFF", async ({
  page,
}, testInfo) => {
  await setup(page, { enabled: true })
  await page.locator('[data-action="prompt-model"]').filter({ visible: true }).first().click()
  // The current model's section comes first, above the free models and every provider. The assertion waits: on a
  // loaded runner the picker can draw before the current model's row is known.
  await expect(page.locator("[data-model-section]").first()).toHaveAttribute("data-model-section", "recent")
  await openFreeModels(page)
  // A connected OpenRouter account no longer hides the shared copy, which stays on Vector's shared allowance.
  const shared = page.locator('[data-option-key="vector:maker/coder:free"]')
  await expect(shared).toHaveCount(1)
  await expect(shared).toContainText("Maker Coder")
  await expect(shared).toContainText("Provided by Vector")
  const free = page.locator('[data-option-key="openrouter:maker/coder:free"]')
  await expect(free).toHaveCount(1)
  await expect(free).toContainText("Maker Coder")
  await expect(free).toContainText("Your OpenRouter account")
  await page.screenshot({ path: testInfo.outputPath("free-model-picker.png") })
  await page.keyboard.press("Escape")
  await page.unrouteAll({ behavior: "wait" })
  await setup(page, { enabled: false })
  await page.locator('[data-action="prompt-model"]').filter({ visible: true }).first().click()
  await expect(
    page.locator('[data-slot="model-section-name"]').filter({ hasText: "Free models inside of Vector" }),
  ).toHaveCount(0)
  // OpenRouter is now the only section with a header. It still starts closed and opens when clicked.
  const lone = page.locator("button[data-model-section-toggle]").filter({ hasText: "OpenRouter" })
  await expect(page.locator("button[data-model-section-toggle]")).toHaveCount(1)
  await expect(lone).toHaveAttribute("aria-expanded", "false")
  await openSection(page, "OpenRouter")
  await expect(page.locator('[data-option-key="openrouter:maker/coder:free"]')).toBeVisible()
  await lone.click()
  await expect(lone).toHaveAttribute("aria-expanded", "false")
  await expect(page.locator('[data-option-key="openrouter:maker/coder:free"]')).toHaveCount(0)
})

test("clicking a provider's header shows its models, clicking it again hides them, and the picker remembers", async ({
  page,
}, testInfo) => {
  await setup(page, { enabled: true, paidAgent: true })
  const picker = page.locator('[data-action="prompt-model"]').filter({ visible: true }).first()
  await picker.click()
  const provider = page.locator("button[data-model-section-toggle]").filter({ hasText: "OpenRouter" })
  const free = page.locator("button[data-model-section-toggle]").filter({ hasText: "Free models inside of Vector" })
  const paid = page.locator('[data-option-key="openrouter:maker/paid"]')
  // Sections below the current model start closed.
  await expect(provider).toHaveAttribute("aria-expanded", "false")
  await expect(free).toHaveAttribute("aria-expanded", "false")
  await expect(paid).toHaveCount(0)
  // Headers never take focus from search, so typing and the arrow keys keep driving the list.
  const search = page.getByRole("searchbox").first()
  await search.click()
  await provider.click()
  await expect(provider).toHaveAttribute("aria-expanded", "true")
  await expect(paid).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("model-picker-provider-open.png") })
  await provider.click()
  await expect(provider).toHaveAttribute("aria-expanded", "false")
  await expect(paid).toHaveCount(0)
  // The keyboard reaches the headers too: Enter or Space on one toggles it, and focus stays in search.
  await expect(search).toBeFocused()
  await expect(provider).toHaveAttribute("data-active", "")
  await page.keyboard.press("Enter")
  await expect(provider).toHaveAttribute("aria-expanded", "true")
  await page.keyboard.press(" ")
  await expect(provider).toHaveAttribute("aria-expanded", "false")
  await expect(search).toHaveValue("")
  await page.keyboard.press("ArrowUp")
  await expect(free).toHaveAttribute("data-active", "")
  await page.keyboard.press("Enter")
  await expect(free).toHaveAttribute("aria-expanded", "true")
  await page.keyboard.press("Enter")
  await expect(free).toHaveAttribute("aria-expanded", "false")
  // Searching opens every section with a match; clearing it restores what was open.
  await provider.click()
  await expect(paid).toBeVisible()
  await search.fill("maker")
  await expect(page.locator("button[data-model-section-toggle]")).toHaveCount(0)
  await expect(page.locator('[data-option-key="vector:maker/coder:free"]')).toBeVisible()
  await expect(paid).toBeVisible()
  await search.fill("")
  await expect(provider).toHaveAttribute("aria-expanded", "true")
  await expect(free).toHaveAttribute("aria-expanded", "false")
  // The next picker opens with the same sections open.
  await page.keyboard.press("Escape")
  await picker.click()
  await expect(provider).toHaveAttribute("aria-expanded", "true")
  await expect(paid).toBeVisible()
})

test("a selected free model that may train shows only its label, under the composer and on its picker rows", async ({
  page,
}, testInfo) => {
  await setup(page, { enabled: true, mayTrain: true })
  const notice = page.locator('[data-component="free-model-training-notice"]')
  await expect(notice).toBeVisible()
  await expect(notice).toHaveText("May train on your prompts")
  await page.screenshot({ path: testInfo.outputPath("free-model-composer-notice.png") })
  await page.locator('[data-action="prompt-model"]').filter({ visible: true }).first().click()
  await openFreeModels(page)
  for (const key of ["vector:maker/coder:free", "openrouter:maker/coder:free"]) {
    const row = page.locator(`[data-option-key="${key}"]`)
    await expect(row.locator('[data-slot="model-row-training"]')).toHaveText("May train on your prompts")
    await expect(row).not.toContainText("Vector itself never trains")
  }
  await expect(page.locator('[data-slot="model-row-training-detail"]')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath("free-model-training-notice.png") })
})

test("a no-training free model shows no training notice", async ({ page }) => {
  await setup(page, { enabled: true })
  await expect(page.locator('[data-action="prompt-model"]').filter({ visible: true }).first()).toContainText(
    "Maker Coder",
  )
  await expect(page.locator('[data-component="free-model-training-notice"]')).toHaveCount(0)
  await page.locator('[data-action="prompt-model"]').filter({ visible: true }).first().click()
  await openFreeModels(page)
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
  await openSection(page, "OpenRouter")
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
  await expect(card).toContainText("You've reached today's limit for Free models inside of Vector")
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
  await expect(card).toContainText("Free models provided by Vector are expected to be available again at")
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
