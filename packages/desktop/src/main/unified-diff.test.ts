import { describe, expect, test } from "bun:test"
import { parseUnifiedDiff, selectUnifiedDiff } from "./unified-diff"

const patch = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
-const title = "Old"
+const title = "New"
 export { title }

@@ -8,2 +8,3 @@
 export function ready() {
+  console.info("ready")
 }
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1 @@
+export const created = true
`

describe("unified diff selection", () => {
  test("selects one tracked-file hunk without including the other", () => {
    const files = parseUnifiedDiff(patch)
    const tracked = files[0]!
    expect(tracked.supportsHunks).toBe(true)
    expect(tracked.hunks).toHaveLength(2)

    const selected = selectUnifiedDiff(patch, { hunkIds: [tracked.hunks[1]!.id] })
    expect(selected).toContain('console.info("ready")')
    expect(selected).not.toContain('const title = "New"')
    expect(selected).not.toContain("src/new.ts")
  })

  test("requires whole-file selection for newly created files", () => {
    const created = parseUnifiedDiff(patch)[1]!
    expect(created.supportsHunks).toBe(false)
    expect(() => selectUnifiedDiff(patch, { hunkIds: [created.hunks[0]!.id] })).toThrow(
      "src/new.ts can only be merged as a complete file.",
    )
    expect(selectUnifiedDiff(patch, { files: ["src/new.ts"] })).toContain("new file mode")
  })
})
