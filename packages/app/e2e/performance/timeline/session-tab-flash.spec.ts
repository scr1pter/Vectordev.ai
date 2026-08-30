import { benchmark, expect } from "../benchmark"
import { expectSessionTitle } from "../../utils/waits"
import { fixture } from "./session-timeline-stress.fixture"
import {
  collectCachedRepaintTrace,
  compressCachedRepaintTrace,
  installCachedRepaintProbe,
  waitForCachedRepaintWindow,
} from "./session-tab-repaint-probe"
import { waitForStableTimeline } from "./session-tab-switch-probe"
import {
  installStressTasks,
  installTimelineSettings,
  mockStressTimeline,
  navigateStressTask,
  stressSessionHref,
} from "./timeline-test-helpers"

benchmark("samples cached task repaint after navigation", async ({ page, report }) => {
  benchmark.setTimeout(120_000)
  await mockStressTimeline(page)
  await installStressTasks(page)
  await installTimelineSettings(page)
  await page.goto(stressSessionHref(fixture.targetID))
  await expectSessionTitle(page, fixture.expected.targetTitle)
  await waitForStableTimeline(page, fixture.expected.targetMessageIDs.at(-1)!)
  await navigateStressTask(page, stressSessionHref(fixture.sourceID))
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  await waitForStableTimeline(page, fixture.expected.sourceMessageIDs.at(-1)!)

  await installCachedRepaintProbe(page, {
    targetHref: stressSessionHref(fixture.targetID),
    destination: fixture.messages[fixture.targetID].map((message) => message.info.id),
    source: fixture.messages[fixture.sourceID].map((message) => message.info.id),
    last: fixture.expected.targetMessageIDs.at(-1)!,
    windowMs: 1_000,
  })

  await navigateStressTask(page, stressSessionHref(fixture.targetID))
  await Promise.all([expectSessionTitle(page, fixture.expected.targetTitle), waitForCachedRepaintWindow(page, 1_000)])
  const result = await collectCachedRepaintTrace(page)
  report(compressCachedRepaintTrace(result))
  expect(result.samples.length).toBeGreaterThan(0)
})

benchmark("prefetches recent tasks on Home before opening them", async ({ page, report }) => {
  const prefetched = new Set<string>()
  await mockStressTimeline(page, {
    onMessages: (input) => {
      if (!input.before && input.phase === "start") prefetched.add(input.sessionID)
    },
  })
  await installStressTasks(page, { sessionIDs: [] })
  await installTimelineSettings(page)
  await page.goto("/")
  const rows = page.locator('[data-component="home-session-row"]')
  await expect(rows.filter({ hasText: fixture.expected.sourceTitle })).toBeVisible()
  await expect(rows.filter({ hasText: fixture.expected.targetTitle })).toBeVisible()

  await expect.poll(() => [fixture.sourceID, fixture.targetID].every((id) => prefetched.has(id))).toBe(true)
  await expect(page).toHaveURL("/")
  report({ prefetched: [...prefetched] }, { navigationSurface: "home-recents" })
})
