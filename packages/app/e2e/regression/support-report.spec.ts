import { expect, test } from "@playwright/test"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const fixture = "/e2e/fixtures/support-report.html"

test("crash report is a local editable draft; failure is retryable and success is explicit", async ({ page }) => {
  const reports: Array<{ message: string; email?: string }> = []
  await page.route("**/api/support/bug-report", async (route) => {
    reports.push(route.request().postDataJSON())
    await route.fulfill({ status: reports.length === 1 ? 503 : 200, json: { delivered: reports.length > 1 } })
  })
  await page.goto(fixture)
  await page.getByRole("button", { name: "Report this issue" }).click()
  await expect(page.getByLabel("Bug report")).toHaveValue(/Synthetic renderer crash/)
  expect(reports).toHaveLength(0)
  await page.getByLabel("Bug report").fill("Reviewed crash details\nOnly the intended text")
  await page.getByLabel("Reply email (optional)").fill("fixture@example.invalid")
  await page.getByRole("button", { name: "Report", exact: true }).click()
  await expect(page.getByText("Vector could not reach the report service.")).toBeVisible()
  await expect(page.getByLabel("Bug report")).toHaveValue("Reviewed crash details\nOnly the intended text")
  await page.getByRole("button", { name: "Report", exact: true }).click()
  await expect(page.getByText("Thanks — report sent")).toBeVisible()
  expect(reports).toEqual([
    { message: "Reviewed crash details\nOnly the intended text", email: "fixture@example.invalid" },
    { message: "Reviewed crash details\nOnly the intended text", email: "fixture@example.invalid" },
  ])
  await page.getByRole("button", { name: "Close", exact: true }).click()
  await page.getByRole("button", { name: "Report this issue" }).click()
  await expect(page.getByLabel("Bug report")).toHaveValue(/Synthetic renderer crash/)
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  expect(reports).toHaveLength(2)
})

test("public support form preserves failures and posts only on explicit submit", async ({ page }) => {
  const reports: unknown[] = []
  await page.route("**/api/support/bug-report", async (route) => {
    reports.push(route.request().postDataJSON())
    await route.fulfill({
      status: reports.length === 1 ? 503 : 200,
      json:
        reports.length === 1
          ? { error: { message: "Support is temporarily unavailable." } }
          : { delivered: reports.length > 2 },
    })
  })
  await page.goto(`${fixture}?mode=form`)
  await page.getByLabel("Your report").fill("Manual support report")
  expect(reports).toHaveLength(0)
  await page.getByRole("button", { name: "Send report" }).click()
  await expect(page.getByRole("status")).toHaveText("Support is temporarily unavailable.")
  await expect(page.getByLabel("Your report")).toHaveValue("Manual support report")
  await page.getByRole("button", { name: "Send report" }).click()
  await expect(page.getByRole("status")).toHaveText(
    "Vector could not confirm report delivery. Your draft is still here.",
  )
  await expect(page.getByLabel("Your report")).toHaveValue("Manual support report")
  await page.getByRole("button", { name: "Send report" }).click()
  await expect(page.getByRole("status")).toContainText("Report sent.")
  expect(reports).toEqual(Array.from({ length: 3 }, () => ({ message: "Manual support report" })))
})

test("browser crash draft goes to the exact Vector popup without report text in the URL", async ({ page, context }) => {
  await context.route("https://vectordev.ai/support/report", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<body><p id="draft"></p><script>window.addEventListener("message", event => { if (event.source === window.opener && event.data.type === "vector:support-draft") document.querySelector("#draft").textContent = event.data.message }); window.opener.postMessage({type:"vector:support-ready"}, "*");</script></body>`,
    }),
  )
  await page.goto(`${fixture}?mode=web`)
  const popupReady = page.waitForEvent("popup")
  await page.getByRole("button", { name: "Report this issue" }).click()
  const popup = await popupReady
  expect(popup.url()).toBe("https://vectordev.ai/support/report")
  await expect(popup.locator("#draft")).toContainText("Synthetic renderer crash")
})

test("terminal crash keeps its draft local until the user opens the exact public support form", async ({
  page,
  context,
}) => {
  const server = spawn(
    "bun",
    [fileURLToPath(new URL("../../../tui/test/fixtures/crash-report-server.ts", import.meta.url))],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  try {
    const address = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Terminal report fixture did not start")), 10_000)
      server.once("error", reject)
      server.stdout.once("data", (data: Buffer) => {
        clearTimeout(timeout)
        resolve(data.toString().trim())
      })
      server.once("exit", (code) => {
        clearTimeout(timeout)
        if (code) reject(new Error("Terminal report fixture failed"))
      })
    })
    const publicRequests: string[] = []
    await context.route("https://vectordev.ai/support/report", (route) => {
      publicRequests.push(route.request().url())
      return route.fulfill({
        contentType: "text/html",
        body: `<body><textarea id="draft"></textarea><script>window.addEventListener("message", event => { if (event.source === window.opener && event.data.type === "vector:support-draft") document.querySelector("#draft").value = event.data.message }); window.opener.postMessage({type:"vector:support-ready"}, "*");</script></body>`,
      })
    })
    await page.goto(address)
    await expect(page.getByLabel("Crash details")).toHaveValue("Synthetic terminal crash for browser acceptance")
    expect(publicRequests).toHaveLength(0)
    expect(page.url()).not.toContain("Synthetic")
    await page.getByLabel("Crash details").fill("Reviewed terminal details")
    const ready = page.waitForEvent("popup")
    await page.getByRole("button", { name: "Continue to Vector support" }).click()
    const popup = await ready
    expect(popup.url()).toBe("https://vectordev.ai/support/report")
    await expect(popup.locator("#draft")).toHaveValue("Reviewed terminal details")
    await expect(page.getByRole("status")).toContainText("Review it there and choose Send report.")
    expect(publicRequests).toEqual(["https://vectordev.ai/support/report"])
  } finally {
    server.kill("SIGTERM")
  }
})
