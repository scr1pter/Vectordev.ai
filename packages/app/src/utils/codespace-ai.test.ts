import { describe, expect, test } from "bun:test"
import {
  applyExactReplacements,
  boundInlineCompletionContext,
  collectPatchFiles,
  isCodespaceEditRequest,
  parseCodespaceProposal,
  parseCodespaceProposalText,
  sanitizeInlineCompletion,
} from "./codespace-ai"

describe("Codespace AI", () => {
  test("bounds autocomplete context around the cursor", () => {
    const result = boundInlineCompletionContext(
      { path: "src/app.ts", language: "typescript", prefix: "123456", suffix: "abcdef", cursorLine: 4 },
      { prefix: 4, suffix: 3 },
    )
    expect(result.prefix).toBe("3456")
    expect(result.suffix).toBe("abc")
  })

  test("cleans fenced completions and rejects duplicated suffixes", () => {
    expect(sanitizeInlineCompletion("```ts\nreturn true\n```", "")).toBe("return true")
    expect(sanitizeInlineCompletion("return true", "return true\n}")).toBeUndefined()
  })

  test("applies only unambiguous exact replacements", () => {
    expect(applyExactReplacements("const ready = false", [{ oldText: "false", newText: "true" }])).toEqual({
      content: "const ready = true",
      applied: 1,
      errors: [],
    })
    expect(applyExactReplacements("x x", [{ oldText: "x", newText: "y" }]).errors).toHaveLength(1)
  })

  test("parses safe proposals and rejects paths outside the workspace", () => {
    const result = parseCodespaceProposal({
      summary: "Update the app",
      changes: [
        {
          path: "src/app.ts",
          mode: "edit",
          explanation: "Enable the feature",
          risk: "low",
          content: "",
          replacements: [{ oldText: "false", newText: "true" }],
        },
        {
          path: "../secret",
          mode: "create",
          explanation: "Unsafe",
          risk: "high",
          content: "secret",
          replacements: [],
        },
      ],
    })
    expect(result?.changes).toHaveLength(1)
    expect(result?.changes[0]?.path).toBe("src/app.ts")
  })

  test("parses review proposals returned as fenced model text", () => {
    const result = parseCodespaceProposalText(`\`\`\`json
{
  "summary": "Enable the feature",
  "changes": [{
    "path": "src/app.ts",
    "mode": "edit",
    "explanation": "Turn it on",
    "risk": "low",
    "content": "",
    "replacements": [{ "oldText": "false", "newText": "true" }]
  }]
}
\`\`\``)
    expect(result?.summary).toBe("Enable the feature")
    expect(result?.changes[0]?.path).toBe("src/app.ts")
    expect(parseCodespaceProposalText("not json")).toBeUndefined()
  })

  test("collects changed files from engine patch parts", () => {
    expect(collectPatchFiles({ parts: [{ type: "patch", files: ["src/a.ts", "src/b.ts", "../outside"] }] })).toEqual([
      "src/a.ts",
      "src/b.ts",
    ])
  })

  test("distinguishes editor questions from edit requests", () => {
    expect(isCodespaceEditRequest("Explain this file")).toBeFalse()
    expect(isCodespaceEditRequest("Could you review this code for risks?")).toBeFalse()
    expect(isCodespaceEditRequest("Fix the errors in this file")).toBeTrue()
    expect(isCodespaceEditRequest("Can you explain the bug and fix it?")).toBeTrue()
  })
})
