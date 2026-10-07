import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createParallelDiffReviewState } from "../src/components/parallel-diff-review"

const binary = (name: string) => `diff --git a/image.png b/image.png\nBinary files a/${name} and b/image.png differ`
const added = (text: string) =>
  `diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+${text}`

function fixture(diff = binary("original.png")) {
  return createRoot((dispose) => {
    const [currentDiff, setDiff] = createSignal(diff)
    const [reviewKey, setReviewKey] = createSignal("worker-a")
    return {
      state: createParallelDiffReviewState({ diff: currentDiff, reviewKey }),
      setDiff,
      setReviewKey,
      [Symbol.dispose]: dispose,
    }
  })
}

describe("parallel diff approval scope", () => {
  test.each([
    ["binary", binary("original.png"), binary("updated.png"), "file:image.png"],
    ["new file", added("first()"), added("second()"), "file:new.ts"],
  ])("changed %s contents require new approval at the same file path", (_kind, before, after, key) => {
    using f = fixture(before)
    f.state.decide(key, "accepted")
    expect(f.state.choices()[key]).toBe("accepted")
    f.setDiff(after)
    expect(f.state.choices()[key]).toBeUndefined()
    f.state.decide(key, "accepted")
    expect(f.state.choices()[key]).toBe("accepted")
  })

  test("switching workspaces clears approval even when their diffs are identical", () => {
    using f = fixture()
    f.state.decide("file:image.png", "accepted")
    f.state.decide("other-hunk", "rejected")
    f.setReviewKey("worker-b")
    expect(Object.keys(f.state.choices())).toEqual([])
    f.setReviewKey("worker-a")
    expect(Object.keys(f.state.choices())).toEqual([])
  })

  test("old merge completion cannot clear new approvals after returning to the same review", () => {
    using f = fixture()
    f.state.decide("file:image.png", "accepted")
    const previous = f.state.beginMerge()
    expect(f.state.merging()).toBe(true)
    f.setReviewKey("worker-b")
    f.setReviewKey("worker-a")
    f.state.decide("file:image.png", "accepted")
    previous(true)
    expect(f.state.choices()["file:image.png"]).toBe("accepted")
    expect(f.state.merging()).toBe(false)
  })

  test("old merge completion cannot release a newer merge's busy state", () => {
    using f = fixture()
    const previous = f.state.beginMerge()
    f.setDiff(binary("updated.png"))
    f.state.decide("file:image.png", "accepted")
    const current = f.state.beginMerge()
    previous(true)
    expect(f.state.merging()).toBe(true)
    expect(f.state.choices()["file:image.png"]).toBe("accepted")
    current(true)
    expect(f.state.merging()).toBe(false)
    expect(Object.keys(f.state.choices())).toEqual([])
  })

  test("a failed merge keeps its approvals available for retry", () => {
    using f = fixture()
    f.state.decide("file:image.png", "accepted")
    const finish = f.state.beginMerge()
    finish(false)
    expect(f.state.merging()).toBe(false)
    expect(f.state.choices()["file:image.png"]).toBe("accepted")
    f.state.beginMerge()(true)
    expect(Object.keys(f.state.choices())).toEqual([])
  })

  test("completion after disposal cannot mutate the abandoned review", () => {
    const f = fixture()
    f.state.decide("file:image.png", "accepted")
    const finish = f.state.beginMerge()
    f[Symbol.dispose]()
    finish(true)
    expect(f.state.choices()["file:image.png"]).toBe("accepted")
  })
})
