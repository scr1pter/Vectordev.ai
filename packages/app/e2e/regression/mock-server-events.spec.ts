import { expect, test } from "@playwright/test"
import { mockVectorServer } from "../utils/mock-server"

test("keeps global event envelopes separate from directory presence payloads", async ({ page }) => {
  const directory = "/vector/sse-isolation"
  const globalEvent = { directory, payload: { type: "session.deleted", properties: { id: "session-fixture" } } }
  const presenceEvent = { type: "client.joined", properties: { clientID: "peer", username: "Teammate", at: 1 } }
  const globalEvents = [globalEvent]
  const directoryEvents = [presenceEvent]
  await page.route("**/sse-fixture", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }))
  await mockVectorServer(page, {
    directory,
    provider: {},
    project: {},
    sessions: [],
    pageMessages: () => ({ items: [] }),
    events: () => globalEvents.splice(0, 1),
    directoryEvents: () => directoryEvents.splice(0, 1),
  })
  await page.goto("/sse-fixture")

  const presence = await page.evaluate(async () => (await fetch("/event")).text())
  expect(presence).toBe(`data: ${JSON.stringify(presenceEvent)}\n\n`)
  expect(globalEvents).toEqual([globalEvent])
  expect(directoryEvents).toEqual([])
  const global = await page.evaluate(async () => (await fetch("/global/event")).text())
  expect(global).toBe(`data: ${JSON.stringify(globalEvent)}\n\n`)
  expect(globalEvents).toEqual([])

  globalEvents.push(globalEvent)
  expect(await page.evaluate(async () => (await fetch("/event")).text())).toBe(": ok\n\n")
  expect(globalEvents).toEqual([globalEvent])
  directoryEvents.push(presenceEvent)
  const concurrent = await page.evaluate(() =>
    Promise.all(["/global/event", "/event"].map(async (path) => (await fetch(path)).text())),
  )
  expect(concurrent).toEqual([`data: ${JSON.stringify(globalEvent)}\n\n`, `data: ${JSON.stringify(presenceEvent)}\n\n`])
  expect(globalEvents).toEqual([])
  expect(directoryEvents).toEqual([])
})
