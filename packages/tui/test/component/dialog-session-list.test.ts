import { describe, expect, test } from "bun:test"
import { createDialogSessionListQuery, loadDialogSessionList } from "../../src/component/dialog-session-list"

describe("dialog session list", () => {
  test("requests root sessions for the default browse list", () => {
    expect(createDialogSessionListQuery({ filter: { path: "packages/tui" } })).toEqual({
      roots: true,
      limit: 100,
      path: "packages/tui",
    })
  })

  test("requests root sessions for search results", () => {
    expect(createDialogSessionListQuery({ search: " deploy ", filter: { scope: "project" } })).toEqual({
      roots: true,
      limit: 30,
      search: "deploy",
      scope: "project",
    })
  })

  test("keeps the cache usable while the root request is pending", async () => {
    let resolve!: (result: { data: { title: string }[] }) => void
    const pending = loadDialogSessionList<{ title: string }>({
      filter: {},
      list: () => new Promise((done) => (resolve = done)),
    })

    expect(await Promise.race([pending, Promise.resolve("pending")])).toBe("pending")
    resolve({ data: [{ title: "root" }] })
    expect(await pending).toEqual([{ title: "root" }])
  })

  test("leaves out Vector's helpers, also from an engine that predates the helper marker", async () => {
    const sessions = [
      { title: "fix the login form" },
      { title: "Autocomplete", internal: "codespace.autocomplete" },
      { title: "Vector Tool · Autocomplete" },
      { title: "Vectorscope review · 1a2b3c4 · review" },
      { title: "Vector review · #12 · review" },
    ]
    expect(await loadDialogSessionList({ filter: {}, list: async () => ({ data: sessions }) })).toEqual([
      { title: "fix the login form" },
    ])
  })

  test("falls back when the root request returns an error response", async () => {
    expect(await loadDialogSessionList({ filter: {}, list: async () => ({}) })).toBeUndefined()
  })

  test("falls back when the root request rejects", async () => {
    expect(
      await loadDialogSessionList({
        filter: {},
        list: () => Promise.reject(new Error("offline")),
      }),
    ).toBeUndefined()
  })
})
