import { expect, test } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/SessionCostReadout"
const sessionID = "ses_session_cost_readout"
const project = { id: "project-session-cost-readout", worktree: directory, vcs: "git", name: "Session cost readout" }
const tokens = { input: 4000, output: 600, reasoning: 0, cache: { read: 0, write: 0 } }

test("the session cost pill is muted with a faint fill", async ({ page }) => {
  const model = { providerID: "anthropic", modelID: "maker/text" }
  await mockVectorServer(page, {
    directory,
    project,
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: sessionID,
        title: "Session cost readout",
        directory,
        projectID: project.id,
        time: { created: 1, updated: 1 },
        cost: 0.05,
        tokens,
      },
    ],
    pageMessages: () => ({
      items: [
        {
          info: { id: "msg_u", role: "user", sessionID, agent: "build", model, time: { created: 1 } },
          parts: [{ id: "p_u", messageID: "msg_u", sessionID, type: "text", text: "Fix the total" }],
        },
        {
          info: {
            id: "msg_a",
            role: "assistant",
            sessionID,
            parentID: "msg_u",
            agent: "build",
            mode: "build",
            ...model,
            time: { created: 2, completed: 3 },
            path: { cwd: directory, root: directory },
            cost: 0.05,
            tokens,
            finish: "stop",
          },
          parts: [{ id: "p_a", messageID: "msg_a", sessionID, type: "text", text: "Done." }],
        },
      ],
    }),
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

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, "Session cost readout")
  const readout = page.locator('[data-component="session-cost-readout"]')
  await expect(readout).toBeVisible()
  const style = await readout.evaluate((element) => ({
    text: getComputedStyle(element).color,
    background: getComputedStyle(element).backgroundColor,
  }))
  // white/* utilities resolved to nothing here: full-brightness text and no fill.
  const alpha = (color: string) => {
    const parts = color.match(/[\d.]+/g) ?? []
    return color.startsWith("color(") ? Number(parts.at(-1)) : parts.length > 3 ? Number(parts[3]) : 1
  }
  expect(alpha(style.text), style.text).toBeLessThan(0.7)
  expect(alpha(style.background), style.background).toBeGreaterThan(0)
})
