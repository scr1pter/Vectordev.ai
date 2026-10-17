import { describe, expect, test } from "bun:test"
import { parseUnifiedDiff, renderPatch } from "@vectordevai/core/review/diff"
import { packChanges, verifyHeadFiles } from "@vectordevai/core/review/pack"
import { buildReviewPrompt } from "@vectordevai/core/review/prompt"

// Two changed files: a.ts gets one line added at line 2, b.ts has line 2 replaced.
const files = parseUnifiedDiff(
  [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,4 @@",
    " export function a() {",
    "+  check()",
    "   return 1",
    " }",
    "diff --git a/src/b.ts b/src/b.ts",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -1,3 +1,3 @@",
    " export function b() {",
    "-  return 1",
    "+  return 2",
    " }",
    "",
  ].join("\n"),
)
const A = "export function a() {\n  check()\n  return 1\n}\n"
const B = "export function b() {\n  return 2\n}\n"

describe("packChanges", () => {
  test("shows a file with its exact head text once, annotated, instead of its diff and its text", () => {
    const packed = packChanges({
      inline: files,
      headFiles: [
        { path: "src/a.ts", text: A, exact: true },
        { path: "src/b.ts", text: "@@ hunks only", exact: false },
      ],
    })
    expect(packed.headFiles).toEqual([
      {
        path: "src/a.ts",
        text: "1   export function a() {\n2 +   check()\n3     return 1\n4   }",
        exact: true,
        annotated: true,
      },
      { path: "src/b.ts", text: "@@ hunks only", exact: false },
    ])
    expect(packed.diff).toBe(renderPatch([files[1]!]))
    expect(packed.settled).toEqual([])
  })

  test("keeps a head file that does not match the diff as it was", () => {
    const packed = packChanges({
      inline: files,
      headFiles: [{ path: "src/a.ts", text: "something else\n", exact: true }],
    })
    expect(packed.headFiles).toEqual([{ path: "src/a.ts", text: "something else\n", exact: true }])
    expect(packed.diff).toBe(renderPatch(files))
  })

  test("an incremental review shows files with nothing new by their changed lines only", () => {
    const packed = packChanges({
      inline: files,
      headFiles: [
        { path: "src/a.ts", text: A, exact: true },
        { path: "src/b.ts", text: B, exact: true },
      ],
      focus: [{ path: "src/a.ts", start: 1, end: 4 }],
    })
    expect(packed.settled).toEqual(["src/b.ts"])
    expect(packed.headFiles.map((file) => [file.path, file.annotated])).toEqual([["src/a.ts", true]])
    expect(packed.diff).toBe(renderPatch([files[1]!], 0))
    expect(packed.diff).not.toContain(" export function b() {")
  })

  test("annotates the head file of a file the diff budget left out", () => {
    const packed = packChanges({ inline: [], changed: files, headFiles: [{ path: "src/b.ts", text: B, exact: true }] })
    expect(packed.diff).toBe("")
    expect(packed.headFiles[0]).toMatchObject({ path: "src/b.ts", annotated: true })
  })

  test("a review prompt with every file annotated has no empty diff block and is smaller", () => {
    // A 60-line file with lines 21 to 30 rewritten.
    const changed = rewritten(10)
    const headFiles = [{ path: "src/c.ts", text: rewrittenFile(10).text, exact: true }]
    const base = {
      mode: "full",
      trust: "untrusted",
      base: "a".repeat(40),
      head: "b".repeat(40),
      maxComments: 10,
    } as const
    const before = buildReviewPrompt({ ...base, diff: renderPatch(changed), headFiles })
    const packed = packChanges({ inline: changed, headFiles })
    const after = buildReviewPrompt({ ...base, diff: packed.diff, headFiles: packed.headFiles })
    expect(after).not.toContain("<untrusted_diff>")
    expect(after).toContain('annotated="true"')
    expect(after.length).toBeLessThan(before.length)
  })
})

// A 60-line file whose lines 21 to 20 + count were rewritten, with its head text.
function rewrittenFile(count: number) {
  const lines = Array.from({ length: 60 }, (_, index) => `  const value${index + 1} = compute(${index + 1})`)
  const head = lines.map((line, index) => (index >= 20 && index < 20 + count ? line.replace(")", " * 2)") : line))
  const [file] = parseUnifiedDiff(
    [
      "diff --git a/src/c.ts b/src/c.ts",
      "--- a/src/c.ts",
      "+++ b/src/c.ts",
      `@@ -18,${count + 6} +18,${count + 6} @@`,
      ...lines.slice(17, 20).map((line) => " " + line),
      ...lines.slice(20, 20 + count).map((line) => "-" + line),
      ...head.slice(20, 20 + count).map((line) => "+" + line),
      ...lines.slice(20 + count, 23 + count).map((line) => " " + line),
      "",
    ].join("\n"),
  )
  return { file: file!, text: head.join("\n") + "\n" }
}

function rewritten(count: number) {
  return [rewrittenFile(count).file]
}

describe("packChanges: size", () => {
  test("keeps the diff and the full text when a small change to a file would not repay the line numbers", () => {
    const small = rewrittenFile(1)
    const packed = packChanges({
      inline: [small.file],
      headFiles: [{ path: "src/c.ts", text: small.text, exact: true }],
    })
    expect(packed.headFiles).toEqual([{ path: "src/c.ts", text: small.text, exact: true }])
    expect(packed.diff).toBe(renderPatch([small.file]))
  })
})

describe("verifyHeadFiles", () => {
  test("keeps the files the candidates sit in and the files their evidence cites", () => {
    const headFiles = [
      { path: "src/a.ts", text: A, exact: true },
      { path: "src/b.ts", text: B, exact: true },
    ]
    expect(verifyHeadFiles(files, headFiles, [{ path: "src/a.ts" }])!.map((file) => file.path)).toEqual(["src/a.ts"])
    expect(
      verifyHeadFiles(files, headFiles, [{ path: "src/a.ts", evidence: ["./src/b.ts:2"] }])!.map((file) => file.path),
    ).toEqual(["src/a.ts", "src/b.ts"])
    expect(verifyHeadFiles(files, undefined, [{ path: "src/a.ts" }])).toBeUndefined()
  })
})
