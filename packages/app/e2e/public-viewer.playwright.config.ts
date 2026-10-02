import { defineConfig, devices } from "@playwright/test"
import { fileURLToPath } from "node:url"

const port = Number(process.env.PLAYWRIGHT_VIEWER_PORT ?? 3001)
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: "./regression",
  testMatch: "public-share-viewer.spec.ts",
  outputDir: "./test-results/public-viewer",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["html", { outputFolder: "playwright-report/public-viewer", open: "never" }], ["line"]],
  webServer: {
    command:
      "bun run --cwd ../web build && node ../../script/prune-vector-site.mjs && bun e2e/utils/serve-public-viewer.ts",
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { PLAYWRIGHT_VIEWER_PORT: String(port) },
  },
  use: { baseURL, trace: "on-first-retry", screenshot: "only-on-failure", video: "retain-on-failure" },
  projects: [{ name: "public-viewer", use: { ...devices["Desktop Chrome"] } }],
})
