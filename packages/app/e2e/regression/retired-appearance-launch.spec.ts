import { expect, test } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/RetiredAppearanceLaunch"
const sessionID = "ses_retired_appearance_launch"
const project = { id: "project-retired-appearance", worktree: directory, vcs: "git", name: "Retired appearance" }

// The computer's language. The language saved below is German; Vector follows the computer instead.
test.use({ locale: "fr-FR", colorScheme: "light" })

test("choices saved on the removed Appearance, Editor and Chat pages no longer apply", async ({ page }) => {
  await mockVectorServer(page, {
    directory,
    project,
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: sessionID,
        title: "Retired appearance",
        directory,
        projectID: project.id,
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript((projectDirectory) => {
    // Seeded once: the preload rewrites the theme keys, and a reload must find what this launch left.
    if (sessionStorage.getItem("seeded")) return
    sessionStorage.setItem("seeded", "1")
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({
        general: { newLayoutDesigns: true },
        appearance: {
          theme: "light",
          accentColor: "#ff0000",
          workspaceColor: "#ffffff",
          fontSize: 19,
          roundedCorners: false,
          glassmorphism: false,
          reduceAnimations: true,
        },
        editor: { fontSize: 22, lineHeight: 2.1, wordWrap: false, showLineNumbers: false, aiAutocomplete: false },
        chat: { chatWidth: "full", messageSpacing: "relaxed" },
      }),
    )
    localStorage.setItem("vector-theme-id", "dracula")
    localStorage.setItem("vector-color-scheme", "light")
    localStorage.setItem("vector-theme-css-light", "--background-base:#ffffff;")
    localStorage.setItem("vector.global.dat:language", JSON.stringify({ locale: "de" }))
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
  await expectSessionTitle(page, "Retired appearance")

  const applied = () =>
    page.evaluate(() => {
      const root = document.documentElement
      const style = getComputedStyle(root)
      return {
        lang: root.lang,
        theme: root.dataset.theme,
        vectorTheme: root.dataset.vectorTheme,
        scheme: root.dataset.colorScheme,
        colorScheme: style.colorScheme,
        accent: root.style.getPropertyValue("--vector-accent"),
        workspace: root.style.getPropertyValue("--vector-workspace-bg"),
        uiFontSize: root.style.getPropertyValue("--vector-ui-font-size"),
        radius: root.style.getPropertyValue("--vector-radius-card"),
        glass: root.dataset.vectorGlass,
        editorFontSize: root.style.getPropertyValue("--vector-editor-font-size"),
        editorLineHeight: root.style.getPropertyValue("--vector-editor-line-height"),
        wordWrap: root.dataset.vectorEditorWordWrap,
        lineNumbers: root.dataset.vectorEditorLineNumbers,
        chatWidth: root.dataset.vectorChatWidth,
        spacing: root.dataset.vectorMessageSpacing,
        reduceMotion: root.dataset.vectorReduceAnimations,
        themeId: localStorage.getItem("vector-theme-id"),
        storedScheme: localStorage.getItem("vector-color-scheme"),
        cachedCss: localStorage.getItem("vector-theme-css-light"),
      }
    })
  const expected = {
    lang: "fr",
    theme: "vector-modern",
    vectorTheme: "dark",
    scheme: "dark",
    colorScheme: "dark",
    accent: "#9b6cff",
    workspace: "#1d1d1f",
    uiFontSize: "14px",
    radius: "18px",
    glass: "true",
    editorFontSize: "14px",
    editorLineHeight: "1.6",
    wordWrap: "true",
    lineNumbers: "true",
    chatWidth: "focused",
    spacing: "comfortable",
    // Accessibility still sets reduced motion, so it is kept.
    reduceMotion: "true",
    themeId: "vector-modern",
    storedScheme: "dark",
    cachedCss: null,
  }
  await expect.poll(applied).toEqual(expected)

  await page.reload()
  await expectSessionTitle(page, "Retired appearance")
  await expect.poll(applied).toEqual(expected)

  // Restore default settings restores Vector's defaults, not whatever had been saved.
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await page.locator(".settings-v2-workspace").getByRole("button", { name: "Restore default settings" }).click()
  await expect.poll(applied).toEqual({ ...expected, reduceMotion: "false" })
})

test("the first frame is dark before the app loads, on a light computer with a saved Light theme", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("vector-theme-id", "solarized")
    localStorage.setItem("vector-color-scheme", "light")
    localStorage.setItem("vector-theme-css-light", "--background-base:#ffffff;")
  })
  // Without the app's code, only the preload has run: this is what the window shows first.
  await page.route("**/src/entry.tsx", (route) => route.abort())
  await page.goto("/")

  const painted = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    scheme: document.documentElement.dataset.colorScheme,
    background: getComputedStyle(document.documentElement).backgroundColor,
    cachedCss: Boolean(document.getElementById("vector-theme-preload")),
    meta: document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
  }))
  expect(painted).toEqual({
    theme: "vector-modern",
    scheme: "dark",
    background: "rgb(8, 8, 8)",
    cachedCss: false,
    meta: "#080808",
  })
})
