import { expect, test } from "@playwright/test"
import { fixture } from "../performance/timeline/session-timeline-stress.fixture"
import {
  installStressTasks,
  installTimelineSettings,
  mockStressTimeline,
  stressDraftHref,
} from "../performance/timeline/timeline-test-helpers"

test("explains ignored credentials and a configured model fallback in the app", async ({ page }) => {
  await mockStressTimeline(page)
  await installTimelineSettings(page)
  await installStressTasks(page, { draftID: "draft_provider_notice" })
  await page.route(
    (url) => url.pathname === "/provider",
    (route) =>
      route.fulfill({
        json: {
          ...fixture.provider,
          unavailable: [{ id: "openai", reason: "sign-in-paused", message: "OpenAI sign-in is paused." }],
        },
      }),
  )
  await page.route(
    (url) => url.pathname === "/config",
    (route) =>
      route.fulfill({
        json: { model: "missing/family/saved", provider: { missing: { name: "Unavailable fixture", models: {} } } },
      }),
  )
  await page.goto(stressDraftHref("draft_provider_notice"))
  await expect(page.getByText("openai credential ignored", { exact: true })).toHaveCount(1)
  await expect(page.getByText("openai credential ignored", { exact: true })).toBeVisible()
  await expect(
    page.getByText(
      "missing/family/saved is unavailable. Vector selected anthropic/claude-opus-4-6. Check its pricing before continuing.",
      { exact: true },
    ),
  ).toBeVisible()
  await expect(page.getByText("Saved model unavailable", { exact: true })).toHaveCount(1)
})
