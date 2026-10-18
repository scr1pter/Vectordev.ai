import { expect, test, type Page, type TestInfo } from "@playwright/test"

type Fixture = {
  opened: string[]
  actions: string[]
  billing: unknown[]
  codiumReads: number
  confirm: () => void
  finish: () => void
}
const read = (page: Page) =>
  page.evaluate(() => {
    const state = (window as unknown as { accountFixture: Fixture }).accountFixture
    return { opened: state.opened, actions: state.actions, billing: state.billing, codiumReads: state.codiumReads }
  })
const opened = async (page: Page) => (await read(page)).opened
const actions = async (page: Page) => (await read(page)).actions
const billing = async (page: Page) => (await read(page)).billing
// The launch screen lifts over the page first, so a capture waits until it has gone.
const capture = async (page: Page, testInfo: TestInfo, name: string) => {
  await expect(page.locator("#vector-launch")).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath(name) })
}

test("Account shows who is signed in and that Codium is coming soon, and nothing can be bought", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/account-settings.html?account=photo&codium=coming-soon")
  const settings = page.locator(".settings-v2-workspace")
  await expect(settings.getByRole("tab", { name: "Account", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(settings.getByRole("heading", { name: "Ana Diaz", exact: true })).toBeVisible()
  await expect(settings.getByText("ana@example.com", { exact: true })).toBeVisible()
  await expect(settings.locator("img.settings-account-avatar")).toBeVisible()
  await expect(settings.locator(".settings-account-badge")).toHaveText("Coming soon")
  await expect(settings.getByRole("button", { name: "Manage billing and invoices" })).toHaveCount(0)
  await expect(settings.getByRole("button", { name: "View usage" })).toBeVisible()

  await settings.getByRole("button", { name: "Buy credits" }).click()
  const offers = settings.locator("[data-component='codium-purchase']")
  await expect(offers.getByText("Nothing can be bought until Vector Codium goes on sale.")).toBeVisible()
  await expect(offers.getByText("Codium 50", { exact: true })).toBeVisible()
  await expect(offers.getByText("$50 a month")).toBeVisible()
  // Every purchase button says Coming soon and none can be pressed.
  const soon = offers.getByRole("button", { name: /^Coming soon, / })
  await expect(soon).toHaveCount(8)
  for (const button of await soon.all()) await expect(button).toBeDisabled()
  await expect(offers.getByRole("button", { name: /^(Subscribe|Buy), / })).toHaveCount(0)
  // Prices only: no credits and no comparison between purchases.
  await expect(offers).not.toContainText(/credits? (of|worth)|\d+(\.\d+)?x|\$\d+(\.\d+)? (in|of) credit/)
  await capture(page, testInfo, "account-coming-soon.png")
  expect(await billing(page)).toEqual([])
  expect(await opened(page)).toEqual([])
})

test("Account shows the plan as a share of this month's credits and manages billing inside Vector", async ({
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
  // Only the share and states reach the balance: no credit counts or dollar amounts.
  await expect(settings.locator(".settings-account-balance")).not.toContainText("$")
  await capture(page, testInfo, "account-plan.png")

  await settings.getByRole("button", { name: "Manage billing and invoices" }).click()
  await settings.getByRole("button", { name: "Cancel plan" }).click()
  await expect(
    settings.getByText("Your plan is cancelled. It keeps working until the end of this billing period."),
  ).toBeVisible()
  expect(await billing(page)).toEqual([{ kind: "portal" }, { kind: "portal", flow: "cancel" }])
  // Nothing went to the website.
  expect(await opened(page)).toEqual([])
})

test("Buy credits lists plans and top-ups by price, and each opens Stripe in Vector", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=plan")
  const settings = page.locator(".settings-v2-workspace")
  await settings.getByRole("button", { name: "Buy credits" }).click()
  const offers = settings.locator("[data-component='codium-purchase']")
  // The subscriber's own plan is marked; other plans change through Stripe's portal.
  await expect(offers.locator("[data-offer='vector-50']")).toContainText("Current plan")
  await expect(offers.getByRole("button", { name: /^Subscribe, / })).toHaveCount(0)
  await expect(offers.getByText("$10 once")).toBeVisible()
  // The terms say top-up credits carry forward; nothing promises they never expire.
  await expect(offers.getByText("Credits bought once that carry forward, used after your monthly credits.")).toBeVisible()
  await expect(offers).not.toContainText(/expire|expiry|expiration/i)
  await capture(page, testInfo, "account-buy-credits.png")

  await offers.getByRole("button", { name: "Buy, Codium 10 top-up" }).click()
  await expect(settings.getByText("Your credits are bought. They appear here in a moment.")).toBeVisible()
  await offers.getByRole("button", { name: "Change plan" }).click()
  await expect(settings.getByText("Your plan change is saved.")).toBeVisible()
  expect(await billing(page)).toEqual([
    { kind: "topup", pack: "codium-topup-10" },
    { kind: "portal", flow: "change" },
  ])
  // After a purchase the page reads the account again while Stripe's notification arrives.
  await expect.poll(async () => (await read(page)).codiumReads, { timeout: 5_000 }).toBeGreaterThan(3)
})

test("someone without a plan subscribes in Vector, and a cancelled or failed checkout says so", async ({ page }) => {
  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=none&billing=cancelled")
  const settings = page.locator(".settings-v2-workspace")
  // Nothing bought yet, so there is no billing to manage and no plan to cancel.
  await expect(settings.getByRole("button", { name: "Manage billing and invoices" })).toHaveCount(0)
  await expect(settings.getByRole("button", { name: "Cancel plan" })).toHaveCount(0)
  await settings.getByRole("button", { name: "Buy credits" }).click()
  const offers = settings.locator("[data-component='codium-purchase']")
  await offers.getByRole("button", { name: "Subscribe, Codium 100" }).click()
  await expect(settings.getByText("Checkout was cancelled. Nothing was charged.")).toBeVisible()
  expect(await billing(page)).toEqual([{ kind: "checkout", plan: "vector-100" }])

  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=ended&billing=failed")
  await settings.getByRole("button", { name: "Buy credits" }).click()
  // An ending plan has nothing left to cancel, and Stripe does not change a plan that is cancelling.
  await expect(settings.getByRole("button", { name: "Cancel plan" })).toHaveCount(0)
  await expect(settings.locator("[data-offer='vector-100']")).toContainText("Current plan")
  await expect(settings.getByRole("button", { name: "Change plan" })).toHaveCount(0)
  await settings.getByRole("button", { name: "Manage billing and invoices" }).click()
  await expect(settings.getByRole("alert")).toHaveText("Subscription management is temporarily unavailable.")

  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=plan&billing=website")
  await settings.getByRole("button", { name: "Manage billing and invoices" }).click()
  await expect(settings.getByText("This continues on vectordev.ai in your browser.")).toBeVisible()
})

test("while the Stripe window is open, the page says how it closes, and a second window is refused", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=plan&billing=pending")
  const settings = page.locator(".settings-v2-workspace")
  const finish = () => page.evaluate(() => (window as unknown as { accountFixture: Fixture }).accountFixture.finish())
  // The portal's home has no end, so the person closes the window themselves.
  await settings.getByRole("button", { name: "Manage billing and invoices" }).click()
  await expect(settings.getByText("Manage billing in the Stripe window, then close it.")).toBeVisible()
  await expect(settings.getByText("It closes by itself")).toHaveCount(0)
  await expect(settings.getByRole("button", { name: "Cancel plan" })).toBeDisabled()
  await finish()
  await expect(settings.getByText("Manage billing in the Stripe window, then close it.")).toHaveCount(0)
  // Stripe sends the person back from the cancel step, which closes the window.
  await settings.getByRole("button", { name: "Cancel plan" }).click()
  await expect(settings.getByText("Finish in the Stripe window. It closes by itself when you are done.")).toBeVisible()
  await finish()
  expect(await billing(page)).toEqual([{ kind: "portal" }, { kind: "portal", flow: "cancel" }])

  // Another page or dialog asked while a window was open: the desktop brings that window forward instead.
  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=plan&billing=busy")
  await settings.getByRole("button", { name: "Cancel plan" }).click()
  await expect(
    settings.getByText("A Stripe window is already open. Finish there or close it, then try again."),
  ).toBeVisible()
  await expect(settings.getByText("Your plan is cancelled.")).toHaveCount(0)
})

test("Buy credits on a Codium turn that ran out opens the plans in Vector, not the website", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=plan&view=codium-error")
  await page.getByRole("button", { name: "Buy credits" }).click()
  const dialog = page.getByRole("dialog", { name: "Buy Codium credits" })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator("[data-offer='vector-50']")).toContainText("Current plan")
  await capture(page, testInfo, "codium-purchase-dialog.png")
  await dialog.getByRole("button", { name: "Buy, Codium 50 top-up" }).click()
  await expect(dialog.getByText("Your credits are bought. They appear here in a moment.")).toBeVisible()
  expect(await billing(page)).toEqual([{ kind: "topup", pack: "codium-topup-50" }])
  expect(await opened(page)).toEqual([])
})

test("Delete account confirms the email, then a fresh sign-in, and deletes inside Vector", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=low")
  const settings = page.locator(".settings-v2-workspace")
  await expect(settings.getByText("You are running low on Codium credits.")).toBeVisible()
  await settings.getByRole("button", { name: "Delete account…" }).click()
  await expect(settings.locator("[data-component='settings-account-delete']")).toContainText("ends any Codium plan")
  const confirm = settings.getByRole("group", { name: "Confirm account deletion" })
  // Deleting cancels the account's Codium subscription and disables its credits, so the confirmation says so.
  await expect(confirm).toContainText(
    "Any Vector Codium plan ends at once, and the credits left, this month's or purchased, can no longer be used.",
  )
  const proceed = confirm.getByRole("button", { name: "Confirm with your Vector sign-in" })
  await expect(proceed).toBeDisabled()
  await confirm.getByLabel("Type ana@example.com to confirm").fill("ana@example.co")
  await expect(proceed).toBeDisabled()
  await confirm.getByLabel("Type ana@example.com to confirm").fill("Ana@Example.com")
  await confirm.scrollIntoViewIfNeeded()
  await capture(page, testInfo, "account-delete-confirm.png")
  await proceed.click()
  await expect(confirm).toContainText("Finish signing in to vectordev.ai in your browser.")
  expect(await actions(page)).toEqual(["confirmDeletion"])

  // The browser sign-in came back: the desktop holds the confirmation.
  await page.evaluate(() => (window as unknown as { accountFixture: Fixture }).accountFixture.confirm())
  await expect(confirm).toContainText("Confirmed. Delete ana@example.com now? This cannot be undone.")
  await capture(page, testInfo, "account-delete-confirmed.png")
  await confirm.getByRole("button", { name: "Delete my account" }).click()
  await expect(settings.getByRole("heading", { name: "Your Vector account was deleted" })).toBeVisible()
  expect(await actions(page)).toEqual(["confirmDeletion", "delete Ana@Example.com"])
  await expect(settings.locator("[data-component='settings-account-delete']")).toHaveCount(0)
  // Nothing was handed to the website.
  expect(await opened(page)).toEqual([])
})

test("Keep my account drops a deletion in progress", async ({ page }) => {
  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=plan")
  const settings = page.locator(".settings-v2-workspace")
  await settings.getByRole("button", { name: "Delete account…" }).click()
  const confirm = settings.getByRole("group", { name: "Confirm account deletion" })
  await confirm.getByLabel("Type ana@example.com to confirm").fill("ana@example.com")
  await confirm.getByRole("button", { name: "Confirm with your Vector sign-in" }).click()
  await confirm.getByRole("button", { name: "Keep my account" }).click()
  await expect(confirm).toHaveCount(0)
  expect(await actions(page)).toEqual(["confirmDeletion", "cancelDeletion"])
  await expect(settings.getByRole("button", { name: "Delete account…" })).toBeVisible()
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
