import { describe, expect, test } from "bun:test"
import { ruleDeleteAction, ruleRepositoryPath, ruleSaveInput } from "./rules"

describe("repository rules scope", () => {
  test("uses the active repository passed by the workspace", () => {
    expect(ruleRepositoryPath("  /work/vector  ")).toBe("/work/vector")
  })

  test("leaves the scope empty when no repository is active", () => {
    expect(ruleRepositoryPath()).toBe("")
  })
})

describe("repository rules actions", () => {
  test("an edit keeps its rule identity when building the save request", () => {
    expect(
      ruleSaveInput({
        id: "rule-1",
        description: "Use the updated service boundary",
        repositoryPath: "  /work/vector  ",
        filePatterns: "src/**, test/**/*.ts",
      }),
    ).toEqual({
      id: "rule-1",
      description: "Use the updated service boundary",
      repositoryPath: "/work/vector",
      filePatterns: ["src/**", "test/**/*.ts"],
    })
  })

  test("a delete requires a second click on the same rule", () => {
    expect(ruleDeleteAction("", "rule-1")).toBe("confirm")
    expect(ruleDeleteAction("rule-2", "rule-1")).toBe("confirm")
    expect(ruleDeleteAction("rule-1", "rule-1")).toBe("delete")
  })
})
