import { expect, type Locator, type Page } from "@playwright/test"

export const APP_READY_TIMEOUT = 30_000

export async function expectAppVisible(locator: Locator) {
  await expect(locator).toBeVisible({ timeout: APP_READY_TIMEOUT })
}

export async function expectSessionTitle(page: Page, title: string) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const compact = page.locator("[data-vector-session-title]").filter({ hasText: new RegExp(`^${escaped}$`) })
  const legacy = page.getByRole("heading", { name: title, exact: true })
  await expectAppVisible(compact.or(legacy).first())
}
