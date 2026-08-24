import { describe, expect, test } from "bun:test"
import { replace } from "../../src/tool/edit"

// The fuzzy fallback replacers hand back a span taken from the file, which can
// cover more than oldString described — a whole indented line, or more lines
// than were asked for. Substituting newString into that wider span rewrites code
// the model never saw while still reporting success, which is how an edit
// silently destroyed indentation and deleted a line in a live session.
describe("replace never rewrites more than oldString described", () => {
  test("a whitespace-only mismatch keeps the line's indentation", () => {
    const before = ["def handler(req):", "    if req.ok:", "        return  compute(req)", "    return None", ""].join(
      "\n",
    )
    // Differs from the file only in internal whitespace: one space, not two.
    const after = replace(before, "return compute(req)", "return compute(req, retry=True)")
    expect(after).toContain("        return compute(req, retry=True)")
    expect(after).not.toContain("\nreturn compute(req, retry=True)")
    // Every other line survives untouched.
    expect(after).toContain("def handler(req):")
    expect(after).toContain("    if req.ok:")
    expect(after).toContain("    return None")
  })

  test("an anchored block match does not swallow the lines between the anchors", () => {
    const before = [
      "function a() {",
      "  one()",
      "  two()",
      "  three()",
      "}",
      "function b() {",
      "  four()",
      "}",
      "",
    ].join("\n")
    const oldString = ["function a() {", "  one()", "  two()", "}"].join("\n")
    const newString = ["function a() {", "  one()", "  two()", "  extra()", "}"].join("\n")
    // oldString omits three(), so the anchored span covers a line the model never
    // saw. Refusing is correct: applying newString here silently deleted three()
    // and still reported success. Failing loudly is the safe outcome.
    expect(() => replace(before, oldString, newString)).toThrow()
  })

  test("an exact match still replaces exactly", () => {
    const before = "const a = 1\nconst b = 2\n"
    expect(replace(before, "const b = 2", "const b = 3")).toBe("const a = 1\nconst b = 3\n")
  })

  test("an oldString that is genuinely absent is refused", () => {
    expect(() => replace("const a = 1\n", "const zzz = 9", "const zzz = 10")).toThrow()
  })
})
