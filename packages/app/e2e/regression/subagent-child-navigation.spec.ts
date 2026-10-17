import { base64Encode } from "@vectordevai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/SubagentNavigation"
const projectID = "proj_subagent_navigation"
const parentID = "ses_subagent_parent"
const childID = "ses_subagent_child"
const parentTitle = "Parent session"
const childTitle = "Subagent child session"
// The task card describes the work; the compact workspace header uses the child session title.
const taskDescription = "Inspect child navigation"

type EventPayload = { directory: string; payload: Record<string, unknown> }

test.use({ viewport: { width: 1440, height: 900 } })

test("navigates to a subagent child session missing from the session list", async ({ page }) => {
  await setup(page)
  await openChildFromParent(page)

  await expectSessionTitle(page, childTitle)
  await expect(page.locator("[data-vector-session-title]").filter({ hasText: parentTitle })).toHaveCount(0)

  const header = page.locator("[data-vector-session-header]")
  await expect(header.getByRole("button", { name: "Toggle review", exact: true })).toBeVisible()
})

test("shows the not found fallback when the viewed session is deleted", async ({ page }) => {
  const events: EventPayload[] = []
  await setup(page, { events: () => events.splice(0, 1) })
  await openChildFromParent(page)
  await expectSessionTitle(page, childTitle)

  events.push({
    directory,
    payload: { type: "session.deleted", properties: { info: childSession() } },
  })

  await expect(page.getByText("This session cannot be found")).toBeVisible()
  await expect(page.getByRole("button", { name: "Close Tab" })).toBeVisible()
  await expect(page.locator("[data-vector-session-title]")).toHaveCount(0)
})

for (const status of ["completed", "error"] as const) {
  test(`keeps indexed child outcomes and navigation when the batch is ${status}`, async ({ page }) => {
    await setup(page, { batch: status })
    await page.goto(sessionHref(parentID))
    await expectSessionTitle(page, parentTitle)
    const chip = page.getByRole("button", { name: /CSV parser, JSON parser, YAML parser.*Show in Background tasks/ })
    await expect(chip).toHaveCount(1)
    await expect(chip).toContainText("3 agents")
    await chip.click()
    const rows = page.locator("#vector-bg-tasks .vector-bg-tasks-row")
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toBeVisible()
    await expect(rows.nth(0)).toHaveAttribute("data-status", "done")
    await expect(rows.nth(1)).toHaveAttribute("data-status", "failed")
    await expect(rows.nth(2)).toHaveAttribute("data-status", status === "error" ? "failed" : "pending")
    await expect(rows.nth(2).getByRole("button", { name: /Open YAML parser/ })).toBeDisabled()
    await page.screenshot({
      path: test.info().outputPath(`task-batch-${status}.png`),
      fullPage: true,
      animations: "disabled",
    })
    await rows
      .nth(0)
      .getByRole("button", { name: /Open CSV parser/ })
      .click()
    await expectSessionTitle(page, childTitle)
    await expect(page).toHaveURL(new RegExp(`/server/.+/session/${childID}$`))
    await page.goto(sessionHref(parentID))
    await chip.click()
    await rows
      .nth(1)
      .getByRole("button", { name: /Open JSON parser/ })
      .click()
    await expectSessionTitle(page, "JSON child session")
    await expect(page).toHaveURL(new RegExp(`/server/.+/session/${childID}_json$`))
  })
}

test("surfaces a blocked subagent alongside running siblings and opens its question", async ({ page }) => {
  await setup(page, { blocked: true })
  await page.goto(sessionHref(parentID))
  await expectSessionTitle(page, parentTitle)

  const launch = page.getByRole("button", { name: "Background tasks, 2 active, 1 waiting on you", exact: true })
  await expect(launch).toHaveAttribute("data-waiting", "true")
  const chip = page.getByRole("button", { name: /Inspect child navigation.*Show in Background tasks/ })
  await expect(chip).toHaveAttribute("data-status", "waiting")
  await expect(chip.getByText("Needs you", { exact: true })).toBeVisible()
  await launch.click()

  const panel = page.getByRole("complementary", { name: "Background tasks", exact: true })
  await panel.getByRole("button", { name: `Respond to ${taskDescription}`, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/server/.+/session/${childID}$`))
  await expectSessionTitle(page, childTitle)
  await expect(page.locator('[data-component="dock-prompt"][data-kind="question"]')).toContainText(
    "Which module should I inspect?",
  )
})

test("manages a background subagent without leaving the parent or replacing its draft", async ({ page }) => {
  await setup(page)
  const messages: unknown[] = []
  const stops: unknown[] = []
  const task = {
    id: childID,
    sessionID: childID,
    parentSessionID: parentID,
    source: "subagent",
    title: taskDescription,
    agent: "explore",
    status: "running",
    batchID: "batch_one",
    startedAt: Date.now() - 200,
    elapsedMs: 200,
    currentStep: "Reading navigation routes",
    ownedPaths: ["src/routes"],
    dependsOn: [],
    resultAvailable: false,
    attempt: 1,
    controls: { inspect: true, message: true, stop: true },
    usage: {
      cost: 0.12,
      tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      total: 120,
      toolUses: 2,
      steps: 1,
      unpricedSteps: 0,
    },
  }
  await page.route(
    (url) => url.pathname.startsWith(`/experimental/session/${parentID}/tasks`),
    async (route) => {
      const pathname = new URL(route.request().url()).pathname
      const body = pathname.endsWith("/message")
        ? (messages.push(route.request().postDataJSON()),
          { taskID: childID, messageID: "msg_steer", delivery: "steer", accepted: true })
        : pathname.endsWith("/stop")
          ? (stops.push(route.request().postDataJSON()),
            Object.assign(task, {
              status: "stopped",
              completedAt: Date.now(),
              controls: { inspect: true, message: false, stop: false },
            }),
            { tasks: [task] })
          : pathname.endsWith(`/${childID}`)
            ? {
                task,
                steps: [{ tool: "read", status: "completed", text: "Checked the parent route" }],
                output: "Navigation findings are available.",
                truncated: false,
              }
            : { tasks: [task], truncated: false }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(body),
      })
    },
  )
  await page.goto(sessionHref(parentID))
  await expectSessionTitle(page, parentTitle)
  const composer = page.locator('[data-component="prompt-input"]').last()
  await composer.fill("Keep my existing draft")
  await page.getByRole("button", { name: /Background tasks, 1 running/ }).click()
  const panel = page.getByRole("complementary", { name: "Background tasks", exact: true })
  await expect(panel.getByText("Reading navigation routes", { exact: false })).toBeVisible()
  await expect(panel.getByText("Subagent spend · $0.12", { exact: true })).toBeVisible()
  await panel.getByRole("button", { name: "Details", exact: true }).click()
  await expect(panel.getByText("Navigation findings are available.")).toBeVisible()
  await expect(panel.getByText("Owned paths: src/routes")).toBeVisible()
  await panel.getByRole("button", { name: "Ask Vector about this", exact: true }).click()
  await expect(composer).toContainText("Keep my existing draft")
  await expect(composer).toContainText(`task ${childID}`)
  await panel.getByRole("button", { name: "Talk to this subagent", exact: true }).click()
  await panel.getByLabel(`Message ${taskDescription}`, { exact: true }).fill("Check redirects too")
  await panel.getByRole("button", { name: "Close background tasks", exact: true }).click()
  await page.getByRole("button", { name: /Background tasks, 1 running/ }).click()
  await panel.getByRole("button", { name: "Talk to this subagent", exact: true }).click()
  await expect(panel.getByLabel(`Message ${taskDescription}`, { exact: true })).toHaveValue("Check redirects too")
  await panel.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(panel.getByText("Message queued for the next safe step.")).toBeVisible()
  expect(messages).toEqual([{ text: "Check redirects too", delivery: "steer" }])
  await expect(page).toHaveURL(new RegExp(`/session/${parentID}$`))
  await page.screenshot({ path: test.info().outputPath("subagent-active-controls.png"), fullPage: true, animations: "disabled" })
  await panel.getByRole("button", { name: "Stop", exact: true }).click()
  await expect.poll(() => stops.length).toBe(1)
  expect(stops[0]).toMatchObject({ taskIDs: [childID], reason: "Stopped by the user" })
  await expect(panel.getByRole("button", { name: "Finished 1", exact: true })).toBeVisible()
  await page.screenshot({
    path: test.info().outputPath("subagent-controls.png"),
    fullPage: true,
    animations: "disabled",
  })
})

async function setup(
  page: Page,
  options: { events?: () => EventPayload[]; blocked?: boolean; batch?: "completed" | "error" } = {},
) {
  await mockVectorServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "subagent-navigation",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "anthropic",
          name: "Anthropic",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["anthropic"],
      default: { providerID: "anthropic", modelID: "claude-opus-4-6" },
    },
    sessions: [
      session(parentID, parentTitle, 1700000000000),
      childSession(),
      ...(options.batch ? [session(`${childID}_json`, "JSON child session", 1700000001000, { parentID })] : []),
    ],
    pageMessages: (sessionID) => ({
      items: sessionID === parentID ? parentMessages(options.batch, options.blocked) : [],
    }),
    events: options.events,
    eventRetry: options.events ? 16 : undefined,
    sessionStatus: options.blocked ? { [childID]: { type: "busy" }, ses_sibling: { type: "busy" } } : {},
    questions: options.blocked
      ? [
          {
            id: "question-subagent",
            sessionID: childID,
            questions: [
              {
                header: "Scope",
                question: "Which module should I inspect?",
                options: [{ label: "Navigation", description: "Review child session navigation" }],
              },
            ],
          },
        ]
      : [],
  })
  // The child session resolves via /session/:id but is absent from the /session list,
  // matching a subagent session that has not been loaded into the list cache yet.
  await page.route(
    (url) => url.pathname === "/session" && url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify([session(parentID, parentTitle, 1700000000000)]),
      }),
  )
  await configurePage(page)
}

async function openChildFromParent(page: Page) {
  await page.goto(sessionHref(parentID))
  await expectSessionTitle(page, parentTitle)

  const card = page.getByRole("button", { name: new RegExp(`${taskDescription}.*Show in Background tasks`) })
  await expect(card).toBeVisible()
  // A normal click opens Background tasks; the single-agent modifier opens its session.
  await card.click({ modifiers: ["ControlOrMeta"] })

  await expect(page).toHaveURL(new RegExp(`/server/.+/session/${childID}$`), { timeout: 15_000 })
}

function session(id: string, title: string, created: number, extra?: Record<string, unknown>) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created, updated: created },
    ...extra,
  }
}

function childSession() {
  return session(childID, childTitle, 1700000001000, { parentID })
}

function parentMessages(batch?: "completed" | "error", blocked = false) {
  const userID = "msg_user_0001"
  const assistantID = "msg_assistant_0001"
  return [
    {
      info: {
        id: userID,
        sessionID: parentID,
        role: "user",
        time: { created: 1700000000000 },
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
      },
      parts: [
        {
          id: "prt_user_text_0001",
          sessionID: parentID,
          messageID: userID,
          type: "text",
          text: "Delegate work to a subagent",
        },
      ],
    },
    {
      info: {
        id: assistantID,
        sessionID: parentID,
        role: "assistant",
        time: { created: 1700000001000, completed: 1700000002000 },
        parentID: userID,
        modelID: "claude-opus-4-6",
        providerID: "anthropic",
        mode: "build",
        agent: "build",
        path: { cwd: directory, root: directory },
        cost: 0.01,
        tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      },
      parts: [
        {
          id: "prt_tool_task_0001",
          sessionID: parentID,
          messageID: assistantID,
          type: "tool",
          callID: "call_task_0001",
          tool: "task",
          state: batch
            ? {
                status: batch,
                input: {
                  tasks: [
                    { description: "CSV parser", subagent_type: "general" },
                    { description: "JSON parser", subagent_type: "general" },
                    { description: "YAML parser", subagent_type: "general" },
                  ],
                },
                ...(batch === "error"
                  ? { error: "Parent interrupted after child launch" }
                  : { output: "Mixed child outcomes", title: "Parser batch" }),
                metadata: {
                  taskBatch: 1,
                  status: batch,
                  tasks: [
                    { index: 1, sessionId: `${childID}_json`, status: "error", error: "JSON validation failed" },
                    { index: 0, sessionId: childID, status: "completed" },
                  ],
                },
                time: { start: 1700000001000, end: 1700000002000 },
              }
            : {
                status: "completed",
                input: { description: taskDescription, subagent_type: "explore" },
                output: "Subagent finished",
                title: taskDescription,
                metadata: { sessionId: childID, ...(blocked ? { status: "running", background: true } : {}) },
                time: { start: 1700000001000, end: 1700000002000 },
              },
        },
        ...(blocked
          ? [
              {
                id: "prt_tool_task_sibling",
                sessionID: parentID,
                messageID: assistantID,
                type: "tool",
                callID: "call_task_sibling",
                tool: "task",
                state: {
                  status: "completed",
                  input: { description: "Review sibling task", subagent_type: "explore" },
                  output: "Background task started",
                  title: "Review sibling task",
                  metadata: { sessionId: "ses_sibling", status: "running", background: true },
                  time: { start: 1700000001000, end: 1700000002000 },
                },
              },
            ]
          : []),
      ],
    },
  ]
}

async function configurePage(page: Page) {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  await page.addInitScript(
    ({ directory, server, sessionId }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "vector.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem("vector.window.browser.dat:tabs", JSON.stringify([{ type: "session", server, sessionId }]))
    },
    { directory, server, sessionId: parentID },
  )
}

function sessionHref(sessionID: string) {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  return `/server/${base64Encode(server)}/session/${sessionID}`
}
