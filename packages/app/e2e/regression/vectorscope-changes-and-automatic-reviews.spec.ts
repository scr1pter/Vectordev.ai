import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/VectorscopeLocal"
const sessionID = "ses_vectorscope_local"
const project = { id: "project-vectorscope-local", worktree: directory, vcs: "git", name: "Vectorscope Local" }
const SECRETS_URL = "https://github.com/acme/app/settings/secrets/actions"

type AutomaticState = "available" | "installed" | "on-request" | "needs-scope"

// The panel through the desktop bridge, signed in to GitHub with no open pull requests. Automatic reviews start in the
// given state; setting them up opens pull request #12 and leaves it pending.
async function openVectorscope(page: Page, input: { changes?: () => unknown[]; automatic?: AutomaticState }) {
  await mockVectorServer(page, {
    directory,
    project,
    provider: {
      all: [
        {
          id: "anthropic",
          name: "Anthropic",
          source: "env",
          env: ["ANTHROPIC_API_KEY"],
          models: {
            "claude-sonnet-4-5": {
              id: "claude-sonnet-4-5",
              name: "Claude Sonnet 4.5",
              cost: { input: 3, output: 15 },
              limit: { context: 200_000 },
            },
          },
        },
      ],
      connected: ["anthropic"],
      default: { anthropic: "claude-sonnet-4-5" },
    },
    sessions: [
      { id: sessionID, title: "Vectorscope local", directory, projectID: project.id, time: { created: 1, updated: 1 } },
    ],
    pageMessages: () => ({ items: [] }),
    ...(input.changes ? { vcsStatus: input.changes } : {}),
  })
  await page.addInitScript(
    (setup) => {
      localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
      localStorage.setItem(
        "vector.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: setup.directory, expanded: true }] },
          lastProject: { local: setup.directory },
        }),
      )
      const calls = { preview: [] as unknown[], setup: [] as unknown[], start: [] as unknown[] }
      const state = { automatic: setup.automatic as string, signedIn: true }
      const secrets = [
        {
          name: "VECTOR_CLI_TOKEN",
          detail: "Signs the workflow in to your Vector account.",
          url: "https://vectordev.ai/auth/cli",
        },
        { name: "ANTHROPIC_API_KEY", detail: "Your model provider's API key." },
      ]
      Object.defineProperty(window, "__vectorscopeCalls", { value: calls })
      Object.defineProperty(window, "api", {
        configurable: true,
        value: {
          pullRequests: {
            status: async () =>
              state.signedIn
                ? { authenticated: true, configured: true, login: "mira", source: "vector", detail: "" }
                : { authenticated: false, configured: true, detail: "Sign in to GitHub to load pull requests." },
            list: async () => [],
            autoReview: {
              status: async () => ({
                state: state.automatic,
                repo: "acme/app",
                defaultBranch: "main",
                secretsUrl: setup.secretsUrl,
                source: "vector",
                ...(state.automatic === "installed" || state.automatic === "on-request"
                  ? { url: "https://github.com/acme/app/blob/main/.github/workflows/vector.yml" }
                  : {}),
                ...(state.automatic === "pending" ? { url: "https://github.com/acme/app/pull/12" } : {}),
              }),
              preview: async (request: { model: string; keys: string[] }) => {
                calls.preview.push(request)
                return {
                  path: ".github/workflows/vector.yml",
                  content:
                    "name: vector\n\non:\n  pull_request:\n    types: [opened, synchronize, reopened, ready_for_review]\n",
                  model: request.model,
                  monthlyUsd: 50,
                  secrets,
                }
              },
              setup: async (request: unknown) => {
                calls.setup.push(request)
                state.automatic = "pending"
                return {
                  url: "https://github.com/acme/app/pull/12",
                  number: 12,
                  branch: "vector-automatic-reviews",
                  secrets,
                  secretsUrl: setup.secretsUrl,
                }
              },
            },
          },
          ci: { runs: async () => ({ ok: true, runs: [] }) },
          github: {
            auth: {
              status: async () => ({ configured: true, authenticated: state.signedIn }),
              start: async (input?: unknown) => {
                calls.start.push(input ?? null)
                return { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresIn: 900 }
              },
              openVerification: async () => undefined,
              // GitHub authorizes the code when the test calls __authorizeGithub; the new sign-in may change workflows.
              complete: () =>
                new Promise((resolve) =>
                  Object.defineProperty(window, "__authorizeGithub", {
                    configurable: true,
                    value: () => {
                      state.signedIn = true
                      state.automatic = "available"
                      resolve({ ok: true, login: "mira" })
                    },
                  }),
                ),
              cancel: async () => undefined,
              logout: async () => {
                state.signedIn = false
              },
            },
          },
        },
      })
    },
    { directory, automatic: input.automatic ?? "available", secretsUrl: SECRETS_URL },
  )

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, "Vectorscope local")
  await page.locator('[data-tour="nav-pull-requests"]').click()
  return page.getByRole("dialog", { name: "Vectorscope" })
}

function calls(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __vectorscopeCalls: { preview: unknown[]; setup: unknown[] } }).__vectorscopeCalls,
  )
}

test("Vectorscope offers a review of uncommitted changes only when there are some", async ({ page }, testInfo) => {
  const changes: { file: string; additions: number; deletions: number; status: string }[] = []
  const panel = await openVectorscope(page, { changes: () => changes })

  const yours = panel.getByRole("button", { name: /Your changes/ })
  await expect(yours).toContainText("No uncommitted changes")
  await yours.click()
  await expect(panel.getByRole("heading", { name: "Your changes" })).toBeVisible()
  await expect(panel.getByText("Vectorscope reviews what you haven't committed yet")).toBeVisible()
  await expect(panel.getByRole("button", { name: "Review my changes" })).toHaveCount(0)

  changes.push(
    { file: "src/list.ts", additions: 3, deletions: 1, status: "modified" },
    { file: "src/total.ts", additions: 10, deletions: 0, status: "added" },
  )
  await panel.getByRole("button", { name: "Check again" }).click()
  await expect(yours).toContainText("2 uncommitted files · +13 −1")
  const review = panel.getByRole("region", { name: "AI review" })
  await expect(review).toContainText("Not reviewed yet")
  await expect(review).toContainText("Nothing is posted anywhere.")
  await expect(review.getByRole("button", { name: "Review my changes" })).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath("your-changes.png") })
  await testInfo.attach("your-changes", { path: testInfo.outputPath("your-changes.png"), contentType: "image/png" })
})

test("Vectorscope opens the automatic-review pull request only after showing what it adds", async ({
  page,
}, testInfo) => {
  const panel = await openVectorscope(page, {})

  await panel.getByRole("button", { name: /Set up automatic reviews/ }).click()
  await expect(panel).toContainText("Nothing changes in acme/app until someone merges the pull request.")
  await expect(panel).toContainText("anthropic/claude-sonnet-4-5")
  await expect(panel).toContainText("VECTOR_CLI_TOKEN")
  await expect(panel).toContainText("ANTHROPIC_API_KEY")
  expect((await calls(page)).preview).toEqual([{ model: "anthropic/claude-sonnet-4-5", keys: ["ANTHROPIC_API_KEY"] }])
  expect((await calls(page)).setup).toEqual([])
  await page.screenshot({ path: testInfo.outputPath("confirm.png") })
  await testInfo.attach("confirm", { path: testInfo.outputPath("confirm.png"), contentType: "image/png" })

  await panel.getByRole("button", { name: "Open the pull request" }).click()
  await expect(panel).toContainText("Pull request #12 is open.")
  await expect(panel.getByRole("link", { name: /Open Actions secrets/ })).toHaveAttribute("href", SECRETS_URL)
  expect((await calls(page)).setup).toEqual([
    { cwd: directory, model: "anthropic/claude-sonnet-4-5", keys: ["ANTHROPIC_API_KEY"] },
  ])
  await expect(panel.getByRole("button", { name: /Automatic reviews/ })).toContainText(
    "A pull request that turns them on is open",
  )
  await page.screenshot({ path: testInfo.outputPath("opened.png") })
  await testInfo.attach("opened", { path: testInfo.outputPath("opened.png"), contentType: "image/png" })
})

test("Vectorscope says automatic reviews are on instead of offering to set them up", async ({ page }) => {
  const panel = await openVectorscope(page, { automatic: "installed" })

  const entry = panel.getByRole("button", { name: /Automatic reviews/ })
  await expect(entry).toContainText("On: every pull request is reviewed")
  await expect(panel.getByRole("button", { name: /Set up automatic reviews/ })).toHaveCount(0)
  await entry.click()
  await expect(panel).toContainText("Automatic reviews are set up")
  await expect(panel.getByRole("link", { name: /View the workflow/ })).toHaveAttribute(
    "href",
    "https://github.com/acme/app/blob/main/.github/workflows/vector.yml",
  )
  await expect(panel.getByRole("button", { name: "Open the pull request" })).toHaveCount(0)
  expect((await calls(page)).preview).toEqual([])
})

test("Vectorscope asks for GitHub's workflow permission only to set up automatic reviews", async ({ page }) => {
  const panel = await openVectorscope(page, { automatic: "needs-scope" })

  await panel.getByRole("button", { name: /needs permission to change workflows/ }).click()
  await expect(panel).toContainText("Vector needs permission to change workflows")
  expect((await calls(page)).start).toEqual([])
  await panel.getByRole("button", { name: "Sign in again" }).click()
  // The sign-in that follows starts by itself and is the only one that asks for the workflow permission.
  await expect(panel.getByText("WDJB-MJHT")).toBeVisible()
  await expect(panel).toContainText("GitHub also asks to let Vector change workflow files")
  expect((await calls(page)).start).toEqual([{ workflow: true }])

  // Once GitHub authorizes it, the view goes straight on to what setting them up adds, ready to confirm.
  await page.evaluate(() => (window as unknown as { __authorizeGithub: () => void }).__authorizeGithub())
  await expect(panel.getByText("Show the workflow file")).toBeVisible()
  await expect(panel.getByRole("button", { name: "Open the pull request" })).toBeEnabled()
  expect((await calls(page)).preview).toEqual([{ model: "anthropic/claude-sonnet-4-5", keys: ["ANTHROPIC_API_KEY"] }])
})

test("Vectorscope says when reviews only run on a /vector review comment", async ({ page }) => {
  const panel = await openVectorscope(page, { automatic: "on-request" })

  const entry = panel.getByRole("button", { name: /Automatic reviews/ })
  await expect(entry).toContainText("On: when someone comments /vector review")
  await entry.click()
  await expect(panel).toContainText("Reviews run when someone asks")
  await expect(panel).toContainText("choose to review every pull request")
  await expect(panel.getByRole("button", { name: "Open the pull request" })).toHaveCount(0)
  expect((await calls(page)).preview).toEqual([])
})
