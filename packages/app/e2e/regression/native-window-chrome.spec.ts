import { expect, test } from "@playwright/test"
import { readFile } from "node:fs/promises"
import { nativeWindowChromeLayout } from "../../src/components/native-window-chrome-layout"

const stylesheet = await readFile(new URL("../../src/components/native-window-chrome.css", import.meta.url), "utf8")

for (const os of ["macos", "windows"] as const) {
  test(`${os} native chrome protects every fullscreen surface without session tabs`, async ({ page }) => {
    const layout = nativeWindowChromeLayout({ enabled: true, platform: "desktop", os })!
    await page.setContent(`
      <html data-vector-native-chrome="${os}" style="--vector-native-chrome-height:${layout.height}px">
      <style>*{box-sizing:border-box}html,body{margin:0;height:100%}
        [data-vector-shell]{height:100%;display:flex;flex-direction:column}
        [data-vector-navigation]{position:fixed;inset:0 auto 0 0;width:280px;padding-top:48px}
        [data-vector-codespace],[data-component=dialog-v2],[data-vector-agent-launcher-overlay]{position:fixed;inset:0}
        [data-vector-agent-launcher-overlay]{display:flex;align-items:center;padding:20px}
        [data-vector-agent-launcher]{height:100vh;overflow:auto}
        [data-vector-floating-sidebar-toggle]{position:fixed;top:11px}
        ${stylesheet}</style>
      <div data-vector-native-window-chrome><div data-vector-native-window-drag style="left:${layout.left}px;right:${layout.right}px"></div></div>
      <div data-vector-shell><main><button>Home</button><button>Agent</button></main></div>
      <nav data-vector-navigation><button>Agent / Editor</button></nav>
      <button data-vector-floating-sidebar-toggle>Show sidebar</button>
      </html>`)
    const chrome = page.locator("[data-vector-native-window-chrome]")
    await expect(chrome).toHaveCSS("height", "40px")
    await expect(page.locator("[data-vector-native-window-drag]")).toHaveCSS("app-region", "drag")
    expect((await page.locator("main").boundingBox())!.y).toBe(40)
    expect((await page.locator("nav").boundingBox())!.y).toBe(40)
    await expect(page.locator("nav")).toHaveCSS("padding-top", "0px")
    await page.locator("nav").evaluate((element) => {
      element.style.display = "none"
    })
    expect((await page.locator("[data-vector-floating-sidebar-toggle]").boundingBox())!.y).toBe(51)

    for (const surface of [
      "<div data-vector-codespace>Editor file tabs</div>",
      '<div data-component="dialog-v2" data-variant="settings"><div data-slot="dialog-container"><div data-slot="dialog-content" class="settings-v2-dialog">Settings</div></div></div>',
      "<div data-vector-agent-launcher-overlay><form data-vector-agent-launcher>Launch agent</form></div>",
    ]) {
      await page.locator("body").evaluate((body, html) => body.insertAdjacentHTML("beforeend", html), surface)
      const overlay = page.locator("body > div").last()
      const bounds = (await overlay.boundingBox())!
      expect(bounds.y).toBe(40)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height)
      await expect(chrome).toHaveCSS("z-index", "2147483647")
      await overlay.evaluate((element) => element.remove())
    }
    await expect(page.locator('[data-slot="titlebar-tabs"]')).toHaveCount(0)
  })
}

test("native chrome styles do not change web geometry", async ({ page }) => {
  await page.setContent(
    `<style>body{margin:0}[data-vector-shell]{height:100vh;padding-top:0}${stylesheet}</style><div data-vector-shell>Home</div>`,
  )
  await expect(page.locator("[data-vector-shell]")).toHaveCSS("padding-top", "0px")
  await expect(page.locator("[data-vector-native-window-chrome]")).toHaveCount(0)
})
