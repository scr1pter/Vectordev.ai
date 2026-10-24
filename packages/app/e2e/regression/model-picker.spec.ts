import { expect, test, type Locator, type Page } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"

// The model picker as people see it: the composer's dialog over several providers and the free models, and the
// popover over an external agent's own CLI models. It is one plain list: search, a short Recently used, one row per
// provider, and one line per model with only its context size, the yellow "May train on your prompts" tag where it
// applies, and a check on the current one. Screenshots go to the test's output folder.
const directory = "C:/Vector/ModelPicker"
const sessionID = "ses_model_picker"

test.use({ colorScheme: "dark", viewport: { width: 1280, height: 860 } })

const model = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  limit: { context: 200_000 },
  cost: { input: 2, output: 8 },
  release_date: "2026-03-01",
  capabilities: { reasoning: true, toolcall: true },
  variants: {},
  ...extra,
})

const free = (id: string, name: string, dataPolicy: string, extra: Record<string, unknown> = {}) =>
  model(id, name, { cost: { input: 0, output: 0 }, freeModel: { source: "shared", dataPolicy }, ...extra })

const catalog = {
  all: [
    {
      id: "vector",
      name: "Vector",
      source: "custom",
      models: {
        "qwen/qwen3-coder:free": free("qwen/qwen3-coder:free", "Qwen3 Coder:free", "no-training", {
          limit: { context: 262_144 },
        }),
        "poolside/laguna-s-2.1:free": free("poolside/laguna-s-2.1:free", "Poolside: Laguna S 2.1", "may-train", {
          limit: { context: 131_072 },
        }),
      },
    },
    {
      id: "anthropic",
      name: "Anthropic",
      source: "api",
      env: ["ANTHROPIC_API_KEY"],
      models: {
        "claude-opus-5": model("claude-opus-5", "Claude Opus 5", {
          release_date: "2026-07-24",
          limit: { context: 1_000_000 },
        }),
        "claude-sonnet-5": model("claude-sonnet-5", "Claude Sonnet 5", { release_date: "2026-10-01" }),
        "claude-haiku-5": model("claude-haiku-5", "Claude Haiku 5", { release_date: "2026-05-20" }),
      },
    },
    {
      id: "openai",
      name: "OpenAI",
      source: "api",
      env: ["OPENAI_API_KEY"],
      models: {
        "gpt-6-astra": model("gpt-6-astra", "GPT-6 Astra", {
          release_date: "2026-09-04",
          limit: { context: 1_050_000 },
        }),
        "gpt-5.6-sol": model("gpt-5.6-sol", "GPT-5.6 Sol", { release_date: "2026-07-09", limit: { context: 400_000 } }),
        "gpt-5.5": model("gpt-5.5", "GPT-5.5", { release_date: "2026-04-23", limit: { context: 400_000 } }),
      },
    },
    {
      id: "google",
      name: "Google",
      source: "api",
      env: ["GEMINI_API_KEY"],
      models: {
        "gemini-3-pro": model("gemini-3-pro", "Gemini 3 Pro", { limit: { context: 1_048_576 } }),
        "gemini-3-flash": model("gemini-3-flash", "Gemini 3 Flash", { limit: { context: 1_048_576 } }),
      },
    },
    {
      // The user's own OpenRouter account: a paid model, and its own copy of a free model.
      id: "openrouter",
      name: "OpenRouter",
      source: "api",
      env: ["OPENROUTER_API_KEY"],
      models: {
        "maker/paid": model("maker/paid", "Maker Paid", { limit: { context: 128_000 } }),
        "qwen/qwen3-coder:free": model("qwen/qwen3-coder:free", "Qwen3 Coder:free", {
          cost: { input: 0, output: 0 },
          limit: { context: 262_144 },
          freeModel: { source: "openrouter", dataPolicy: "no-training" },
        }),
      },
    },
  ],
  connected: ["vector", "anthropic", "openai", "google", "openrouter"],
  default: { anthropic: "claude-opus-5" },
}

async function openDialog(page: Page) {
  await mockVectorServer(page, {
    directory,
    project: {
      id: "proj_model_picker",
      worktree: directory,
      vcs: "git",
      name: "model-picker",
      time: { created: 1, updated: 1 },
      sandboxes: [],
    },
    provider: catalog,
    sessions: [
      {
        id: sessionID,
        slug: "model-picker",
        projectID: "proj_model_picker",
        directory,
        title: "Model picker",
        version: "dev",
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem(
      "vector.global.dat:model",
      JSON.stringify({
        user: [],
        recent: [
          { providerID: "anthropic", modelID: "claude-opus-5" },
          { providerID: "openai", modelID: "gpt-6-astra" },
          { providerID: "vector", modelID: "poolside/laguna-s-2.1:free" },
        ],
        variant: {},
      }),
    )
  })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expect(page.locator('[data-component="session-composer"]')).toBeVisible()
  await page.locator('[data-action="prompt-model"]').filter({ visible: true }).first().click()
  const dialog = page.locator(".vector-select-model-dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.locator("[data-model-section]").first()).toHaveAttribute("data-model-section", "recent")
  await expect(dialog.locator('[data-model-section="recent"] [data-option-key]')).toHaveCount(3)
  return dialog
}

const header = (picker: Locator, label: string) =>
  picker.locator("button[data-model-section-toggle]").filter({ hasText: label })

/** Every row and every provider header is one even line, 32 to 36px tall. Layout heights, not on-screen boxes: the
    popover scales in as it opens. */
async function expectEvenRows(picker: Locator) {
  const rows = picker.locator('[data-component="menu-v2-item"], button[data-model-section-toggle]')
  const heights = await rows.evaluateAll((items) =>
    items.flatMap((item) => (item instanceof HTMLElement ? [item.offsetHeight] : [])),
  )
  expect(heights.length).toBeGreaterThan(0)
  expect(new Set(heights).size).toBe(1)
  expect(heights[0]).toBeGreaterThanOrEqual(32)
  expect(heights[0]).toBeLessThanOrEqual(36)
}

const top = async (locator: Locator) => (await locator.boundingBox())?.y

/** WCAG contrast of an element's text on the first opaque background behind it. */
async function contrast(text: Locator) {
  const [foreground, background] = await text.evaluate((element) => {
    const opaque = (value: string) => !/(?:rgba\(.*,\s*0(?:\.\d+)?\)|\/\s*0?\.\d+\)|transparent)$/.test(value)
    let node: Element | null = element.parentElement
    while (node && !opaque(getComputedStyle(node).backgroundColor)) node = node.parentElement
    return [getComputedStyle(element).color, node ? getComputedStyle(node).backgroundColor : "rgb(0, 0, 0)"]
  })
  const luminance = (value: string) => {
    const srgb = value.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/)?.slice(1, 4).map(Number)
    const rgb = value.match(/rgba?\(([\d.]+),? ([\d.]+),? ([\d.]+)/)?.slice(1, 4).map((part) => Number(part) / 255)
    const channels = srgb ?? rgb
    if (!channels) throw new Error(`unreadable colour: ${value}`)
    const [r, g, b] = channels.map((part) => (part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (light + 0.05) / (dark + 0.05)
}

async function shot(page: Page, picker: Locator, path: string) {
  // Let the open animation and any chevron turn settle first.
  await page.waitForTimeout(250)
  const box = await picker.boundingBox()
  if (!box) throw new Error("picker is not on screen")
  const margin = 24
  await page.screenshot({
    path,
    clip: {
      x: Math.max(0, box.x - margin),
      y: Math.max(0, box.y - margin),
      width: box.width + margin * 2,
      height: box.height + margin * 2,
    },
  })
}

test("the composer's picker over several providers, one open, a search and the free models", async ({
  page,
}, testInfo) => {
  const dialog = await openDialog(page)
  const container = page.locator('[data-slot="dialog-container"]').filter({ has: dialog })
  const search = dialog.getByRole("searchbox")
  // One quiet search field on top, focused, with no title bar above it.
  await expect(search).toBeFocused()
  expect(await top(search)).toBeLessThan((await top(dialog.locator('[data-model-section="recent"]'))) ?? 0)
  // Recently used: a caption over the three rows, each with its provider's mark, the current one checked.
  const recent = dialog.locator('[data-model-section="recent"]')
  await expect(recent.locator('[data-slot="menu-v2-group-label"]')).toHaveText("Recently used")
  await expect(recent.locator('[data-slot="model-row-icon"] svg')).toHaveCount(3)
  // Recently used rows have keys of their own: each model is listed under its provider too.
  const opus = recent.locator('[data-option-key="recent:anthropic:claude-opus-5"]')
  await expect(opus).toHaveAttribute("data-checked", "")
  await expect(opus.locator('[data-slot="model-row-context"]')).toHaveText("1M")
  await expect(
    recent.locator('[data-option-key="recent:vector:poolside/laguna-s-2.1:free"] [data-slot="model-row-training"]'),
  ).toHaveText("May train on your prompts")
  // Each provider is one closed row: its name and a muted count of all its models, the recent ones included, and
  // nothing else.
  const providers = dialog.locator("button[data-model-section-toggle]")
  await expect(providers).toHaveCount(5)
  for (const [label, count] of [
    ["Free models inside of Vector", "2"],
    ["Anthropic", "3"],
    ["OpenAI", "3"],
    ["Google", "2"],
    ["OpenRouter", "2"],
  ]) {
    const row = header(dialog, label)
    await expect(row).toHaveAttribute("aria-expanded", "false")
    await expect(row.locator('[data-slot="model-section-name"]')).toHaveText(label)
    await expect(row.locator('[data-slot="model-section-count"]')).toHaveText(count)
  }
  // No descriptions, release dates, "New", access or policy captions anywhere.
  for (const text of ["API key", "New", "Provided by Vector", "No-training policy", "Your OpenRouter account", "2026"])
    await expect(dialog).not.toContainText(text)
  await expect(dialog.locator('[data-option-key="action:connect-provider"]')).toHaveText("Connect provider")
  // Muted text (a count, a context size, a caption) still reads at 4.5:1 or more on the dialog's surface.
  for (const muted of [
    header(dialog, "OpenAI").locator('[data-slot="model-section-count"]'),
    recent.locator('[data-option-key="recent:openai:gpt-6-astra"] [data-slot="model-row-context"]'),
    recent.locator('[data-slot="menu-v2-group-label"]'),
  ])
    expect(await contrast(muted)).toBeGreaterThanOrEqual(4.5)
  await expectEvenRows(dialog)
  await shot(page, container, testInfo.outputPath("dialog-providers.png"))

  // Opening a provider moves nothing above it and never resizes the dialog.
  const before = { box: await container.boundingBox(), header: await top(header(dialog, "Anthropic")) }
  await header(dialog, "Anthropic").click()
  await expect(header(dialog, "Anthropic")).toHaveAttribute("aria-expanded", "true")
  await expect(dialog.locator('[data-option-key="anthropic:claude-sonnet-5"]')).toBeVisible()
  // The count is the rows that open: Claude Opus 5 is under Anthropic as well as in Recently used, checked in both.
  const anthropic = dialog
    .locator('[data-model-section="provider"]')
    .filter({ has: page.locator("button[data-model-section-toggle]").filter({ hasText: "Anthropic" }) })
  await expect(anthropic.locator('[data-component="menu-v2-item"]')).toHaveCount(3)
  await expect(anthropic.locator('[data-option-key="anthropic:claude-opus-5"]')).toHaveAttribute("data-checked", "")
  expect(await container.boundingBox()).toEqual(before.box)
  expect(await top(header(dialog, "Anthropic"))).toBe(before.header)
  await expect(search).toBeFocused()
  await expectEvenRows(dialog)
  await shot(page, container, testInfo.outputPath("dialog-provider-open.png"))

  // Search opens every section with a match, under a small caption.
  await search.fill("gpt")
  await expect(dialog.locator('[data-option-key="openai:gpt-6-astra"]')).toBeVisible()
  await expect(providers).toHaveCount(0)
  await expect(dialog.locator('[data-model-section="provider"] [data-slot="menu-v2-group-label"]')).toHaveText("OpenAI")
  await shot(page, container, testInfo.outputPath("dialog-search.png"))

  await search.fill("")
  await expect(header(dialog, "Anthropic")).toHaveAttribute("aria-expanded", "true")
  await header(dialog, "Anthropic").click()
  await header(dialog, "Free models inside of Vector").click()
  const free = dialog.locator('[data-option-key="vector:qwen/qwen3-coder:free"]')
  await expect(free).toBeVisible()
  await expect(free.locator('[data-slot="model-row-name"]')).toHaveText("Qwen3 Coder")
  await expect(free.locator('[data-slot="model-row-context"]')).toHaveText("262K")
  await expect(free.locator('[data-slot="model-row-training"]')).toHaveCount(0)
  await shot(page, container, testInfo.outputPath("dialog-free-models.png"))

  // The free copy on the user's own OpenRouter account sits with its paid model, named "(free)" to tell them apart.
  await header(dialog, "OpenRouter").click()
  const own = dialog.locator('[data-option-key="openrouter:qwen/qwen3-coder:free"]')
  await expect(own.locator('[data-slot="model-row-name"]')).toHaveText("Qwen3 Coder (free)")
  await expect(own).toHaveAttribute("title", /Your OpenRouter account/)
  await expect(free).toHaveAttribute("title", /Provided by Vector/)
  await expect(
    dialog.locator('[data-model-section="free"] [data-option-key="openrouter:qwen/qwen3-coder:free"]'),
  ).toHaveCount(0)

  // Chosen, the user's own copy keeps "(free)" on the composer's model button, so it never reads as Vector's copy.
  await own.click()
  await expect(dialog).toHaveCount(0)
  const button = page.locator('[data-action="prompt-model"]').filter({ visible: true }).first()
  await expect(button).toHaveText("Qwen3 Coder (free)")
  await button.click()
  const reopened = page.locator(".vector-select-model-dialog")
  await expect(
    reopened.locator('[data-option-key="recent:openrouter:qwen/qwen3-coder:free"] [data-slot="model-row-name"]'),
  ).toHaveText("Qwen3 Coder (free)")
  await expect(reopened.locator('[data-option-key="recent:openrouter:qwen/qwen3-coder:free"]')).toHaveAttribute(
    "data-active",
    "",
  )
  await page.keyboard.press("Escape")
  await expect(reopened).toHaveCount(0)
  // Vector's copy reads as the plain name. The picker remembers the free models open from before.
  await button.click()
  await expect(header(reopened, "Free models inside of Vector")).toHaveAttribute("aria-expanded", "true")
  await reopened.locator('[data-option-key="vector:qwen/qwen3-coder:free"]').click()
  await expect(button).toHaveText("Qwen3 Coder")
})

test("an external agent's own models in the popover", async ({ page }, testInfo) => {
  const workspaceId = "workspace-model-picker"
  const parent = "ses_model_picker_parent"
  await mockVectorServer(page, {
    directory,
    project: { id: "project-model-picker", worktree: directory, vcs: "git", name: "Model Picker" },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      { id: parent, title: "Parent", directory, projectID: "project-model-picker", time: { created: 1, updated: 1 } },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ directory, parent, workspaceId }) => {
      localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
      localStorage.setItem(
        "vector.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "vector.global.dat:external-agent-models",
        JSON.stringify({ picks: { "claude-code": [{ id: "sonnet", at: Date.now() - 60_000 }] } }),
      )
      const workspace = {
        id: workspaceId,
        revision: 1,
        name: "Tidy the search module",
        taskPrompt: "Tidy the search module.",
        runtime: "claude-code",
        provider: "Claude Code",
        model: "Sonnet (latest)",
        runtimeModel: "sonnet",
        sourcePath: directory,
        parentSessionId: parent,
        isolatedPath: `${directory}/claude-code`,
        isolation: "git-worktree",
        gitBranch: "test-claude-code",
        externalSessionId: "external-claude-code",
        status: "complete",
        progress: 100,
        lastAction: "Done",
        createdAt: "2026-10-23T10:00:00.000Z",
        lastActivityAt: "2026-10-23T10:01:00.000Z",
        changedFilesCount: 0,
        riskLevel: "low",
        estimatedCost: "",
        finalSummary: "Tidied.",
        mergeState: "none",
        logs: [],
        terminalOutput: [],
        browserResults: [],
        changedFiles: [],
        diff: "",
        turns: [
          {
            id: "user-1",
            role: "user",
            text: "Tidy the search module.",
            at: "2026-10-23T10:00:00.000Z",
            state: "done",
          },
          {
            id: "agent-1",
            role: "agent",
            text: "Tidied.",
            at: "2026-10-23T10:01:00.000Z",
            state: "done",
            messages: [{ id: "message-1", text: "Tidied." }],
            activity: [],
          },
        ],
      }
      const api = {
        list: async () => [structuredClone(workspace)],
        refresh: async () => structuredClone(workspace),
        setRuntimeModel: async () => structuredClone(workspace),
      }
      Object.defineProperty(window, "api", { configurable: true, value: { parallelWorkspaces: api } })
    },
    { directory, parent, workspaceId },
  )
  await page.goto(
    `/parallel-workspaces/${workspaceId}?${new URLSearchParams({ project: directory, parentSession: parent })}`,
  )
  const chip = page
    .locator("[data-agent-chat-composer]")
    .getByRole("button", { name: "Claude Code model: Sonnet (latest)", exact: true })
  await expect(chip).toBeVisible()
  await chip.click()
  const picker = page.locator(".vector-model-popover")
  await expect(picker).toBeVisible()
  await expect(picker.locator('[data-model-section="recent"]')).toContainText("Sonnet (latest)")
  // The runtime's own list never closes, so its name is a caption, and there is no provider to connect.
  await expect(picker.locator('[data-model-section="provider"] [data-slot="menu-v2-group-label"]')).toHaveText(
    "Claude Code",
  )
  await expect(picker.locator("button[data-model-section-toggle]")).toHaveCount(0)
  await expect(picker.getByText("Connect provider")).toHaveCount(0)
  expect(
    await contrast(picker.locator('[data-model-section="provider"] [data-slot="menu-v2-group-label"]')),
  ).toBeGreaterThanOrEqual(4.5)
  await expect(picker.getByRole("searchbox")).toBeFocused()
  await expectEvenRows(picker)
  await shot(page, picker, testInfo.outputPath("runtime-popover.png"))

  await page.keyboard.type("opus")
  await expect(picker.locator('[data-model-section="recent"]')).toHaveCount(0)
  await expect(picker.getByRole("menuitemradio", { name: "Opus (latest), Claude Code", exact: true })).toHaveAttribute(
    "data-active",
    "",
  )
  await shot(page, picker, testInfo.outputPath("runtime-popover-search.png"))
})
