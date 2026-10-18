import { expect, test } from "bun:test"
import { PRODUCT_DOCUMENTATION } from "../api/help/chat"

// The hosted Help assistant answers for every desktop build, so its Settings entry has to be true for builds from
// before Appearance, Chat, Editor, Voice and Personalization were removed and for the ones after.
test("the Help assistant describes Settings as it is in every build", () => {
  const settings = PRODUCT_DOCUMENTATION.find((doc) => doc.title === "Settings")
  expect(settings?.where).toBe(
    "Your name or the gear at the bottom of the sidebar, or Cmd+, (Ctrl+, on Windows and Linux).",
  )
  const text = `${settings?.where} ${settings?.body}`
  for (const removed of ["appearance", "keybindings", "personalization", "voice", "editor", "theme"])
    expect(text.toLowerCase()).not.toContain(removed)
  expect(text).not.toMatch(/project/i)
})
