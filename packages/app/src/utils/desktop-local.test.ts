import { afterEach, expect, test } from "bun:test"
import { afterFirstRun, desktopLocal, mayFetch, type DesktopLocal } from "./desktop-local"

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

test("runs what the first run's hold kept back once the person has answered, in the same window", async () => {
  const held = { current: true }
  const asked = { count: 0 }
  window.api = {
    vectorLocal: {
      status: async () => {
        asked.count++
        return status({ held: held.current, sources: { "release-notes": "allow" } })
      },
    },
  }
  const ran: (DesktopLocal | undefined)[] = []
  const stop = afterFirstRun((local) => void ran.push(local), 1)
  while (asked.count < 5) await new Promise((resolve) => setTimeout(resolve, 2))
  expect(ran).toEqual([])
  held.current = false
  while (ran.length === 0) await new Promise((resolve) => setTimeout(resolve, 2))
  expect(ran).toEqual([status({ sources: { "release-notes": "allow" } })])
  expect(mayFetch(ran[0], "release-notes")).toBe(true)
  stop()
  // Outside the desktop app, or with nothing held, it runs at once; a stopped wait never runs.
  delete window.api
  const outside: unknown[] = []
  afterFirstRun((local) => void outside.push(local ?? "browser"))
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(outside).toEqual(["browser"])
  window.api = { vectorLocal: { status: async () => status({ held: true }) } }
  const never: unknown[] = []
  afterFirstRun((local) => void never.push(local), 1)()
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(never).toEqual([])
})
