import { describe, expect, test } from "bun:test"
import { createMemo, createRoot, createSignal } from "solid-js"
import { sameWorkspaceRevisions } from "@/utils/workspace-revisions"

// The agent workspace list is polled every second or so, and the desktop's list call returns fresh objects each time.
const poll = (revisions: Record<string, number>) =>
  Object.entries(revisions).map(([id, revision]) => ({ id, revision, name: `Agent ${id}` }))

describe("polled agent workspaces", () => {
  test("a poll that returns the same records at the same revisions rebuilds nothing", () => {
    createRoot((dispose) => {
      const [records, setRecords] = createSignal(poll({ a: 3, b: 7 }), { equals: sameWorkspaceRevisions })
      const builds = { count: 0 }
      const rows = createMemo(() => {
        builds.count += 1
        return records().map((record) => record.name)
      })
      rows()
      // A minute of polling at 1.5 s with nothing changing.
      for (let tick = 0; tick < 40; tick++) {
        setRecords(poll({ a: 3, b: 7 }))
        rows()
      }
      expect(builds.count).toBe(1)

      // A write, a reorder and a removal each rebuild once.
      setRecords(poll({ a: 4, b: 7 }))
      rows()
      setRecords(poll({ b: 7, a: 4 }))
      rows()
      setRecords(poll({ a: 4 }))
      rows()
      expect(builds.count).toBe(4)
      dispose()
    })
  })
})
