import { expect, test } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/PullRequestsSignIn"
const sessionID = "ses_pull_requests_sign_in"

// The Pull Requests panel signs in to GitHub inside Vector (GitHub's device code) and never asks the user to
// install or sign in to the GitHub CLI.
test("Pull Requests signs in to GitHub in Vector and then lists pull requests", async ({ page }, testInfo) => {
  await mockVectorServer(page, {
    directory,
    project: { id: "project-pull-requests", worktree: directory, vcs: "git", name: "Pull Requests" },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: sessionID,
        title: "Pull requests sign-in",
        directory,
        projectID: "project-pull-requests",
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript((projectDirectory) => {
    localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
    localStorage.setItem(
      "vector.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: projectDirectory, expanded: true }] },
        lastProject: { local: projectDirectory },
      }),
    )
    const state = { signedIn: false }
    const pullRequest = {
      number: 482,
      title: "Bind workspace trust to a folder fingerprint",
      author: "mira",
      state: "OPEN",
      isDraft: false,
      baseRefName: "main",
      headRefName: "security-boundaries",
      additions: 278,
      deletions: 31,
      changedFiles: 6,
      url: "https://github.com/acme/app/pull/482",
      updatedAt: "2026-10-08T10:00:00Z",
    }
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        pullRequests: {
          status: async () =>
            state.signedIn
              ? {
                  authenticated: true,
                  configured: true,
                  login: "mira",
                  source: "vector",
                  detail: "Signed in to GitHub as mira.",
                }
              : { authenticated: false, configured: true, detail: "Sign in to GitHub to load pull requests." },
          list: async () => (state.signedIn ? [pullRequest] : []),
          view: async () => ({
            ...pullRequest,
            body: "Trust follows the folder's fingerprint instead of its path.",
            files: [{ path: "packages/engine/src/project/trust.ts", additions: 94, deletions: 12 }],
            comments: [{ author: "devon", body: "Does this cover hooks?", createdAt: "2026-10-08T10:30:00Z" }],
            headRefOid: "a".repeat(40),
            baseRefOid: "b".repeat(40),
            isCrossRepository: false,
          }),
        },
        ci: { runs: async () => ({ ok: true, repo: {}, runs: [] }) },
        github: {
          auth: {
            status: async () => ({ configured: true, authenticated: state.signedIn }),
            start: async () => ({
              userCode: "WDJB-MJHT",
              verificationUri: "https://github.com/login/device",
              expiresIn: 900,
            }),
            openVerification: async () => undefined,
            complete: () =>
              new Promise((resolve) =>
                setTimeout(() => {
                  state.signedIn = true
                  resolve({ ok: true, login: "mira" })
                }, 600),
              ),
            cancel: async () => undefined,
            logout: async () => {
              state.signedIn = false
            },
          },
        },
      },
    })
  }, directory)

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, "Pull requests sign-in")
  await page.locator('[data-tour="nav-pull-requests"]').click()

  const panel = page.getByRole("dialog", { name: "Pull Requests" })
  await expect(panel.getByText("Connect GitHub", { exact: true }).first()).toBeVisible()
  await expect(panel).not.toContainText("GitHub CLI")
  await expect(panel).not.toContainText("gh auth login")
  await page.screenshot({ path: testInfo.outputPath("signed-out.png") })
  await testInfo.attach("signed-out", { path: testInfo.outputPath("signed-out.png"), contentType: "image/png" })

  await panel.getByRole("button", { name: "Connect GitHub" }).click()
  await expect(panel.getByText("WDJB-MJHT")).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("device-code.png") })
  await testInfo.attach("device-code", { path: testInfo.outputPath("device-code.png"), contentType: "image/png" })

  await expect(panel.getByText("Bind workspace trust to a folder fingerprint")).toBeVisible()
  await expect(panel).toContainText("@mira")
  await expect(panel.getByRole("button", { name: "Sign out of GitHub" })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("signed-in.png") })
  await testInfo.attach("signed-in", { path: testInfo.outputPath("signed-in.png"), contentType: "image/png" })

  // Opening a pull request shows what it changes and offers a Vectorscope review; nothing is posted from here.
  await panel.getByText("Bind workspace trust to a folder fingerprint").click()
  const vectorscope = panel.getByRole("region", { name: "Vectorscope" })
  await expect(vectorscope).toContainText("Not reviewed yet")
  await expect(vectorscope.getByRole("button", { name: "Review with Vector" })).toBeEnabled()
  await expect(panel).toContainText("packages/engine/src/project/trust.ts")
  await expect(panel).toContainText("Does this cover hooks?")
  await expect(panel.getByRole("button", { name: "Merge…" })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("pull-request.png") })
  await testInfo.attach("pull-request", { path: testInfo.outputPath("pull-request.png"), contentType: "image/png" })
})
