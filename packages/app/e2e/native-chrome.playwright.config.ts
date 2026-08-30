import { defineConfig, devices } from "@playwright/test"

// These tests exercise the shipped chrome CSS on isolated documents; no app server is needed.
export default defineConfig({
  testDir: "./regression",
  testMatch: "native-window-chrome.spec.ts",
  outputDir: "./test-results/native-chrome",
  workers: 1,
  reporter: "line",
  use: { ...devices["Desktop Chrome"], screenshot: "only-on-failure" },
})
