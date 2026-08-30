import { test, expect } from "@playwright/test"
import { expectSessionTitle } from "../utils/waits"
import { fixture } from "../performance/timeline/session-timeline-stress.fixture"
import {
  createReviewDiffs,
  installStressTasks,
  installTimelineSettings,
  mockStressTimeline,
  navigateStressTask,
  stressSessionHref,
} from "../performance/timeline/timeline-test-helpers"
import { waitForStableTimeline } from "../performance/timeline/session-tab-switch-probe"

test("renders review content after cached task navigation", async ({ page }) => {
  await mockStressTimeline(page, { vcsDiff: createReviewDiffs() })
  await installTimelineSettings(page)
  await installStressTasks(page)
  await page.goto(stressSessionHref(fixture.targetID))
  await expectSessionTitle(page, fixture.expected.targetTitle)
  await waitForStableTimeline(page, fixture.expected.targetMessageIDs.at(-1)!)
  await navigateStressTask(page, stressSessionHref(fixture.sourceID))
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  await waitForStableTimeline(page, fixture.expected.sourceMessageIDs.at(-1)!)
  await page.getByRole("button", { name: "Toggle review" }).click()
  await expect(page.locator('[data-component="session-review-v2"]')).toBeVisible()
  await expect(page.locator("#review-panel")).toContainText("generated-000.ts", { timeout: 5000 })
  await expect(page.locator("#review-panel")).toContainText("+3", { timeout: 5000 })
})
