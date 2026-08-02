import { expect, test } from "@playwright/test"

// The demo-path tests run as a returning user (tour seen, onboarding dismissed);
// onboarding itself has its own first-run test below.
const RETURNING_USER = () => localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))

// First launch: the tour greets new users over the real app, Next walks the
// actual surfaces, and skipping sticks across reloads.
test("first run shows the tour and skipping persists", async ({ page }) => {
  await page.goto("/")
  const skip = page.getByRole("button", { name: "Skip tour" })
  await expect(skip).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText("Welcome to")).toBeVisible()

  // Next narrates the next surface — and navigates the real app behind it.
  await page.getByRole("button", { name: "Next" }).click()
  await expect(page.getByText("Vector builds it.")).toBeVisible()
  await page.getByRole("button", { name: "Next" }).click()
  await expect(page).toHaveURL(/browser-agent/)

  await skip.click()
  await expect(skip).not.toBeVisible()

  await page.reload()
  await expect(page.getByText("Getting started")).toBeVisible()
  // Skipped: the tour must NOT auto-open again.
  await page.waitForTimeout(1_500)
  await expect(page.getByRole("button", { name: "Skip tour" })).not.toBeVisible()
})
