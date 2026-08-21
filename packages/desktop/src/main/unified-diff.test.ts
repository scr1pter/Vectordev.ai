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

// Regression: parseUnifiedDiff used to normalise \r\n to \n across the whole
// diff, so a CRLF file's rebuilt patch lost the CRs that were in the file on
// disk and git rejected it. Proven against real git rather than by comparing
// strings, because "does git apply accept this" is the actual contract.
describe("CRLF files", () => {
  test("a selected hunk still applies to the real file", async () => {
    const { execFile } = await import("node:child_process")
    const { mkdtemp, writeFile } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const run = (args: string[], cwd: string, input?: string) =>
      new Promise<{ code: number; stderr: string }>((resolve) => {
        const child = execFile("git", args, { cwd }, (error, _stdout, stderr) =>
          resolve({ code: error ? 1 : 0, stderr: String(stderr) }),
        )
        if (input !== undefined) {
          child.stdin?.write(input)
          child.stdin?.end()
        }
      })

    const dir = await mkdtemp(join(tmpdir(), "vector-crlf-"))
    await run(["init", "-q"], dir)
    await run(["config", "user.email", "test@vector.test"], dir)
    await run(["config", "user.name", "Vector Test"], dir)
    // -text keeps git from translating the line endings underneath the test.
    await writeFile(join(dir, ".gitattributes"), "* -text\n", "utf8")
    await writeFile(join(dir, "win.txt"), "alpha\r\nbeta\r\ngamma\r\n", "utf8")
    await run(["add", "-A"], dir)
    await run(["commit", "-qm", "init"], dir)
    await writeFile(join(dir, "win.txt"), "alpha\r\nBETA\r\ngamma\r\n", "utf8")

    const raw = await new Promise<string>((resolve) => {
      execFile("git", ["diff", "--no-ext-diff", "HEAD", "--"], { cwd: dir }, (_error, stdout) =>
        resolve(String(stdout)),
      )
    })
    expect(raw.includes("\r")).toBe(true)

    const parsed = parseUnifiedDiff(raw)
    const hunkIds = parsed.flatMap((file) => file.hunks.map((hunk) => hunk.id))
    expect(hunkIds.length).toBeGreaterThan(0)
    const selected = selectUnifiedDiff(raw, { hunkIds })
    expect(selected.includes("\r")).toBe(true)

    // Reset the file and confirm git accepts the rebuilt patch.
    await run(["checkout", "--", "win.txt"], dir)
    // --3way --check reports success on stderr ("Applied patch ... cleanly."),
    // so the exit code is the signal; a rejection says "patch does not apply".
    const check = await run(["apply", "--3way", "--check", "-"], dir, selected)
    expect(check.stderr).not.toContain("does not apply")
    expect(check.code).toBe(0)
  })
})
