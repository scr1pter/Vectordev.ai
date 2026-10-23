import { afterEach, expect, test } from "bun:test"
import { desktopLocal, mayFetch, type DesktopLocal } from "./desktop-local"

const status = (input: Partial<DesktopLocal> = {}): DesktopLocal => ({
  enabled: true,
  held: false,
  sources: { "release-notes": "block", "dictation-model": "ask" },
  ...input,
})

afterEach(() => {
  delete window.api
})

test("lets the app fetch for itself outside the desktop app, and as Vector Local decides inside it", () => {
  expect(mayFetch(undefined, "release-notes")).toBe(true)
  expect(mayFetch(status(), "release-notes")).toBe(false)
  expect(mayFetch(status(), "dictation-model")).toBe(false)
  expect(mayFetch(status({ sources: { "release-notes": "allow" } }), "release-notes")).toBe(true)
  // The first run's hold keeps them back even with Vector Local off.
  expect(mayFetch(status({ enabled: false, held: true, sources: { "release-notes": "allow" } }), "release-notes")).toBe(
    false,
  )
})

test("reads the status from the desktop app, and nothing from one that cannot answer", async () => {
  expect(await desktopLocal()).toBeUndefined()
  window.api = { vectorLocal: { status: async () => status() } }
  expect(await desktopLocal()).toEqual(status())
  window.api = { vectorLocal: { status: () => Promise.reject(new Error("no handler")) } }
  expect(await desktopLocal()).toBeUndefined()
})
