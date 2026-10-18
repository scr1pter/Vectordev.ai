import { expect, test, type Page, type TestInfo } from "@playwright/test"

const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { homeUpdateFixture: { calls: string[] } }).homeUpdateFixture.calls)
const fixture = (page: Page) =>
  page.evaluate(() => (window as unknown as { homeUpdateFixture: unknown }).homeUpdateFixture !== undefined)
const open = async (page: Page, query: string) => {
  await page.goto(`/e2e/fixtures/home-update.html?${query}`)
  await expect.poll(() => fixture(page)).toBe(true)
  const actions = page.locator("[data-vector-home] .vector-home-heading__actions")
  await expect(actions).toBeVisible()
  return actions
}
// The launch screen lifts over the page first, so a capture waits until it has gone. The confirmation hangs below the
// header, so the capture takes the top of the page rather than the header alone.
const capture = async (page: Page, testInfo: TestInfo, name: string) => {
  await expect(page.locator("#vector-launch")).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath(name), clip: { x: 0, y: 0, width: 1280, height: 260 } })
}

test("a downloaded update shows Update on Home, before Settings, which stays", async ({ page }, testInfo) => {
  const actions = await open(page, "updater=ready")
  const update = actions.getByRole("button", { name: "Restart to update to Vector 1.99.110", exact: true })
  await expect(update).toBeVisible()
  await expect(update).toHaveText("Update")
  await expect(update).toHaveAttribute("data-state", "ready")
  await expect(actions.getByRole("button")).toHaveText(["Start building", "Vector Cloud", "Update", "Settings"])
  // The tour finds Vector Cloud and Settings by this selector; Update has its own variant and stays out of it.
  await expect(actions.locator('button[data-variant="secondary"]')).toHaveText(["Vector Cloud", "Settings"])
  await capture(page, testInfo, "home-update-ready.png")

  for (const state of ["idle", "downloading", "error"]) {
    const quiet = await open(page, `updater=${state}`)
    await expect(quiet.locator("[data-vector-home-update]")).toHaveCount(0)
    await expect(quiet.getByRole("button", { name: "Settings", exact: true })).toBeVisible()
  }
})

test("with no agent running, Update restarts at once and shows that it is updating", async ({ page }, testInfo) => {
  const actions = await open(page, "updater=ready")
  await actions.getByRole("button", { name: "Restart to update to Vector 1.99.110", exact: true }).click()
  expect(await calls(page)).toEqual(["install"])
  const updating = actions.getByRole("button", { name: "Updating to Vector 1.99.110", exact: true })
  await expect(updating).toBeDisabled()
  await expect(updating).toHaveAttribute("aria-busy", "true")
  await expect(updating).toHaveText("Updating…")
  await capture(page, testInfo, "home-update-installing.png")

  // A failed install leaves Settings > Updates & about to show the error, so Update goes away.
  const failing = await open(page, "updater=ready&fail=1")
  await failing.getByRole("button", { name: "Restart to update to Vector 1.99.110", exact: true }).click()
  await expect(failing.locator("[data-vector-home-update]")).toHaveCount(0)
  expect(await calls(page)).toEqual(["install", "failed: Vector could not install the update."])
})

test("while agents run, Update asks first with the count from the click", async ({ page }, testInfo) => {
  const actions = await open(page, "updater=ready&agents=2")
  const update = actions.getByRole("button", { name: "Restart to update to Vector 1.99.110", exact: true })
  await expect(update).toHaveAttribute("aria-haspopup", "dialog")
  await update.click()
  const confirm = page.getByRole("dialog", { name: "Restart to update" })
  await expect(confirm).toBeVisible()
  await expect(confirm).toHaveAccessibleDescription("2 agents in the workspace are still running and will stop.")
  await expect(update).toHaveAttribute("aria-expanded", "true")
  await expect(confirm.getByRole("button", { name: "Later" })).toBeFocused()
  await capture(page, testInfo, "home-update-confirm.png")
  expect(await calls(page)).toEqual([])

  // Agents that finish while it is open do not change what it said; Escape closes it and gives focus back.
  await page.evaluate(() =>
    (window as unknown as { homeUpdateFixture: { setRunning: (next: object) => void } }).homeUpdateFixture.setRunning({
      agents: 0,
    }),
  )
  await expect(confirm).toContainText("2 agents")
  await page.keyboard.press("Escape")
  await expect(confirm).toHaveCount(0)
  await expect(update).toBeFocused()

  await page.evaluate(() =>
    (window as unknown as { homeUpdateFixture: { setRunning: (next: object) => void } }).homeUpdateFixture.setRunning({
      agents: 1,
    }),
  )
  await update.click()
  await expect(confirm).toHaveAccessibleDescription("1 agent in the workspace is still running and will stop.")
  await confirm.getByRole("button", { name: "Restart now" }).click()
  await expect(confirm).toHaveCount(0)
  expect(await calls(page)).toEqual(["install"])
})

test("Home says once when an update becomes ready, and an install closes the question", async ({ page }) => {
  const actions = await open(page, "updater=idle&agents=1")
  const status = page.getByRole("status")
  await expect(status).toHaveText("")
  await page.evaluate(() =>
    (window as unknown as { homeUpdateFixture: { set: (name: string) => void } }).homeUpdateFixture.set("ready"),
  )
  await expect(status).toHaveText("Vector 1.99.110 is ready. Restart to update.")
  await actions.getByRole("button", { name: "Restart to update to Vector 1.99.110", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Restart to update" })).toBeVisible()
  await page.evaluate(() =>
    (window as unknown as { homeUpdateFixture: { set: (name: string) => void } }).homeUpdateFixture.set("installing"),
  )
  await expect(page.getByRole("dialog", { name: "Restart to update" })).toHaveCount(0)
})
