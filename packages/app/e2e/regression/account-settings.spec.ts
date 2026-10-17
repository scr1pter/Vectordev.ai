import { expect, test, type Page, type TestInfo } from "@playwright/test"

const opened = (page: Page) =>
  page.evaluate(() => (window as unknown as { accountFixture: { opened: string[] } }).accountFixture.opened)
// The launch screen lifts over the page first, so a capture waits until it has gone.
const capture = async (page: Page, testInfo: TestInfo, name: string) => {
  await expect(page.locator("#vector-launch")).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath(name) })
}
const actions = (page: Page) =>
  page.evaluate(() => (window as unknown as { accountFixture: { actions: string[] } }).accountFixture.actions)

test("Account shows who is signed in and that Codium is coming soon, with no amounts", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/account-settings.html?account=photo&codium=coming-soon")
  const settings = page.locator(".settings-v2-workspace")
  await expect(settings.getByRole("tab", { name: "Account", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(settings.getByRole("heading", { name: "Ana Diaz", exact: true })).toBeVisible()
  await expect(settings.getByText("ana@example.com", { exact: true })).toBeVisible()
  await expect(settings.locator("img.settings-account-avatar")).toBeVisible()
  await expect(settings.getByText("Coming soon", { exact: true })).toBeVisible()
  await expect(settings.getByRole("button", { name: "Manage billing" })).toHaveCount(0)
  await expect(settings.getByRole("button", { name: "Buy credits" })).toHaveCount(0)
  await expect(settings.getByRole("button", { name: "View usage" })).toBeVisible()
  await capture(page, testInfo, "account-coming-soon.png")
})

test("Account shows the plan as a share of this month's credits and links billing on the website", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=plan")
  const settings = page.locator(".settings-v2-workspace")
  await expect(settings.locator(".settings-account-avatar")).toHaveText("A")
  await expect(settings.getByText("Codium 50", { exact: true })).toBeVisible()
  await expect(settings.getByText("64% of this month's credits left", { exact: true })).toBeVisible()
  await expect(settings.getByRole("meter", { name: "Share of this month's credits left" })).toHaveAttribute(
    "aria-valuenow",
    "64",
  )
  await expect(settings.getByText("Available", { exact: true })).toBeVisible()
  // Only the share and states reach the page: no credit counts or dollar amounts.
  await expect(settings.locator("[data-component='settings-account-codium']")).not.toContainText("$")
  await capture(page, testInfo, "account-plan.png")

  await settings.getByRole("button", { name: "Manage billing" }).click()
  expect(await opened(page)).toEqual(["https://vectordev.ai/account"])
})

test("Delete account confirms in Vector, then continues on vectordev.ai", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=low")
  const settings = page.locator(".settings-v2-workspace")
  await expect(settings.getByText("You are running low on Codium credits.")).toBeVisible()
  await settings.getByRole("button", { name: "Delete account…" }).click()
  const confirm = settings.getByRole("group", { name: "Confirm account deletion" })
  await expect(confirm).toContainText("type ana@example.com to confirm")
  await confirm.scrollIntoViewIfNeeded()
  await capture(page, testInfo, "account-delete-confirm.png")
  await confirm.getByRole("button", { name: "Keep my account" }).click()
  await expect(confirm).toHaveCount(0)
  expect(await opened(page)).toEqual([])

  await settings.getByRole("button", { name: "Delete account…" }).click()
  await settings.getByRole("button", { name: "Continue on vectordev.ai" }).click()
  expect(await opened(page)).toEqual(["https://vectordev.ai/account"])
  await expect(settings.getByText("Once the account is deleted, sign out here")).toBeVisible()
  await settings.getByRole("button", { name: "Sign out" }).last().click()
  expect(await actions(page)).toEqual(["logout"])
  await expect(settings.getByRole("heading", { name: "Not signed in" })).toBeVisible()
})

test("Signed out, Account offers Sign in to Vector and nothing else", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/account-settings.html?account=signed-out")
  const settings = page.locator(".settings-v2-workspace")
  await expect(settings.getByRole("heading", { name: "Not signed in" })).toBeVisible()
  await expect(settings.locator("[data-component='settings-account-codium']")).toHaveCount(0)
  await expect(settings.locator("[data-component='settings-account-delete']")).toHaveCount(0)
  await capture(page, testInfo, "account-signed-out.png")
  await settings.getByRole("button", { name: "Sign in to Vector" }).click()
  expect(await actions(page)).toEqual(["start"])
  await expect(settings.getByText("Finish signing in in your browser, then return to Vector.")).toBeVisible()
  await settings.getByRole("button", { name: "Cancel sign-in" }).click()
  await expect(settings.getByRole("button", { name: "Sign in to Vector" })).toBeVisible()
})
