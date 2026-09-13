import { describe, expect, test } from "bun:test"
import {
  EDIT_TOOLS,
  editTargets,
  intentRange,
  landingPath,
  predatesEdit,
  TYPING_MAX_CHARS,
  typingPlan,
  typingSteps,
  type TypingPlan,
} from "./agent-edit-intent"

describe("editTargets", () => {
  test("covers the three tools that edit files", () => {
    expect([...EDIT_TOOLS].sort()).toEqual(["apply_patch", "edit", "write"])
  })

  test("reads an edit call", () => {
    expect(editTargets("edit", { filePath: "/repo/src/a.ts", oldString: "a", newString: "b" })).toEqual([
      { file: "/repo/src/a.ts", kind: "edit", oldText: "a", newText: "b" },
    ])
  })

  test("reads a write call with a relative path", () => {
    expect(editTargets("write", { filePath: "src/a.ts", content: "x" })).toEqual([
      { file: "src/a.ts", kind: "write", newText: "x" },
    ])
  })

  test("is empty for other tools, missing paths or missing input", () => {
    expect(editTargets("read", { filePath: "a" })).toEqual([])
    expect(editTargets("edit", {})).toEqual([])
    expect(editTargets("apply_patch", { patch: "x" })).toEqual([])
    expect(editTargets("edit", undefined)).toEqual([])
  })

  test("reads every file an apply_patch adds, updates, moves or deletes", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+export const a = 1",
      "*** Update File: /repo/src/old.ts",
      "*** Move to: /repo/src/moved.ts",
      "@@ function one",
      " keep",
      "-two",
      "+TWO",
      "*** Delete File: src/gone.ts",
      "*** End Patch",
    ].join("\n")
    const targets = editTargets("apply_patch", { patchText })
    expect(targets.map((target) => [target.kind, target.file, target.movePath])).toEqual([
      ["add", "src/new.ts", undefined],
      ["update", "/repo/src/old.ts", "/repo/src/moved.ts"],
      ["delete", "src/gone.ts", undefined],
    ])
    expect(targets[0]!.newText).toBe("export const a = 1")
    expect(targets[1]!.chunks).toEqual([
      { oldLines: ["keep", "two"], newLines: ["keep", "TWO"], changeContext: "function one" },
    ])
    expect(landingPath(targets[1]!)).toBe("/repo/src/moved.ts")
    expect(landingPath(targets[0]!)).toBe("src/new.ts")
  })

  test("falls back to the file headers when the patch does not parse", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "*** Move to: src/b.ts",
      "this line is not a chunk",
      "*** Add File: src/c.ts",
      "*** End Patch",
    ].join("\n")
    expect(
      editTargets("apply_patch", { patchText }).map((target) => [target.kind, target.file, target.movePath]),
    ).toEqual([
      ["update", "src/a.ts", "src/b.ts"],
      ["add", "src/c.ts", undefined],
    ])
  })

  test("still names the file of a patch with no end marker", () => {
    const patchText = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b"
    expect(editTargets("apply_patch", { patchText }).map((target) => target.file)).toEqual(["src/a.ts"])
  })
})

describe("intentRange", () => {
  const buffer = "one\ntwo\nthree\nfour\n"

  test("finds the text an edit replaces", () => {
    expect(intentRange(buffer, { file: "a", kind: "edit", oldText: "three\nfour" })).toEqual({ start: 3, end: 4 })
  })

  test("lands on line 1 for an edit that creates the file", () => {
    expect(intentRange(undefined, { file: "a", kind: "edit", oldText: "" })).toEqual({ start: 1, end: 1 })
  })

  test("is unknown while the buffer is not loaded or the text is gone", () => {
    expect(intentRange(undefined, { file: "a", kind: "edit", oldText: "two" })).toBeUndefined()
    expect(intentRange(buffer, { file: "a", kind: "edit", oldText: "nine" })).toBeUndefined()
  })

  test("lands on line 1 for a write or an added file", () => {
    expect(intentRange(buffer, { file: "a", kind: "write", newText: "x" })).toEqual({ start: 1, end: 1 })
    expect(intentRange(undefined, { file: "a", kind: "add", newText: "x" })).toEqual({ start: 1, end: 1 })
  })

  test("finds a patch update's first chunk, or its context line", () => {
    const chunk = { oldLines: ["two", "three"], newLines: ["two", "THREE"] }
    expect(intentRange(buffer, { file: "a", kind: "update", chunks: [chunk] })).toEqual({ start: 2, end: 3 })
    const insertOnly = { oldLines: [], newLines: ["x"], changeContext: "four" }
    expect(intentRange(buffer, { file: "a", kind: "update", chunks: [insertOnly] })).toEqual({ start: 4, end: 4 })
  })

  test("has no landing zone for a deleted file", () => {
    expect(intentRange(buffer, { file: "a", kind: "delete" })).toBeUndefined()
  })
})

describe("predatesEdit", () => {
  test("an edit's before still holds the text it replaces", () => {
    const target = { file: "a", kind: "edit" as const, oldText: "two", newText: "TWO" }
    expect(predatesEdit("one\ntwo\n", target)).toBe(true)
    expect(predatesEdit("one\nTWO\n", target)).toBe(false)
  })

  test("an insertion anchored on the replaced text has landed once the whole replacement is there", () => {
    const target = { file: "a", kind: "edit" as const, oldText: "foo()", newText: "foo()\nbar()" }
    expect(predatesEdit("x\nfoo()\ny\n", target)).toBe(true)
    expect(predatesEdit("x\nfoo()\nbar()\ny\n", target)).toBe(false)
  })

  test("a write, an added file or a file-creating edit has landed once the file is the new text", () => {
    expect(predatesEdit("old\n", { file: "a", kind: "write", newText: "new" })).toBe(true)
    expect(predatesEdit("new\n", { file: "a", kind: "write", newText: "new" })).toBe(false)
    expect(predatesEdit("new", { file: "a", kind: "add", newText: "new\n" })).toBe(false)
    expect(predatesEdit("new", { file: "a", kind: "edit", oldText: "", newText: "new" })).toBe(false)
  })

  test("a patch update's before holds its first chunk's old lines", () => {
    const chunks = [{ oldLines: ["one", "two"], newLines: ["one", "TWO"] }]
    expect(predatesEdit("one\ntwo\nthree\n", { file: "a", kind: "update", chunks })).toBe(true)
    expect(predatesEdit("one\nTWO\nthree\n", { file: "a", kind: "update", chunks })).toBe(false)
  })

  test("text missing the old string is taken as it is unless the replacement is already there", () => {
    const edit = { file: "a", kind: "edit" as const, oldText: "two", newText: "TWO" }
    expect(predatesEdit("one\nsomething else\n", edit)).toBe(true)
    expect(predatesEdit("one\n", { file: "a", kind: "edit", oldText: "two\n", newText: "" })).toBe(true)
    const chunks = [{ oldLines: ["one", "two"], newLines: ["one", "TWO"] }]
    expect(predatesEdit("zero\n", { file: "a", kind: "update", chunks })).toBe(true)
  })

  test("reads CRLF text, and takes the text as it is when the target cannot tell", () => {
    expect(predatesEdit("one\r\ntwo\r\n", { file: "a", kind: "edit", oldText: "one\ntwo", newText: "x" })).toBe(true)
    expect(predatesEdit("anything", { file: "a", kind: "update" })).toBe(true)
    expect(predatesEdit("anything", { file: "a", kind: "update", chunks: [{ oldLines: [], newLines: ["x"] }] })).toBe(
      true,
    )
    expect(predatesEdit("anything", { file: "a", kind: "delete" })).toBe(true)
  })
})

describe("typingPlan", () => {
  const apply = (before: string, plan: TypingPlan) =>
    before.slice(0, plan.offset) + plan.insert + before.slice(plan.offset + plan.deleteLength)

  test("is empty when nothing changed", () => {
    expect(typingPlan("same", "same")).toBeUndefined()
  })

  test("finds the one span that differs", () => {
    expect(typingPlan("abc", "abXc")).toEqual({ offset: 2, deleteLength: 0, insert: "X" })
    expect(typingPlan("hello world", "hello there")).toEqual({ offset: 6, deleteLength: 5, insert: "there" })
    expect(typingPlan("abcdef", "abef")).toEqual({ offset: 2, deleteLength: 2, insert: "" })
  })

  test("reproduces the new text for insertions at either end and replacements", () => {
    const samples: [string, string][] = [
      ["", "hello"],
      ["tail", "head tail"],
      ["head", "head tail"],
      ["a\nb\nc\n", "a\nB1\nB2\nc\n"],
      ["one two three", "one three"],
      ["aaaa", "aaaaaa"],
    ]
    for (const [before, after] of samples) {
      const plan = typingPlan(before, after)
      expect(plan).toBeDefined()
      expect(apply(before, plan!)).toBe(after)
    }
  })

  test("never splits a surrogate pair", () => {
    const smile = typingPlan("a😀b", "a😃b")
    expect(smile).toEqual({ offset: 1, deleteLength: 2, insert: "😃" })
    const tail = typingPlan("😀", "🨀")
    expect(tail).toEqual({ offset: 0, deleteLength: 2, insert: "🨀" })
  })

  test("skips a change too large to replay", () => {
    expect(typingPlan("", "x".repeat(TYPING_MAX_CHARS + 1))).toBeUndefined()
    expect(typingPlan("", "x".repeat(TYPING_MAX_CHARS))).toBeDefined()
    expect(typingPlan("a", "ab", 0)).toBeUndefined()
  })
})

describe("typingSteps", () => {
  test("is empty for nothing to type", () => {
    expect(typingSteps("")).toEqual([])
  })

  test("types a short line a character at a time", () => {
    expect(typingSteps("abc")).toEqual(["a", "b", "c"])
  })

  test("groups a long line into at most the step limit", () => {
    const steps = typingSteps("x".repeat(90), 30)
    expect(steps).toHaveLength(30)
    expect(steps.join("")).toBe("x".repeat(90))
  })

  test("types a block a line at a time and keeps the newlines", () => {
    expect(typingSteps("a\nb\nc")).toEqual(["a\n", "b\n", "c"])
  })

  test("groups many lines into at most the step limit", () => {
    const block = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")
    const steps = typingSteps(block, 30)
    expect(steps.length).toBeLessThanOrEqual(30)
    expect(steps.join("")).toBe(block)
  })

  test("never splits an emoji across steps", () => {
    expect(typingSteps("a😀b")).toEqual(["a", "😀", "b"])
  })
})
