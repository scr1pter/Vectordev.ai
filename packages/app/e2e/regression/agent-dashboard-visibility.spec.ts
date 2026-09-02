import { expect, test } from "@playwright/test"
import { readFile } from "node:fs/promises"

const stylesheet = await readFile(new URL("../../src/features/agents/agent-dashboard.css", import.meta.url), "utf8")

test("the native window chrome never covers the Agent Dashboard", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.setContent(`
    <html data-vector-native-chrome="macos" style="--vector-native-chrome-height: 40px">
      <style>
        * { box-sizing: border-box; }
        html, body { height: 100%; margin: 0; }
        [data-vector-agent-dashboard] { position: fixed; inset: 0; display: flex; flex-direction: column; }
        [data-vector-agent-dashboard-header] { height: 60px; flex: none; }
        [data-vector-agent-dashboard-main] { min-height: 0; flex: 1; overflow: auto; }
        ${stylesheet}
      </style>
      <section data-vector-agent-dashboard>
        <header data-vector-agent-dashboard-header>
          <h1>Agent Dashboard</h1>
          <button aria-label="Close Agent Dashboard">Close</button>
        </header>
        <main data-vector-agent-dashboard-main>Agent board</main>
      </section>
    </html>
  `)

  const dashboard = (await page.locator("[data-vector-agent-dashboard]").boundingBox())!
  const header = (await page.locator("[data-vector-agent-dashboard-header]").boundingBox())!
  const main = (await page.locator("[data-vector-agent-dashboard-main]").boundingBox())!

  expect(dashboard.y).toBe(40)
  expect(dashboard.height).toBe(680)
  expect(header.y).toBe(40)
  expect(main.y).toBe(100)
  expect(main.y + main.height).toBeLessThanOrEqual(720)
  await expect(page.getByRole("heading", { name: "Agent Dashboard" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Close Agent Dashboard" })).toBeVisible()
})

test("the Agent Dashboard still fills the browser viewport on the web", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 })
  await page.setContent(`
    <style>
      * { box-sizing: border-box; }
      html, body { height: 100%; margin: 0; }
      [data-vector-agent-dashboard] { position: fixed; inset: 0; }
      ${stylesheet}
    </style>
    <section data-vector-agent-dashboard>Agent Dashboard</section>
  `)

  expect(await page.locator("[data-vector-agent-dashboard]").boundingBox()).toEqual({
    x: 0,
    y: 0,
    width: 960,
    height: 640,
  })
})
