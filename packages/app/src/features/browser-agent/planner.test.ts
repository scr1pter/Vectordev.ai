import { describe, expect, test } from "bun:test"
import { createBrowserPlanner } from "./planner"
import type { BrowserAutomationRun } from "./types"

const report: BrowserAutomationRun = {
  url: "http://localhost:3000",
  finalUrl: "http://localhost:3000",
  status: 200,
  ok: true,
  title: "App",
  description: "",
  htmlBytes: 0,
  links: 0,
  scripts: 0,
  stylesheets: 0,
  checkedAt: "2026-10-11T00:00:00.000Z",
  viewport: { x: 0, y: 0, width: 800, height: 600 },
  screenshotDataUrl: "",
  console: [],
  pageErrors: [],
  actions: [],
  interactives: [],
  inputs: [],
}

describe("createBrowserPlanner", () => {
  test("plans in one helper session that stays out of session lists", async () => {
    const created: { title: string; internal: string; parentID?: string }[] = []
    const parent = { id: "ses_task" }
    const prompted: string[] = []
    const planner = createBrowserPlanner({
      createClient: () => ({
        session: {
          create: async (input) => {
            created.push({ title: input.title, internal: input.internal, parentID: input.parentID })
            return { data: { id: `ses_planner_${created.length}` } }
          },
          prompt: async (input) => {
            prompted.push(input.sessionID)
            return { data: { text: JSON.stringify({ summary: "Done", complete: true, actions: [] }) } }
          },
        },
      }),
      resolveDirectory: async () => "/w/project",
      parentID: () => parent.id,
      model: () => ({ providerID: "anthropic", modelID: "claude-sonnet-4-5" }),
    })

    expect((await planner.plan("Check the login page", report, [])).complete).toBe(true)
    await planner.plan("Check the login page", report, ["click #login"])
    expect(created).toEqual([
      { title: "Browser Agent Planner", internal: "browser-agent.planner", parentID: "ses_task" },
    ])
    expect(prompted).toEqual(["ses_planner_1", "ses_planner_1"])

    // A new conversation gets its own helper session; the old one is kept, so what it spent stays in usage.
    parent.id = "ses_other_task"
    await planner.plan("Check the signup page", report, [])
    expect(created.map((session) => session.internal)).toEqual(["browser-agent.planner", "browser-agent.planner"])
    expect(prompted.at(-1)).toBe("ses_planner_2")
    expect(created.at(-1)?.parentID).toBe("ses_other_task")
    planner.reset()
  })
})
