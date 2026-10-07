import { describe, expect, test } from "bun:test"
import { resolveFileDiff } from "../../components/session-diff"
import { reviewSnippet } from "./session-review-snippet"

const lines = (count: number, name = "line") => Array.from({ length: count }, (_, i) => `${name} ${i + 1}\n`).join("")

describe("reviewSnippet", () => {
  test("shows the hunk header, two lines of leading context, the change and trailing context", () => {
    const before = lines(12)
    const after = before.replace("line 6\n", "changed 6\n")
    const snippet = reviewSnippet(resolveFileDiff({ file: "a.ts", before, after }))

    // Pierre keeps four lines of context around a change.
    expect(snippet?.header).toBe("@@ -2,9 +2,9 @@")
    expect(snippet?.rows).toEqual([
      { kind: "ctx", text: " line 4" },
      { kind: "ctx", text: " line 5" },
      { kind: "del", text: "-line 6" },
      { kind: "add", text: "+changed 6" },
      { kind: "ctx", text: " line 7" },
      { kind: "ctx", text: " line 8" },
    ])
    expect(snippet?.more).toEqual({ unit: "lines", count: 4 })
  })

  test("caps a long change block at six rows", () => {
    const before = lines(4)
    const after = before.replace("line 2\n", lines(20, "new"))
    const snippet = reviewSnippet(resolveFileDiff({ file: "a.ts", before, after }))

    expect(snippet?.rows).toHaveLength(6)
    expect(snippet?.rows.map((row) => row.kind)).toEqual(["ctx", "del", "add", "add", "add", "add"])
    expect(snippet?.more).toEqual({ unit: "lines", count: 18 })
  })

  test("counts the hunks after the first", () => {
    const before = lines(60)
    const after = before.replace("line 5\n", "edit 5\n").replace("line 30\n", "edit 30\n").replace("line 55\n", "edit 55\n")
    const snippet = reviewSnippet(resolveFileDiff({ file: "a.ts", before, after }))

    expect(snippet?.header.startsWith("@@ -1,")).toBe(true)
    expect(snippet?.rows.find((row) => row.kind === "add")?.text).toBe("+edit 5")
    expect(snippet?.more).toEqual({ unit: "hunks", count: 2 })
  })

  test("previews a new file as additions", () => {
    const snippet = reviewSnippet(
      resolveFileDiff({
        file: "new.ts",
        patch: "diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\t\n@@ -0,0 +1,3 @@\n+one\n+two\n+three\n",
      }),
    )

    expect(snippet?.header).toBe("@@ -0,0 +1,3 @@")
    expect(snippet?.rows).toEqual([
      { kind: "add", text: "+one" },
      { kind: "add", text: "+two" },
      { kind: "add", text: "+three" },
    ])
    expect(snippet?.more).toBeUndefined()
  })

  test("previews a deleted file as deletions", () => {
    const snippet = reviewSnippet(resolveFileDiff({ file: "old.ts", before: lines(8), after: "" }))

    expect(snippet?.header).toBe("@@ -1,8 +0,0 @@")
    expect(snippet?.rows.every((row) => row.kind === "del")).toBe(true)
    expect(snippet?.rows[0]?.text).toBe("-line 1")
    expect(snippet?.more).toEqual({ unit: "lines", count: 2 })
  })

  test("has no snippet for an empty patch", () => {
    expect(reviewSnippet(resolveFileDiff({ file: "empty.ts", patch: "" }))).toBeUndefined()
  })
})
