import { describe, expect, test } from "bun:test"

import { classifyTaskDifficulty, contextBudgetForDifficulty } from "./context-budget"

describe("context budgeting", () => {
  test("keeps greetings out of the repository index path", () => {
    expect(classifyTaskDifficulty("hi")).toBe("trivial")
    expect(classifyTaskDifficulty("Good morning!")).toBe("trivial")
    expect(contextBudgetForDifficulty("trivial")).toEqual({ tokenBudget: 0, fileLimit: 0 })
    // A reply to the work before it is not a greeting.
    expect(classifyTaskDifficulty("continue")).toBe("standard")
    expect(classifyTaskDifficulty("yes")).toBe("standard")
  })

  test("gives every request but a greeting the Work budget, and the complex one only when the user asks", () => {
    for (const text of ["Explain this function", "run the tests", "Fix the import in src/app.tsx"])
      expect(classifyTaskDifficulty(text), text).toBe("standard")
    // Words about scope never make it complex; the user's own ask does.
    expect(
      classifyTaskDifficulty(
        "Refactor the authentication architecture across the codebase, migrate the persistence layer, and test everything end to end.",
      ),
    ).toBe("standard")
    expect(classifyTaskDifficulty("be thorough: refactor the authentication architecture")).toBe("complex")
  })

  test("spends substantially more context on complex work", () => {
    const standard = contextBudgetForDifficulty("standard")
    const complex = contextBudgetForDifficulty("complex")
    expect(complex.tokenBudget).toBeGreaterThan(standard.tokenBudget)
    expect(complex.fileLimit).toBeGreaterThan(standard.fileLimit)
  })
})
