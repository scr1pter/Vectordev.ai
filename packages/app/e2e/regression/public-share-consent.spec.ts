import { expect, test } from "@playwright/test"
import { createHash } from "node:crypto"
import { fixture } from "../performance/timeline/session-timeline-stress.fixture"
import {
  installStressTasks,
  mockStressTimeline,
  stressSessionHref,
} from "../performance/timeline/timeline-test-helpers"
import { expectSessionTitle } from "../utils/waits"

for (const newLayoutDesigns of [false, true]) {
  test(`public sharing requires consent and retains retry controls on unshare failure (new layout: ${newLayoutDesigns})`, async ({
    page,
  }) => {
    await mockStressTimeline(page)
    await installStressTasks(page)
    await page.addInitScript((value) => {
      localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: value } }))
    }, newLayoutDesigns)
    const id = "a".repeat(32)
    const info = {
      id,
      url: `https://vectordev.ai/s/${id}`,
      expiresAt: Date.now() + 604_800_000,
      updatedAt: Date.now(),
      revision: 1,
      updates: false,
    }
    const archive = {
      version: 1,
      engine: "v2",
      title: "Full transcript",
      messages: [
        {
          id: "older-than-compaction",
          role: "user",
          createdAt: 1,
          parts: [{ type: "text", text: "Full history before compaction" }],
        },
        {
          id: "newest-message",
          role: "assistant",
          createdAt: 2,
          parts: [
            {
              type: "tool",
              name: "shell",
              callID: "call",
              status: "completed",
              input: "echo visible",
              output: "Visible result",
            },
            { type: "attachment", name: "image.png", mediaType: "image/png" },
          ],
        },
      ],
    }
    const writes: { method: string; body: unknown }[] = []
    let failRemoval = true
    let activeInfo: typeof info | undefined
    await page.route(
      (url) => url.pathname === `/session/${fixture.sourceID}`,
      (route) => {
        if (route.request().method() !== "GET") return route.fallback()
        return route.fulfill({
          json: {
            ...fixture.sessions.find((session) => session.id === fixture.sourceID),
            share: activeInfo ?? { url: "https://example.invalid/historical-share" },
          },
        })
      },
    )
    await page.route(
      (url) => url.pathname === `/session/${fixture.sourceID}/share/preview`,
      (route) => route.fulfill({ json: archive }),
    )
    await page.route(
      (url) => url.pathname === `/session/${fixture.sourceID}/share`,
      async (route) => {
        const request = route.request()
        writes.push({ method: request.method(), body: request.postDataJSON() })
        if (request.method() === "POST") {
          activeInfo = info
          return route.fulfill({ json: info })
        }
        if (failRemoval)
          return route.fulfill({
            status: 503,
            json: {
              _tag: "PublicSessionError",
              code: "UNAVAILABLE",
              message: "The sharing service is temporarily unavailable.",
            },
          })
        activeInfo = undefined
        return route.fulfill({ json: {} })
      },
    )
    await page.goto(stressSessionHref(fixture.sourceID))
    await expectSessionTitle(page, fixture.expected.sourceTitle)
    const open = async () => {
      await page.getByRole("button", { name: "More options", exact: true }).last().click()
      await page.getByRole("menuitem", { name: "Share publicly…", exact: true }).click()
    }
    await open()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByRole("button", { name: "Publish public copy", exact: true })).toBeDisabled()
    await dialog.getByText("Review included transcript (2 messages)", { exact: true }).click()
    await expect(dialog.getByRole("textbox", { name: "Included transcript" })).toHaveValue(
      /Full history before compaction[\s\S]*Visible result[\s\S]*Attachment: image.png/,
    )
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    expect(writes).toEqual([])
    await open()
    const updates = "Include future updates to this conversation until expiry"
    const remember = "Also allow automatic public sharing of future sessions on this Vector account"
    await expect(dialog.getByLabel(remember, { exact: true })).toBeDisabled()
    await expect(dialog.getByLabel(remember, { exact: true })).not.toBeChecked()
    await dialog.getByText(updates, { exact: true }).click()
    await expect(dialog.getByLabel(remember, { exact: true })).toBeEnabled()
    await dialog.getByText(remember, { exact: true }).click()
    await expect(dialog.getByLabel(remember, { exact: true })).toBeChecked()
    await dialog.getByText(updates, { exact: true }).click()
    await expect(dialog.getByLabel(remember, { exact: true })).not.toBeChecked()
    await expect(dialog.getByLabel(remember, { exact: true })).toBeDisabled()
    await expect(dialog.getByText("Automatic sharing of future sessions requires future updates.")).toBeVisible()
    await dialog.getByText("I have reviewed the included content and want to make it public", { exact: true }).click()
    await dialog.getByLabel("Public copy expiry").selectOption("1")
    await expect(
      dialog.getByLabel("I have reviewed the included content and want to make it public", { exact: true }),
    ).toBeChecked()
    await page.screenshot({ path: test.info().outputPath("public-share-consent.png"), fullPage: true })
    const before = Date.now()
    await dialog.getByRole("button", { name: "Publish public copy", exact: true }).click()
    await expect(dialog.locator("[data-public-share-url]")).toHaveText(info.url)
    expect(writes).toHaveLength(1)
    expect(writes[0].method).toBe("POST")
    expect(writes[0].body).toMatchObject({
      consent: { version: 1, public: true, updates: false },
      remember: false,
      previewHash: createHash("sha256").update(JSON.stringify(archive)).digest("hex"),
    })
    const body = writes[0].body as { expiresAt: number }
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 86_400_000)
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + 86_400_000)
    await dialog.getByRole("button", { name: "Done", exact: true }).click()
    await open()
    await expect(dialog.locator("[data-public-share-url]")).toHaveText(info.url)
    expect(writes).toHaveLength(1)
    await expect(dialog.getByRole("button", { name: "Unshare", exact: true })).toBeDisabled()
    await dialog.getByText("Remove this public copy", { exact: true }).click()
    await dialog.getByRole("button", { name: "Unshare", exact: true }).click()
    await expect(dialog.getByRole("alert")).toContainText("retained so you can retry")
    await expect(dialog.locator("[data-public-share-url]")).toHaveText(info.url)
    failRemoval = false
    await dialog.getByRole("button", { name: "Unshare", exact: true }).click()
    await expect(dialog.getByRole("status")).toHaveText("Public copy removed. The local session is unchanged.")
    await expect(dialog.locator("[data-public-share-url]")).toHaveCount(0)
    expect(writes.map((write) => write.method)).toEqual(["POST", "DELETE", "DELETE"])
  })
}
