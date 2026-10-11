import { describe, expect, test } from "bun:test"
import type { Session } from "@vectordevai/sdk/v2"
import { notifyVisibleSession } from "../../../../src/util/session"

const session = (internal?: string, parentID?: string): Session => ({
  id: "session",
  slug: "session",
  title: "Session",
  directory: "/repo",
  projectID: "project",
  version: "1",
  time: { created: 1, updated: 1 },
  ...(internal ? { internal } : {}),
  ...(parentID ? { parentID } : {}),
})

describe("session attention visibility", () => {
  test("an unseen helper cannot show an error toast while its metadata is loading after reconnect", async () => {
    const pending = Promise.withResolvers<Session | undefined>()
    const shown: (Session | undefined)[] = []
    const result = notifyVisibleSession({
      sessionID: "session",
      cached: () => undefined,
      read: () => pending.promise,
      show: (value) => shown.push(value),
    })
    expect(shown).toEqual([])
    pending.resolve(session("vectorscope.review"))
    await result
    expect(shown).toEqual([])
  })

  test("ordinary sessions and deliberately opened subagents still receive attention", async () => {
    const shown: (Session | undefined)[] = []
    const root = session()
    const child = session(undefined, "parent")
    notifyVisibleSession({
      sessionID: root.id,
      cached: () => root,
      read: async () => undefined,
      show: (value) => shown.push(value),
    })
    expect(shown).toEqual([root])
    await notifyVisibleSession({
      sessionID: child.id,
      cached: () => undefined,
      read: async () => child,
      show: (value) => shown.push(value),
    })
    expect(shown).toEqual([root, child])
  })

  test("failed metadata reads suppress session attention while global errors remain visible", async () => {
    const shown: (Session | undefined)[] = []
    await notifyVisibleSession({
      sessionID: "missing",
      cached: () => undefined,
      read: async () => {
        throw new Error("offline")
      },
      show: (value) => shown.push(value),
    })
    expect(shown).toEqual([])
    notifyVisibleSession({ cached: () => undefined, read: async () => undefined, show: (value) => shown.push(value) })
    expect(shown).toEqual([undefined])
  })
})
