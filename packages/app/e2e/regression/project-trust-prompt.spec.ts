import { expect, test, type Page } from "@playwright/test"
import { fixture } from "../performance/timeline/session-timeline-stress.fixture"
import {
  installStressTasks,
  installTimelineSettings,
  mockStressTimeline,
  stressDraftHref,
} from "../performance/timeline/timeline-test-helpers"

type TrustStatus = { trusted: boolean; ignored: boolean; settings: boolean }

const ignoredSettings = { trusted: false, ignored: true, settings: true }

// The engine's trust API, held in the test so a reload sees what the last approval left behind.
async function mockTrust(page: Page, initial: TrustStatus) {
  const state = { status: { workspace: fixture.directory, ...initial }, reads: 0, approvals: 0 }
  await page.route(
    (url) => url.pathname === "/config/trust",
    (route) => {
      if (route.request().method() !== "POST") {
        state.reads += 1
        return route.fulfill({ json: state.status })
      }
      state.approvals += 1
      state.status = { ...state.status, trusted: true, ignored: false }
      return route.fulfill({ json: state.status })
    },
  )
  return state
}

async function openDraft(page: Page, initial: TrustStatus) {
  await mockStressTimeline(page)
  await installTimelineSettings(page)
  await installStressTasks(page, { draftID: "draft_project_trust" })
  const trust = await mockTrust(page, initial)
  await page.goto(stressDraftHref("draft_project_trust"))
  return trust
}

function storedAnswers(page: Page) {
  return page.evaluate(() => localStorage.getItem("vector.global.dat:project-trust") ?? "")
}

// Absence needs a settled page: the status has been read and the app had a moment to act on it.
async function expectNoTrustDialog(page: Page, trust: { reads: number }, after: number) {
  await expect.poll(() => trust.reads).toBeGreaterThan(after)
  await page.waitForTimeout(750)
  await expect(page.getByRole("dialog")).toHaveCount(0)
}

test("asks once to trust a project with its own settings and remembers Not now", async ({ page }) => {
  const trust = await openDraft(page, ignoredSettings)

  const dialog = page.getByRole("dialog", { name: "Trust this project?" })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText("Trusting SmokeProject lets Vector load the settings it comes with")
  await expect(page.locator('[data-component="project-trust-notice"]')).toHaveCount(0)

  await dialog.getByRole("button", { name: "Not now" }).click()
  await expect(dialog).toHaveCount(0)
  expect(trust.approvals).toBe(0)
  await expect.poll(() => storedAnswers(page)).toContain("dismissed")

  const reads = trust.reads
  await page.reload()
  await expectNoTrustDialog(page, trust, reads)
  expect(trust.approvals).toBe(0)
})

test("Trust this project approves through the engine and asks again only after the settings change", async ({
  page,
}) => {
  const trust = await openDraft(page, ignoredSettings)

  const dialog = page.getByRole("dialog", { name: "Trust this project?" })
  await dialog.getByRole("button", { name: "Trust this project" }).click()
  await expect(dialog).toHaveCount(0)
  expect(trust.approvals).toBe(1)
  await expect.poll(() => storedAnswers(page)).toContain("trusted")

  const reads = trust.reads
  await page.reload()
  await expectNoTrustDialog(page, trust, reads)

  // The engine stops trusting a project whose settings changed after the approval.
  trust.status = { ...trust.status, ...ignoredSettings }
  await page.reload()
  const changed = page.getByRole("dialog", { name: "Trust this project's new settings?" })
  await expect(changed).toBeVisible()
  await expect(changed).toContainText("SmokeProject's Vector settings changed after you trusted it")
})

test("never asks about a project with no Vector settings of its own", async ({ page }) => {
  const trust = await openDraft(page, { trusted: false, ignored: true, settings: false })
  await expectNoTrustDialog(page, trust, 0)
  expect(trust.approvals).toBe(0)
})
