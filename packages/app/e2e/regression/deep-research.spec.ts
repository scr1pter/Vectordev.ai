import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

// Deep research in the app against a mocked engine: the Mode menu and its chips, the plan card, the report card with
// its citation chips, the Sources tab and its viewer, a guest's view, and a browser whose storage fails. The engine's
// side of each (the research tools, the run store and its routes) has its own tests against the fake LLM server and
// the fake web; here the engine's answers are recorded shapes of those routes.

const directory = "C:/Vector/DeepResearch"
const projectID = "proj_deep_research"
const sessionID = "ses_deep_research"
const title = "Heat pump research"
const runID = "run_heatpumps01"
const quote = "cut heating bills by 31% in cold-climate homes"

const plan = {
  question: "How much do heat pumps cut heating bills in cold climates?",
  subquestions: ["What did field studies measure?", "How large were the savings?"],
  scope: "web+brain",
  depth: "focused",
  prefer_domains: ["nature.com"],
}

const run = {
  id: runID,
  session_id: sessionID,
  question: plan.question,
  plan,
  depth: "focused",
  scope: "web+brain",
  status: "done",
  report_document_id: "dk3m9q2xa",
  pages: 1,
  searches: 1,
  steps: 9,
  cost_usd: 0.12,
  kept: false,
  created_at: Date.UTC(2026, 9, 22),
  updated_at: Date.UTC(2026, 9, 22),
}

const source = {
  id: "S1",
  url: "https://www.nature.com/articles/heat-pumps",
  canonical_url: "https://nature.com/articles/heat-pumps",
  title: "Field trials of heat pumps",
  site: "nature.com",
  status: "read",
  signals: {
    kind: "academic",
    primary: true,
    doi: "10.1000/heat",
    data: true,
    references: true,
    paywalled: false,
    addressed_to_ai: false,
    corroborated: 0,
  },
}

const note = {
  id: "N1",
  subquestion: "2",
  claim: "Heat pumps cut bills by about a third",
  source: "S1",
  quote,
  page: 12,
  stance: "supports",
  support: true,
  created_at: 1,
}

const report = [
  "# Heat pumps in cold climates",
  "Heat pumps cut bills by about a third \\[S1 p.12\\][^N1].",
  "## Savings",
  "Confidence: High (Vector's estimate)",
  "Field trials in cold homes found large savings \\[S1 p.12\\][^N1].",
  "## Sources",
  "| | Source | Site | Status | Signals |\n|---|---|---|---|---|\n| S1 | [Field trials of heat pumps](https://www.nature.com/articles/heat-pumps) | nature.com | Read | Primary source |",
  "## Method",
  "- Searches: 1\n- Pages read: 1",
  `[^N1]: "${quote}" Field trials of heat pumps, nature.com (S1 p.12)`,
].join("\n\n")

const provider = {
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
          api: { id: "maker/text", url: "https://api.anthropic.com", npm: "@ai-sdk/anthropic" },
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
}

const tool = (id: string, name: string, state: Record<string, unknown>) => ({
  id: `prt_${id}`,
  messageID: "msg_02_assistant",
  sessionID,
  type: "tool",
  callID: `call_${id}`,
  tool: name,
  state: { time: { start: 2, end: 3 }, title: name, output: "", ...state },
})

const user = {
  info: {
    id: "msg_01_user",
    role: "user",
    sessionID,
    agent: "research",
    model: { providerID: "anthropic", modelID: "maker/text" },
    time: { created: 1 },
  },
  parts: [
    { id: "prt_user", messageID: "msg_01_user", sessionID, type: "text", text: "Research how much heat pumps save" },
  ],
}

const assistant = (parts: unknown[], completed = true) => ({
  info: {
    id: "msg_02_assistant",
    role: "assistant",
    sessionID,
    parentID: "msg_01_user",
    agent: "research",
    mode: "research",
    providerID: "anthropic",
    modelID: "maker/text",
    time: completed ? { created: 2, completed: 3 } : { created: 2 },
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(completed ? { finish: "stop" } : {}),
  },
  parts,
})

const finished = [
  tool("1_plan", "research_plan", {
    status: "completed",
    input: plan,
    metadata: { runID, plan, approved: true, answer: "start" },
  }),
  tool("2_search", "research_search", {
    status: "completed",
    input: { query: "heat pump field trial savings cold climate" },
    metadata: {
      runID,
      query: "heat pump field trial savings cold climate",
      provider: "browser",
      engine: "duckduckgo",
      results: [{ url: source.url, title: source.title, snippet: "Field trials" }],
    },
  }),
  tool("3_read", "research_read", {
    status: "completed",
    input: { url: source.url },
    metadata: { runID, source: "S1", url: source.url, status: "read" },
  }),
  tool("4_note", "research_note", {
    status: "completed",
    input: { subquestion: "2", claim: note.claim, source: "S1", quote },
    metadata: { runID, note: "N1", source: "S1", support: true },
  }),
  tool("5_report", "research_report", {
    status: "completed",
    input: { title: "Heat pumps in cold climates" },
    output: "Saved the report (version 1) with its citations, sources and method.",
    metadata: { runID, document: "dk3m9q2xa", version: 1, uncited: [], removed: [] },
  }),
]

async function setup(
  page: Page,
  input: {
    messages?: unknown[]
    questions?: unknown[]
    guest?: boolean
    path?: string
    research?: boolean
    detailReady?: Promise<void>
  } = {},
) {
  const sent = { prompts: [] as Record<string, any>[], replies: [] as unknown[], kept: 0, details: 0 }
  await mockVectorServer(page, {
    directory,
    project: { id: projectID, worktree: directory, vcs: "git", name: "Deep research" },
    provider,
    agents: [
      { name: "build", mode: "primary" },
      ...(input.research === false ? [] : [{ name: "research", mode: "primary" }]),
    ],
    sessions: [{ id: sessionID, slug: "heat", projectID, directory, title, time: { created: 1, updated: 1 } }],
    pageMessages: () => ({ items: input.messages ?? [] }),
    questions: input.questions ?? [],
  })
  const owner = (body: unknown) => (route: import("@playwright/test").Route) =>
    input.guest
      ? route.fulfill({ status: 403, json: { name: "Forbidden", data: { message: "The repository owner only" } } })
      : route.fulfill({ json: body })
  await page.route(
    /\/memory\/research(?:\?|$)/,
    owner({ runs: [{ run, sources: 1, notes: 1, bytes: 4200 }], bytes: 4200, limit: 1e9, retain: 30 }),
  )
  const detail = owner({
    run,
    sources: [source],
    notes: [note],
    queries: ["heat pump field trial savings cold climate"],
    report,
    bytes: 4200,
    guest: false,
  })
  await page.route(new RegExp(`/memory/research/${runID}(?:\\?|$)`), async (route) => {
    sent.details += 1
    await input.detailReady
    return detail(route)
  })
  await page.route(
    new RegExp(`/memory/research/${runID}/sources/S1(?:\\?|$)`),
    owner({
      source,
      chunks: [
        { chunk: 1, page: 12, text: `In field trials across Norway, heat pumps ${quote.replace("31%", "31%\n")}.` },
      ],
      private: false,
    }),
  )
  await page.route(new RegExp(`/memory/research/${runID}/keep(?:\\?|$)`), (route) => {
    sent.kept += 1
    return route.fulfill({ json: { ...run, kept: true } })
  })
  await page.route(/\/session\/[^/]+\/prompt_async(?:\?|$)/, (route) => {
    sent.prompts.push(route.request().postDataJSON())
    return route.fulfill({ status: 204, body: "" })
  })
  await page.route(/\/question\/[^/]+\/reply(?:\?|$)/, (route) => {
    sent.replies.push(route.request().postDataJSON())
    return route.fulfill({ json: true })
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
  await page.goto(input.path ?? `/${base64Encode(directory)}/session/${sessionID}`)
  if (!input.path) await expectSessionTitle(page, title)
  return sent
}

const composer = (page: Page) => page.locator('[data-component="prompt-input"]').filter({ visible: true }).first()

async function pickMode(page: Page, label: string) {
  await page.locator('[data-action="prompt-execution-mode"]').filter({ visible: true }).first().click()
  const menu = page.locator('[data-component="prompt-mode-menu"]')
  await expect(menu).toBeVisible()
  await menu.getByRole("button", { name: new RegExp(`^${label}`) }).click()
}

test("an engine without research does not offer Deep research", async ({ page }) => {
  await setup(page, { research: false })
  await page.locator('[data-action="prompt-execution-mode"]').filter({ visible: true }).first().click()
  const menu = page.locator('[data-component="prompt-mode-menu"]')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole("button", { name: /^Deep research/ })).toHaveCount(0)
})

test("the Mode menu lists Deep research under Fast, and a research message carries its agent, size and scope", async ({
  page,
}) => {
  const sent = await setup(page)
  await expect(composer(page)).toBeVisible()
  await page.locator('[data-action="prompt-execution-mode"]').filter({ visible: true }).first().click()
  const menu = page.locator('[data-component="prompt-mode-menu"]')
  await expect(menu.getByText("Mode", { exact: true })).toBeVisible()
  const labels = await menu
    .locator("button")
    .evaluateAll((items) => items.map((item) => item.querySelector("span span")?.textContent?.trim() ?? ""))
  expect(labels).toEqual(["Normal", "Quick", "Fast", "Deep researchPreview"])
  await expect(menu.getByText("Makes no code changes.")).toBeVisible()
  await page.keyboard.press("Escape")

  await pickMode(page, "Deep research")
  await expect(page.getByText("What should Vector research?").filter({ visible: true }).first()).toBeVisible()
  const chips = page.locator('[data-component="research-chips"]').filter({ visible: true }).first()
  await expect(chips).toContainText("Depth")
  await expect(chips).toContainText("Auto")
  await expect(chips).toContainText("Web and brain")
  await expect(chips).toContainText("Cap $1.00")

  await chips.getByRole("button", { name: /^Depth/ }).click()
  await page.getByRole("group", { name: "Depth", exact: true }).getByRole("button", { name: /^Deep/ }).click()
  await expect(chips).toContainText("Cap $3.00")
  await chips.getByRole("button", { name: /^Sources/ }).click()
  await page
    .getByRole("group", { name: "Sources", exact: true })
    .getByRole("button", { name: "Brain and files only" })
    .click()
  await expect(chips).toContainText("Brain and files only")

  await composer(page).click()
  await page.keyboard.type("How much do heat pumps save in Oslo?")
  await page.keyboard.press("Enter")
  await expect.poll(() => sent.prompts.length).toBe(1)
  expect(sent.prompts[0]).toMatchObject({ agent: "research", size: "thorough", executionMode: "normal" })
  expect(sent.prompts[0]!.parts[0]).toMatchObject({
    type: "text",
    text: "How much do heat pumps save in Oslo?",
    metadata: { "vector.research": { scope: "brain" } },
  })

  // A new session in this repository starts in Deep research, the last mode picked here.
  await page.goto(`/${base64Encode(directory)}/session`)
  await expect(page.locator('[data-action="prompt-execution-mode"]').filter({ visible: true }).first()).toContainText(
    "Deep research",
    { timeout: 30_000 },
  )
})

test("a greeting in Deep research takes the quick lane, with no research size", async ({ page }) => {
  const sent = await setup(page)
  await pickMode(page, "Deep research")
  await composer(page).click()
  await page.keyboard.type("hi")
  await page.keyboard.press("Enter")
  await expect.poll(() => sent.prompts.length).toBe(1)
  expect(sent.prompts[0]).toMatchObject({ agent: "quick" })
  expect(sent.prompts[0]!.size).toBeUndefined()
  expect(sent.prompts[0]!.parts[0].metadata).toBeUndefined()
})

test("a research plan opens as an editable plan card that answers with only what the user changed", async ({
  page,
}) => {
  const card = {
    deep: true,
    deepEstimate: "About 40 pages and 24 searches. Estimated $0.90–$2.80 at list prices. Cap $3.00.",
    search: { provider: "browser" },
    preferences: { prefer: ["nature.com"], avoid: [] },
    offline: false,
  }
  const sent = await setup(page, {
    messages: [
      user,
      assistant(
        [
          tool("plan", "research_plan", {
            status: "running",
            input: plan,
            metadata: {
              plan,
              estimate: "About 15 pages and 8 searches. Estimated $0.20–$0.80 at list prices. Cap $1.00.",
              card,
            },
          }),
        ],
        false,
      ),
    ],
    questions: [
      {
        id: "que_plan",
        sessionID,
        questions: [
          {
            header: "Research plan",
            question: `Research: ${plan.question}`,
            options: [
              { label: "Start", description: "Research at this depth (focused)" },
              { label: "Start deep", description: "Up to 4 researchers and a judge that checks the citations" },
              { label: "Cancel", description: "Stop without searching or reading anything" },
            ],
            custom: true,
          },
        ],
        tool: { messageID: "msg_02_assistant", callID: "call_plan" },
      },
    ],
  })
  const planCard = page.locator('[data-component="research-plan-card"]')
  await expect(planCard).toBeVisible({ timeout: 30_000 })
  await expect(planCard.getByLabel("Question", { exact: true })).toHaveValue(plan.question)
  await expect(planCard.getByLabel("Sub-question 2", { exact: true })).toHaveValue("How large were the savings?")
  await expect(planCard).toContainText("from your preferences")
  await expect(planCard).toContainText("About 15 pages and 8 searches")
  await expect(planCard).toContainText("Start deep: About 40 pages and 24 searches")
  await expect(planCard).toContainText("Search: Google, in each research agent's own browser")
  await expect(planCard).toContainText("Preview")
  await expect(planCard.getByRole("button", { name: "Start deep" })).toBeVisible()

  await planCard.getByLabel("Sub-question 2", { exact: true }).fill("How large were the savings in Nordic homes?")
  const avoid = planCard.getByLabel("Add a site to avoid")
  await avoid.fill("https://www.Example.com/page")
  await avoid.press("Enter")
  await expect(planCard).toContainText("example.com")
  await planCard.getByLabel("Always").first().check()
  await planCard.getByRole("button", { name: "Start", exact: true }).click()

  await expect.poll(() => sent.replies.length).toBe(1)
  const answer = (sent.replies[0] as { answers: string[][] }).answers[0]![0]!
  expect(answer.startsWith("vector-plan:")).toBe(true)
  expect(JSON.parse(answer.slice("vector-plan:".length))).toEqual({
    action: "start",
    plan: {
      subquestions: ["What did field studies measure?", "How large were the savings in Nordic homes?"],
      avoid_domains: ["example.com"],
    },
    always: ["avoid_domains"],
  })
})

test("a plan card that searches nothing says why, with the engine's reason alone and nothing to set up", async ({
  page,
}) => {
  // What the engine says for `vector run --research --search none`, where no set-up would change anything.
  const reason =
    "This research searches nothing on the web. It uses this repository's brain, its files and the addresses in your message."
  const card = {
    deep: false,
    search: { provider: "none", reason },
    preferences: { prefer: [], avoid: [] },
    offline: false,
  }
  await setup(page, {
    messages: [
      user,
      assistant([tool("plan", "research_plan", { status: "running", input: plan, metadata: { plan, card } })], false),
    ],
    questions: [
      {
        id: "que_plan",
        sessionID,
        questions: [
          {
            header: "Research plan",
            question: `Research: ${plan.question}`,
            options: [
              { label: "Start", description: "Research at this depth (focused)" },
              { label: "Cancel", description: "Stop without searching or reading anything" },
            ],
            custom: true,
          },
        ],
        tool: { messageID: "msg_02_assistant", callID: "call_plan" },
      },
    ],
  })
  const planCard = page.locator('[data-component="research-plan-card"]')
  await expect(planCard).toBeVisible({ timeout: 30_000 })
  await expect(planCard).toContainText("Nothing is searched on the web here.")
  await expect(planCard.getByRole("button", { name: "Set up" })).toHaveCount(0)
  await planCard.getByRole("button", { name: "Why", exact: true }).click()
  await expect(planCard).toContainText(reason)
  await expect(planCard).not.toContainText("open this repository there to search")
})

test("a pending research report keeps the session visible without repeatedly fetching it", async ({ page }) => {
  const ready = Promise.withResolvers<void>()
  try {
    const sent = await setup(page, { messages: [user, assistant(finished)], detailReady: ready.promise })
    await expect.poll(() => sent.details).toBe(1)
    await expect(page.locator('[data-component="session-composer"]')).toBeVisible()
    await expect(page.getByRole("button", { name: /^Research report / })).toBeVisible()
    ready.resolve()
    await expect(page.locator('[data-component="research-report"]')).toBeVisible()
    expect(sent.details).toBe(1)
  } finally {
    ready.resolve()
  }
})

test("a pending Sources pane keeps the session visible", async ({ page }) => {
  const ready = Promise.withResolvers<void>()
  try {
    const sent = await setup(page, { messages: [user, assistant(finished.slice(0, -1))], detailReady: ready.promise })
    await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("vector:open-research-sources", { detail })), {
      sessionID,
      runID,
    })
    await expect(page.getByRole("status").filter({ hasText: "Reading sources…" })).toBeVisible()
    await expect(page.locator('[data-component="session-composer"]')).toBeVisible()
    await expect.poll(() => sent.details).toBe(1)
    ready.resolve()
    await expect(page.locator('[data-component="research-sources"]')).toContainText("1 search so far")
    expect(sent.details).toBe(1)
  } finally {
    ready.resolve()
  }
})

test("the report card cites with chips that show their quote and open the source at that passage", async ({ page }) => {
  const sent = await setup(page, { messages: [user, assistant(finished)] })
  const card = page.locator('[data-component="research-report"]')
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card).toContainText("Heat pumps in cold climates")
  await expect(card).toContainText("This report and its sources stay private and out of later sessions")
  const chip = card.locator('[data-component="research-citation"][data-note="N1"]').first()
  await expect(chip).toHaveText("S1 p.12")
  await expect(chip).toHaveAttribute("title", new RegExp(quote))
  await expect(card).not.toContainText("[^N1]")
  const badge = card.locator('[data-component="research-confidence"]')
  await expect(badge).toHaveAttribute("data-level", "high")
  await expect(badge).toHaveAttribute("title", /^Vector's estimate\./)

  // Each research call is a one-line row: what it did, in a few words.
  for (const text of ["Research plan", "approved, focused", "Search · DuckDuckGo", "1 result", "Read S1", "Note N1"])
    await expect(page.getByText(text, { exact: true }).first()).toBeVisible()

  await chip.click()
  const sources = page.locator('[data-component="research-sources"]')
  await expect(sources).toBeVisible()
  const viewer = sources.locator('[data-component="research-viewer"]')
  await expect(viewer.locator("mark")).toContainText("cut heating bills by 31%")
  await expect(viewer).toContainText("Primary source")
  await viewer.getByRole("button", { name: "Back to sources" }).click()
  await expect(sources).toContainText("1 search so far")
  const row = sources.locator('[data-slot="research-source"]', { hasText: "Field trials of heat pumps" })
  await expect(row).toContainText("read")
  await expect(row).toContainText("N1: Heat pumps cut bills by about a third")

  await card.getByRole("button", { name: "Keep in brain" }).click()
  await expect.poll(() => sent.kept).toBe(1)
})

test("the Sources tab shows each research browser of the run as a chip, with a view-only watch and Stop", async ({
  page,
}) => {
  // The desktop's watch bridge (preload `researchWatch`), standing in for Electron: two research browsers of this
  // run and one of another, a one-pixel snapshot, and what Stop was asked to close.
  await page.addInitScript(
    (input) => {
      const state = { stopped: [] as string[], snapshots: 0, listeners: [] as (() => void)[] }
      const chips = [
        {
          id: `${input.runID}:ses_researcher2`,
          runID: input.runID,
          sessionID: "ses_researcher2",
          label: "Researcher 2",
          host: "nature.com",
          state: "reading",
        },
        {
          id: `${input.runID}:${input.sessionID}`,
          runID: input.runID,
          sessionID: input.sessionID,
          label: "Research lead",
          host: "",
          state: "idle",
        },
        {
          id: "run_other:ses_other",
          runID: "run_other",
          sessionID: "ses_other",
          label: "Researcher 1",
          host: "example.org",
          state: "browsing",
        },
      ]
      Object.assign(window, {
        __researchWatch: state,
        api: {
          researchWatch: {
            list: async () => chips.filter((chip) => !state.stopped.includes(chip.id)),
            snapshot: async () => {
              state.snapshots += 1
              return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
            },
            stop: async (id: string) => {
              state.stopped.push(id)
              state.listeners.forEach((listener) => listener())
              return true
            },
            onChange: (listener: () => void) => {
              state.listeners.push(listener)
              return () => undefined
            },
          },
        },
      })
    },
    { runID, sessionID },
  )
  await setup(page, { messages: [user, assistant(finished)] })
  // After the mock engine's routes, which answer everything else on its port.
  const aborted: string[] = []
  await page.route(/\/session\/[^/]+\/abort(?:\?|$)/, (route) => {
    aborted.push(new URL(route.request().url()).pathname)
    return route.fulfill({ json: true })
  })
  await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("vector:open-research-sources", { detail })), {
    sessionID,
    runID,
  })
  const sources = page.locator('[data-component="research-sources"]')
  const chips = sources.locator('[data-slot="research-browser-chip"]')
  await expect(chips).toHaveText(["Researcher 2 · nature.com · reading", "Research lead · idle"])

  await chips.first().click()
  const watch = sources.locator('[data-slot="research-watch"]')
  await expect(watch).toContainText("View only")
  await expect(watch.locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/)
  // About two snapshots a second while the watch is open.
  await expect
    .poll(() => page.evaluate(() => (window as any).__researchWatch.snapshots), { timeout: 5_000 })
    .toBeGreaterThan(2)

  await watch.getByRole("button", { name: "Stop researcher" }).click()
  await expect
    .poll(() => page.evaluate(() => (window as any).__researchWatch.stopped))
    .toEqual([`${runID}:ses_researcher2`])
  // Stop ends that researcher's session too; the lead keeps researching.
  await expect.poll(() => aborted).toEqual(["/session/ses_researcher2/abort"])
  await expect(chips).toHaveText(["Research lead · idle"])
})

test("a guest sees whose the sources are, and the report as a plain row", async ({ page }) => {
  await setup(page, { messages: [user, assistant(finished)], guest: true })
  await expect(page.getByText("Research report").first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-component="research-report"]')).toHaveCount(0)
  await expect(page.getByText("Sources are visible to the repository owner.").first()).toBeVisible()
  await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("vector:open-research-sources", { detail })), {
    sessionID,
    runID,
  })
  await expect(page.locator('[data-component="research-sources"]')).toContainText(
    "Sources are visible to the repository owner.",
  )
})

test("with the browser's storage failing, the composer starts in Normal and Deep research still works", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem
    const set = Storage.prototype.setItem
    Storage.prototype.getItem = function (key: string) {
      if (key.startsWith("vector.research.mode")) throw new DOMException("blocked", "SecurityError")
      return get.call(this, key)
    }
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith("vector.research.mode")) throw new DOMException("full", "QuotaExceededError")
      return set.call(this, key, value)
    }
  })
  await setup(page, { path: `/${base64Encode(directory)}/session` })
  const trigger = page.locator('[data-action="prompt-execution-mode"]').filter({ visible: true }).first()
  await expect(trigger).toContainText("Normal", { timeout: 30_000 })
  await pickMode(page, "Deep research")
  await expect(trigger).toContainText("Deep research")
  await expect(page.getByText("What should Vector research?").filter({ visible: true }).first()).toBeVisible()
  await expect(page.getByText("Something went wrong")).toHaveCount(0)
})

test("Settings > Memory > Research lists the repository's runs, opens a report and forgets one source", async ({
  page,
}) => {
  await setup(page, { messages: [user, assistant(finished)] })
  // After the mock engine's routes: the Memory page's own, and forgetting a source.
  const forgotten: string[] = []
  await page.route(new RegExp(`/memory/research/${runID}/sources/S1(?:\\?|$)`), (route) => {
    if (route.request().method() !== "DELETE") return route.fallback()
    forgotten.push("S1")
    return route.fulfill({ json: true })
  })
  await page.route(/\/memory(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        entries: [],
        stats: { active: 0, review: 0, archived: 0, rules: 0, learned: 0, digestTokens: 0, learning: true },
        files: { memory: "", rules: "", repository: [] },
        held: false,
      },
    }),
  )
  await page.route(/\/memory\/settings(?:\?|$)/, (route) =>
    route.fulfill({ json: { learning: true, repositoryDocs: true, keepOriginals: false } }),
  )
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-workspace")
  await settings.getByRole("tab", { name: "Memory", exact: true }).click()
  await settings.getByRole("tab", { name: "Research", exact: true }).click()
  const row = settings.locator('[data-component="settings-memory-research-run"]')
  await expect(row).toContainText(plan.question)
  await expect(row).toContainText("1 source · 1 note · 4 KB")
  await expect(row).toContainText("Not kept")
  await row.getByRole("button", { name: "Open the report" }).click()
  await expect(row).toContainText("Heat pumps in cold climates")
  await row.getByRole("button", { name: "Forget source" }).click()
  await expect.poll(() => forgotten).toEqual(["S1"])
  await expect(settings).toContainText("Forgot S1.")
})
