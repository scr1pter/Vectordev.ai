import { describe, expect, test } from "bun:test"
import { parseReviewDiff, reviewRows } from "./unified-diff"

const patch = `diff --git a/src/view.tsx b/src/view.tsx
index 1111111..2222222 100644
--- a/src/view.tsx
+++ b/src/view.tsx
@@ -3,3 +3,4 @@
 export function View() {
-  return <div>Old</div>
+  const label = "New"
+  return <div>{label}</div>
 }
`

describe("review diff presentation", () => {
  test("aligns removed and added lines for side-by-side review", () => {
    const file = parseReviewDiff(patch)[0]!
    expect(file.path).toBe("src/view.tsx")
    expect(file.supportsHunks).toBe(true)

    const rows = reviewRows(file.hunks[0]!)
    expect(rows[0]).toMatchObject({ oldLine: 3, newLine: 3, kind: "context" })
    expect(rows[1]).toMatchObject({ oldText: "  return <div>Old</div>", newText: '  const label = "New"' })
    expect(rows[2]).toMatchObject({ oldText: undefined, newText: "  return <div>{label}</div>" })
  })
})
