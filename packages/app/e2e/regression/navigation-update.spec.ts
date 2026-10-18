import { expect, test, type Page, type TestInfo } from "@playwright/test"

const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { navigationFixture: { calls: string[] } }).navigationFixture.calls)
const setUpdater = (page: Page, state: string) =>
  page.evaluate(
    (name) => (window as unknown as { navigationFixture: { set: (name: string) => void } }).navigationFixture.set(name),
    state,
  )
const open = async (page: Page, query: string) => {
  await page.goto(`/e2e/fixtures/navigation-update.html?${query}`)
  const footer = page.locator("[data-vector-nav-footer]")
  await expect(footer).toBeVisible()
  return footer
}
// The launch screen lifts over the page first, so a capture waits until it has gone.
const capture = async (page: Page, testInfo: TestInfo, name: string) => {
  await expect(page.locator("#vector-launch")).toHaveCount(0)
  await page.locator("[data-vector-navigation]").screenshot({ path: testInfo.outputPath(name) })
}

test("a downloaded update takes the Settings gear's place, and the name still opens Settings", async ({
  page,
}, testInfo) => {
  const footer = await open(page, "updater=ready&account=signed-in")
  const update = footer.getByRole("button", { name: "Restart to update to Vector 1.99.110", exact: true })
  await expect(update).toBeVisible()
  await expect(update).toHaveText("Update")
  await expect(update).toHaveAttribute("data-state", "ready")
  await expect(footer.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0)
  await capture(page, testInfo, "sidebar-update-ready.png")

  // Settings stays one click away: the account chip opens it at Account, and the Help menu has it too.
  await footer.getByRole("button", { name: "Account: Ana Diaz. Open account settings" }).click()
  await footer.getByRole("button", { name: "Help", exact: true }).click()
  const settings = page.getByRole("dialog", { name: "Vector help" }).getByRole("button", { name: /^Settings/ })
  await expect(settings).toContainText("⌘,")
  await settings.click()
  expect(await calls(page)).toEqual(["account", "settings"])
})

test("Update restarts into the update, shows that it is updating, and gives the gear back if it fails", async ({
  page,
}, testInfo) => {
  const footer = await open(page, "updater=ready&account=signed-in")
  await footer.getByRole("button", { name: "Restart to update to Vector 1.99.110", exact: true }).click()
  expect(await calls(page)).toEqual(["install"])
  const updating = footer.getByRole("button", { name: "Updating to Vector 1.99.110", exact: true })
  await expect(updating).toBeDisabled()
  await expect(updating).toHaveAttribute("aria-busy", "true")
  await expect(updating).toHaveText("Updating…")
  await capture(page, testInfo, "sidebar-update-installing.png")

  const failing = await open(page, "updater=ready&account=signed-in&fail=1")
  await failing.getByRole("button", { name: "Restart to update to Vector 1.99.110", exact: true }).click()
  await expect(failing.getByRole("button", { name: "Settings", exact: true })).toBeVisible()
  await expect(failing.locator("[data-vector-update]")).toHaveCount(0)
  expect(await calls(page)).toEqual(["install", "failed: Vector could not install the update."])
})

test("signed out, the chip opens Account, which offers Sign in, and Update still replaces the gear", async ({
  page,
}) => {
  for (const [account, label] of [
    ["signed-out", "Sign in to Vector"],
    ["pending", "Finish signing in in your browser"],
  ] as const) {
    const footer = await open(page, `updater=ready&account=${account}`)
    const chip = footer.getByRole("button", { name: `${label}. Open account settings`, exact: true })
    await expect(chip).toHaveText(label)
    await expect(chip).toBeEnabled()
    await chip.click()
    expect(await calls(page)).toEqual(["account"])
    await expect(footer.locator("[data-vector-update]")).toBeVisible()
    await expect(footer.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0)
  }
})

test("without the account bridge the chip cannot open Settings, so the gear stays beside Update", async ({ page }) => {
  const footer = await open(page, "updater=ready&account=none")
  await expect(footer.getByText("Vector workspace", { exact: true })).toBeVisible()
  await expect(footer.locator("[data-vector-update]")).toBeVisible()
  await expect(footer.getByRole("button", { name: "Settings", exact: true })).toBeVisible()
})

test("with nothing to install, and in the web build, the gear stays", async ({ page }) => {
  for (const state of ["idle", "checking", "downloading", "up-to-date", "error", "disabled", "none"]) {
    const footer = await open(page, `updater=${state}&account=${state === "none" ? "none" : "signed-in"}`)
    await expect(footer.getByRole("button", { name: "Settings", exact: true }), state).toBeVisible()
    await expect(footer.locator("[data-vector-update]"), state).toHaveCount(0)
  }
})

test("Update is reached with Tab after Help and runs with Enter", async ({ page }) => {
  const footer = await open(page, "updater=ready&account=signed-in")
  await footer.getByRole("button", { name: "Account: Ana Diaz. Open account settings" }).focus()
  await page.keyboard.press("Tab")
  await expect(footer.getByRole("button", { name: "Help", exact: true })).toBeFocused()
  await page.keyboard.press("Tab")
  const update = footer.getByRole("button", { name: "Restart to update to Vector 1.99.110", exact: true })
  await expect(update).toBeFocused()
  await page.keyboard.press("Enter")
  expect(await calls(page)).toEqual(["install"])
})

test("with agents running, Update asks first and Later or Escape keeps them running", async ({ page }, testInfo) => {
  const footer = await open(page, "updater=ready&account=signed-in&agents=2")
  const update = footer.getByRole("button", { name: "Restart to update to Vector 1.99.110", exact: true })
  await expect(update).toHaveAttribute("aria-haspopup", "dialog")
  await update.click()
  const confirm = page.getByRole("dialog", { name: "Restart to update" })
  await expect(confirm).toBeVisible()
  await expect(confirm).toContainText("Restart to update to Vector 1.99.110?")
  await expect(confirm).toContainText("2 agents in the workspace are still running and will stop.")
  await expect(confirm.getByRole("button", { name: "Later" })).toBeFocused()
  await expect(update).toHaveAttribute("aria-expanded", "true")
  await capture(page, testInfo, "sidebar-update-confirm.png")
  expect(await calls(page)).toEqual([])

  await page.keyboard.press("Escape")
  await expect(confirm).toHaveCount(0)
  await expect(update).toBeFocused()

  await update.click()
  await confirm.getByRole("button", { name: "Later" }).click()
  await expect(confirm).toHaveCount(0)
  expect(await calls(page)).toEqual([])

  await update.click()
  await confirm.getByRole("button", { name: "Restart now" }).click()
  expect(await calls(page)).toEqual(["install"])
  await expect(confirm).toHaveCount(0)

  await open(page, "updater=ready&account=signed-in&agents=1")
  await page.locator("[data-vector-update]").click()
  await expect(page.getByRole("dialog", { name: "Restart to update" })).toContainText(
    "1 agent in the workspace is still running and will stop.",
  )
})

test("your own busy task counts, with no parallel or background agents running", async ({ page }) => {
  const footer = await open(page, "updater=ready&account=signed-in&busy=1")
  await footer.getByRole("button", { name: "Restart to update to Vector 1.99.110", exact: true }).click()
  const confirm = page.getByRole("dialog", { name: "Restart to update" })
  await expect(confirm).toContainText("1 agent in the workspace is still running and will stop.")
  expect(await calls(page)).toEqual([])

  // Counted when Update is clicked, so a task that started after the page opened counts too.
  await open(page, "updater=ready&account=signed-in")
  await page.evaluate(() =>
    (
      window as unknown as { navigationFixture: { setRunning: (next: object) => void } }
    ).navigationFixture.setRunning({ busy: 1, agents: 2 }),
  )
  await page.locator("[data-vector-update]").click()
  await expect(confirm).toContainText("3 agents in the workspace are still running and will stop.")
})

test("agents that finish while the question is open never make it say 0 agents", async ({ page }) => {
  await open(page, "updater=ready&account=signed-in&agents=2")
  await page.locator("[data-vector-update]").click()
  const confirm = page.getByRole("dialog", { name: "Restart to update" })
  await expect(confirm).toContainText("2 agents in the workspace are still running and will stop.")
  await page.evaluate(() =>
    (
      window as unknown as { navigationFixture: { setRunning: (next: object) => void } }
    ).navigationFixture.setRunning({ agents: 0 }),
  )
  await page.waitForTimeout(100)
  await expect(confirm).not.toContainText("0 agents")
  await confirm.getByRole("button", { name: "Restart now" }).click()
  expect(await calls(page)).toEqual(["install"])

  // Once nothing is running, Update restarts straight away.
  await open(page, "updater=ready&account=signed-in&agents=2")
  await page.evaluate(() =>
    (
      window as unknown as { navigationFixture: { setRunning: (next: object) => void } }
    ).navigationFixture.setRunning({ agents: 0 }),
  )
  await page.locator("[data-vector-update]").click()
  await expect.poll(() => calls(page)).toEqual(["install"])
})

test("an update that becomes ready is announced once, and nothing is said at launch", async ({ page }) => {
  const footer = await open(page, "updater=ready&account=signed-in")
  const status = footer.getByRole("status")
  await expect(status).toHaveText("")

  await open(page, "updater=downloading&account=signed-in")
  await expect(status).toHaveText("")
  await setUpdater(page, "ready")
  await expect(status).toHaveText("Vector 1.99.110 is ready. Restart to update.")
  await setUpdater(page, "installing")
  await expect(status).toHaveText("")
})

test("the updating spinner stops turning with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  const footer = await open(page, "updater=installing&account=signed-in")
  const spinner = footer.locator("[data-vector-update-spinner]")
  await expect(spinner).toBeVisible()
  expect(await spinner.evaluate((element) => getComputedStyle(element).animationName)).toBe("none")

  await page.emulateMedia({ reducedMotion: "no-preference" })
  await expect
    .poll(() => spinner.evaluate((element) => getComputedStyle(element).animationName))
    .toBe("vector-update-spin")
})
