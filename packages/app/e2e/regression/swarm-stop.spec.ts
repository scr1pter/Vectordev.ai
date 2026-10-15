import { base64Encode } from "@vectordevai/core/util/encode"
import { expect, test } from "@playwright/test"
import { mockVectorServer } from "../utils/mock-server"

const directory = "/tmp/vector-swarm-stop"
const parentSessionId = "ses_swarm_stop_parent"
const runId = "swarm-stop-run"

// Launching a coordinated run opens its overlay once; the sidebar brings it back, and Stop reads as busy while the
// desktop releases the run's workspaces.
test("a closed coordinated run reopens from the sidebar and its Stop waits for the desktop", async ({
  page,
}, testInfo) => {
  await mockVectorServer(page, {
    directory,
    project: { id: "project-swarm-stop", worktree: directory, vcs: "git", name: "Swarm Stop" },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: parentSessionId,
        title: "Swarm stop parent",
        directory,
        projectID: "project-swarm-stop",
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ directory, parentSessionId, runId }) => {
      localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
      localStorage.setItem(
        "vector.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      const task = (id: string, title: string, status: string) => ({
        id,
        title,
        prompt: title,
        role: "implement",
        dependsOn: [],
        fileHints: [],
        provider: "fixture",
        model: "fixture-model",
        status,
        lastAction: status === "running" ? "Editing files" : "Waiting for dependencies",
        changedFilesCount: 0,
        riskLevel: "low",
        summary: "",
      })
      const run = {
        id: runId,
        name: "Ship the search page",
        objective: "Ship the search page",
        sourcePath: directory,
        parentSessionId,
        strategy: "balanced",
        maxAgents: 4,
        maxConcurrency: 2,
        modelPool: [{ provider: "fixture", model: "fixture-model" }],
        plannerProvider: "fixture",
        plannerModel: "fixture-model",
        status: "running",
        currentStep: "Running 1 worker",
        progress: 40,
        planSummary: "Two tasks",
        tasks: [task("build", "Build the search page", "running"), task("test", "Test the search page", "planned")],
        createdAt: "2026-10-15T10:00:00.000Z",
        updatedAt: "2026-10-15T10:01:00.000Z",
        changedFiles: [],
        diff: "",
        riskLevel: "low",
        summary: "",
        logs: [],
      }
      const calls: string[] = []
      const pending = Promise.withResolvers<void>()
      const swarmOrchestrator = {
        list: async () => [structuredClone(run)],
        stop: async (id: string) => {
          calls.push(`stop:${id}`)
          // The desktop answers once the scheduler and its workers have released their workspaces.
          await pending.promise
          run.status = "canceled"
          run.currentStep = "Swarm stopped"
          run.tasks = run.tasks.map((item) => ({ ...item, status: "canceled", lastAction: "Canceled by user" }))
          return structuredClone(run)
        },
        resume: async () => structuredClone(run),
        merge: async () => structuredClone(run),
        mergeSelection: async () => structuredClone(run),
        discard: async () => structuredClone(run),
        create: async () => structuredClone(run),
      }
      const parallelWorkspaces = {
        list: async () => [],
        refresh: async () => undefined,
      }
      Object.defineProperty(window, "api", {
        configurable: true,
        value: { parallelWorkspaces, swarmOrchestrator },
      })
      Object.defineProperty(window, "swarmStop", {
        configurable: true,
        value: { calls: () => calls, release: () => pending.resolve() },
      })
    },
    { directory, parentSessionId, runId },
  )

  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  await page.goto(
    `/server/${base64Encode(server)}/session/${parentSessionId}?${new URLSearchParams({ project: directory })}`,
  )
  const entry = page.locator("[data-vector-nav-coordinated-runs]")
  await expect(entry).toContainText("Coordinated runs")
  await expect(entry).toContainText("1 running")
  await page.screenshot({ path: testInfo.outputPath("coordinated-runs-entry.png"), animations: "disabled" })
  await entry.click()

  const overlay = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Multi-agent orchestration" }) })
  await expect(overlay.getByRole("heading", { name: "Ship the search page", exact: true })).toBeVisible()
  const stop = overlay.getByRole("button", { name: "Stop run", exact: true })
  await expect(stop).toBeEnabled()
  await stop.click()

  const stopping = overlay.getByRole("button", { name: "Stopping…", exact: true })
  await expect(stopping).toBeDisabled()
  await expect(stopping).toHaveAttribute("aria-busy", "true")
  await overlay.screenshot({ path: testInfo.outputPath("coordinated-run-stopping.png"), animations: "disabled" })
  await stopping.click({ force: true })
  const calls = () =>
    page.evaluate(() => (window as unknown as { swarmStop: { calls: () => string[] } }).swarmStop.calls())
  expect(await calls()).toEqual([`stop:${runId}`])

  await page.evaluate(() => (window as unknown as { swarmStop: { release: () => void } }).swarmStop.release())
  await expect(overlay.getByRole("button", { name: "Resume", exact: true })).toBeVisible()
  await expect(overlay.getByRole("button", { name: /^(Stop run|Stopping…)$/ })).toHaveCount(0)
  expect(await calls()).toEqual([`stop:${runId}`])

  await overlay.getByRole("button", { name: "Close orchestration", exact: true }).click()
  await expect(entry).not.toContainText("running")
  await entry.click()
  await expect(overlay.getByRole("button", { name: "Resume", exact: true })).toBeVisible()
})
