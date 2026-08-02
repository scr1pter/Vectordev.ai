import { describe, expect, test } from "bun:test"

import { classifyTaskDifficulty, contextBudgetForDifficulty } from "./context-budget"

describe("context budgeting", () => {
  test("keeps greetings out of the repository index path", () => {
    expect(classifyTaskDifficulty("hi")).toBe("trivial")
    expect(classifyTaskDifficulty("Good morning!")).toBe("trivial")
    expect(contextBudgetForDifficulty("trivial")).toEqual({ tokenBudget: 0, fileLimit: 0 })
  })

  test("distinguishes targeted work from broad engineering tasks", () => {
    expect(classifyTaskDifficulty("Explain this function")).toBe("simple")
    expect(classifyTaskDifficulty("Fix the import in src/app.tsx")).toBe("standard")
    expect(
      classifyTaskDifficulty(
        "Refactor the authentication architecture across the codebase, migrate the persistence layer, and test everything end to end.",
      ),
    ).toBe("complex")
  })

  test("spends substantially more context on complex work", () => {
    const standard = contextBudgetForDifficulty("standard")
    const complex = contextBudgetForDifficulty("complex")
    expect(complex.tokenBudget).toBeGreaterThan(standard.tokenBudget)
    expect(complex.fileLimit).toBeGreaterThan(standard.fileLimit)
  })
})
