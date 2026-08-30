import { expect, test } from "@playwright/test"

// The demo-path tests run as a returning user (tour seen, onboarding dismissed);
// onboarding itself has its own first-run test below.
const RETURNING_USER = () => localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))

// First launch: the short activation checklist appears on Home without taking
// the user through an unsolicited tour. Dismissing it sticks across reloads;
// the exhaustive spotlight tour remains available from Help.
test("first run shows the activation checklist and dismissing persists", async ({ page }) => {
  await page.goto("/")
  const checklist = page.getByRole("heading", { name: /first steps/i })
  await expect(checklist).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText("Verify a model provider")).toBeVisible()
  await expect(page.getByText("Create or open a project")).toBeVisible()
  await page.getByRole("button", { name: "Keep building" }).click()
  await expect(checklist).not.toBeVisible()

  await page.reload()
  // Anchored to home's own container rather than a nav label: the sidebar's
  // "Getting started" entry was removed when the shell was rebuilt, and this
  // assertion silently outlived it.
  await expect(page.locator("[data-vector-home-overview]")).toBeVisible()
  // Dismissed: neither the checklist nor the tour may auto-open again.
  await page.waitForTimeout(1_500)
  await expect(page.getByRole("heading", { name: /first steps/i })).not.toBeVisible()
  await expect(page.getByRole("button", { name: "Skip tour" })).not.toBeVisible()
})
