import { expect, test } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/LightThemeLaunch"
const sessionID = "ses_light_theme_launch"
const project = { id: "project-light-theme-launch", worktree: directory, vcs: "git", name: "Light theme launch" }

const luminance = (color: string) => {
  const [r, g, b] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map((value) => {
    const channel = Number(value) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

test("a saved Light theme applies from launch and the empty-session headline stays readable", async ({ page }) => {
  await mockVectorServer(page, {
    directory,
    project,
    provider: { all: [], connected: [], default: {} },
    sessions: [{ id: sessionID, title: "Light theme launch", directory, projectID: project.id, time: { created: 1, updated: 1 } }],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript((projectDirectory) => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({ general: { newLayoutDesigns: true }, appearance: { theme: "light" } }),
    )
    localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
    localStorage.setItem(
      "vector.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: projectDirectory, expanded: true }] },
        lastProject: { local: projectDirectory },
      }),
    )
  }, directory)

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, "Light theme launch")
  const headline = page.getByRole("heading", { name: "What can I do for you?" })
  await expect(headline).toBeVisible()
  await page.waitForTimeout(500)

  const root = await page.evaluate(() => ({
    theme: document.documentElement.dataset.vectorTheme,
    scheme: document.documentElement.dataset.colorScheme,
    css: getComputedStyle(document.documentElement).colorScheme,
  }))
  expect(root).toEqual({ theme: "light", scheme: "light", css: "light" })

  // The headline sits on the session route's canvas; light text on it, or dark on a dark one, was unreadable.
  const colors = await headline.evaluate((element) => {
    let surface = element.parentElement
    while (surface && ["rgba(0, 0, 0, 0)", "transparent"].includes(getComputedStyle(surface).backgroundColor)) {
      surface = surface.parentElement
    }
    return {
      text: getComputedStyle(element).color,
      background: surface ? getComputedStyle(surface).backgroundColor : getComputedStyle(document.documentElement).backgroundColor,
    }
  })
  const [light, dark] = [luminance(colors.text), luminance(colors.background)].toSorted((a, b) => b - a)
  expect((light + 0.05) / (dark + 0.05), JSON.stringify(colors)).toBeGreaterThan(4.5)
})
