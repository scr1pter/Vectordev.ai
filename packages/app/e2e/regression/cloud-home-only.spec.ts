import { expect, test } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/CloudHomeOnly"
const sessionID = "ses_cloud_home_only"
const prompt = "Add sign-in with a users table"

test("Vector Cloud opens from Home, and a task's view has no Cloud controls", async ({ page }, testInfo) => {
  const prompts: unknown[] = []
  await mockVectorServer(page, {
    directory,
    project: { id: "project-cloud-home-only", worktree: directory, vcs: "git", name: "Cloud Home Only" },
    // A model has to be selected for a prompt to get as far as the database proposal used to.
    provider: {
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
    },
    sessions: [
      {
        id: sessionID,
        title: prompt,
        directory,
        projectID: "project-cloud-home-only",
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.route(/\/session\/[^/]+\/prompt_async(?:\?|$)/, (route) => {
    prompts.push(route.request().postDataJSON())
    return route.fulfill({ status: 204, body: "" })
  })
  await page.addInitScript((projectDirectory) => {
    // The desktop's Cloud bridge, which every task view used to read for its Cloud button.
    Object.assign(window, {
      api: {
        cloud: {
          overview: async (path: string) => ({
            projectPath: path,
            directory: path,
            hosting: { provider: "Vercel", connected: false },
            database: { provider: "Supabase", accountConnected: false, connected: false },
          }),
          onChange: () => () => undefined,
        },
      },
    })
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
  await expectSessionTitle(page, prompt)
  // An absence check passes at once, so wait until the header tools have rendered: the review toggle sits in the
  // same row the Cloud button rendered in, after the launch screen goes.
  await expect(page.locator("#vector-launch")).toHaveCount(0)
  const controls = page.locator("[data-vector-session-controls]")
  await expect(controls.getByRole("button", { name: "Toggle review" })).toBeVisible()
  await expect(controls.getByRole("button", { name: /Vector Cloud/ })).toHaveCount(0)
  await expect(page.locator(".vx-cloud-launch")).toHaveCount(0)
  await expect(page.locator("[data-vector-cloud-card]")).toHaveCount(0)

  // The database proposal used to appear as soon as a prompt about sign-in or data was sent.
  await page.locator('[data-component="prompt-input"]').filter({ visible: true }).first().click()
  await page.keyboard.type(prompt)
  await page.keyboard.press("Enter")
  await expect.poll(() => prompts.length).toBe(1)
  await expect(page.getByText("This looks like it needs a database")).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath("task-view.png") })

  await page.goto("/")
  const cloud = page.getByRole("button", { name: "Vector Cloud", exact: true })
  await expect(cloud).toBeVisible()
  await cloud.click()
  await expect(page).toHaveURL(/\/cloud/)
  await expect(page.locator("[data-vector-cloud-home]")).toBeVisible()
  await expect(page.locator("#vector-launch")).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath("cloud-from-home.png") })
})
