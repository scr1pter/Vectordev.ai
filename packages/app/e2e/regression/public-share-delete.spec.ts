import { expect, test } from "@playwright/test"
import { fixture } from "../performance/timeline/session-timeline-stress.fixture"
import {
  installStressTasks,
  mockStressTimeline,
  stressSessionHref,
} from "../performance/timeline/timeline-test-helpers"
import { expectSessionTitle } from "../utils/waits"

for (const newLayoutDesigns of [false, true]) {
  test(`keeps the old public link visible until local deletion is explicitly confirmed (new layout: ${newLayoutDesigns})`, async ({
    page,
  }) => {
    await mockStressTimeline(page)
    await page.addInitScript((value) => {
      localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({
          general: {
            newLayoutDesigns: value,
            editToolPartsExpanded: true,
            shellToolPartsExpanded: true,
            showReasoningSummaries: true,
          },
        }),
      )
    }, newLayoutDesigns)
    await installStressTasks(page)
    const attempts: string[] = []
    const url = "https://example.com/public/retained-session"
    await page.route(
      (value) => value.pathname === `/session/${fixture.sourceID}`,
      async (route) => {
        if (route.request().method() !== "DELETE") return route.fallback()
        const acknowledged = new URL(route.request().url()).searchParams.get("acknowledgePublicShares")
        attempts.push(acknowledged ?? "no")
        if (acknowledged === "true")
          return route.fulfill({ json: { deleted: true, warnings: ["The public copy remains online."], links: [url] } })
        return route.fulfill({
          status: 409,
          json: { _tag: "PublicShareRemovalError", message: "The public copy remains online.", links: [url] },
        })
      },
    )
    await page.goto(stressSessionHref(fixture.sourceID))
    await expectSessionTitle(page, fixture.expected.sourceTitle)
    await page.getByRole("button", { name: "More options", exact: true }).last().click()
    await page.getByRole("menuitem", { name: /^Delete/ }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("button", { name: "Delete session", exact: true }).click()
    await expect.poll(() => attempts.length).toBeGreaterThan(0)
    await expect(dialog.getByText(url, { exact: true })).toBeVisible()
    await expect(dialog.getByText(/Vector cannot remove that public copy/)).toBeVisible()
    expect(attempts).toEqual(["no"])
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    await expectSessionTitle(page, fixture.expected.sourceTitle)
    expect(attempts).toEqual(["no"])
    await page.getByRole("button", { name: "More options", exact: true }).last().click()
    await page.getByRole("menuitem", { name: /^Delete/ }).click()
    await dialog.getByRole("button", { name: "Delete session", exact: true }).click()
    await expect(dialog.getByText(url, { exact: true })).toBeVisible()
    await dialog.getByRole("button", { name: "Delete local session only", exact: true }).click()
    await expect(dialog).not.toBeVisible()
    expect(attempts).toEqual(["no", "no", "true"])
  })
}
