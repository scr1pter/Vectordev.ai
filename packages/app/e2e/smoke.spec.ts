import { expect, test } from "@playwright/test"

// The demo-path tests run as a returning user (tour seen, onboarding dismissed);
// onboarding itself has its own first-run test below.
const RETURNING_USER = () => localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))

// First launch: the spotlight tour greets new users over the real app, Next
// walks the actual steps, and skipping sticks across reloads. The step copy
// asserted here comes from features/onboarding/spotlight-steps.ts — keep the two
// in step, because this test is the only thing that catches the tour breaking.
test("first run shows the tour and skipping persists", async ({ page }) => {
  await page.goto("/")
  const skip = page.getByRole("button", { name: "Skip tour" })
  await expect(skip).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText("Welcome to Vector")).toBeVisible()
  await expect(page.getByText("Let's walk the whole workspace.")).toBeVisible()

  // Next advances through the real steps, each one lighting up a live control.
  await page.getByRole("button", { name: "Next" }).click()
  await expect(page.getByText("Home is where every project starts.")).toBeVisible()
  await page.getByRole("button", { name: "Next" }).click()
  await expect(page.getByText("Start building.")).toBeVisible()

  await skip.click()
  await expect(skip).not.toBeVisible()

  await page.reload()
  // Anchored to home's own container rather than a nav label: the sidebar's
  // "Getting started" entry was removed when the shell was rebuilt, and this
  // assertion silently outlived it.
  await expect(page.locator("[data-vector-home-overview]")).toBeVisible()
  // Skipped: the tour must NOT auto-open again.
  await page.waitForTimeout(1_500)
  await expect(page.getByRole("button", { name: "Skip tour" })).not.toBeVisible()
})
