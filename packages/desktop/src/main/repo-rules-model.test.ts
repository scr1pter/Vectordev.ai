import { describe, expect, test } from "bun:test"

import {
  formatRulesFile,
  formatRulesForPrompt,
  matchesPattern,
  selectRules,
  type RepoRule,
} from "./repo-rules-model"

function rule(overrides: Partial<RepoRule> & { id: string; description: string }): RepoRule {
  return {
    repositoryPath: "",
    filePatterns: [],
    enabled: true,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  }
}

describe("matching file patterns", () => {
  test("a single star does not cross directories", () => {
    expect(matchesPattern("src/app/web/*.tsx", "src/app/web/page.tsx")).toBe(true)
    expect(matchesPattern("src/app/web/*.tsx", "src/app/web/nested/page.tsx")).toBe(false)
  })

  test("a double star does cross directories", () => {
    expect(matchesPattern("src/**/*.ts", "src/a.ts")).toBe(true)
    expect(matchesPattern("src/**/*.ts", "src/deep/nested/a.ts")).toBe(true)
    expect(matchesPattern("src/**/*.ts", "other/a.ts")).toBe(false)
  })

  test("a bare directory name covers everything under it", () => {
    // What a user means by typing "controllers" is never the file named
    // controllers — it is the folder.
    expect(matchesPattern("controllers", "controllers/user.ts")).toBe(true)
    expect(matchesPattern("controllers", "controllers/deep/user.ts")).toBe(true)
    expect(matchesPattern("controllers", "models/user.ts")).toBe(false)
  })

  test("windows separators and ./ prefixes still match", () => {
    expect(matchesPattern("src/*.ts", "src\\a.ts")).toBe(true)
    expect(matchesPattern("./src/*.ts", "./src/a.ts")).toBe(true)
  })

  test("a question mark matches exactly one character and not a slash", () => {
    expect(matchesPattern("src/a?.ts", "src/ab.ts")).toBe(true)
    expect(matchesPattern("src/a?.ts", "src/abc.ts")).toBe(false)
    expect(matchesPattern("a?b", "a/b")).toBe(false)
  })

  test("regex metacharacters in a pattern are literal", () => {
    expect(matchesPattern("src/a+b.ts", "src/a+b.ts")).toBe(true)
    expect(matchesPattern("src/a+b.ts", "src/aab.ts")).toBe(false)
  })
})

describe("selecting the rules that apply", () => {
  const repo = "/Users/k/project"
  const rules = [
    rule({ id: "1", description: "No query logic in controllers", repositoryPath: repo }),
    rule({ id: "2", description: "Components stay presentational", repositoryPath: repo, filePatterns: ["src/**/*.tsx"] }),
    rule({ id: "3", description: "Other project rule", repositoryPath: "/Users/k/other" }),
    rule({ id: "4", description: "Disabled rule", repositoryPath: repo, enabled: false }),
    rule({ id: "5", description: "Applies everywhere" }),
  ]

  test("only enabled rules for this repository, plus unscoped ones", () => {
    const selected = selectRules(rules, { repositoryPath: repo })
    expect(selected.map((item) => item.id)).toEqual(["1", "2", "5"])
  })

  test("a trailing slash on either side is not a different repository", () => {
    expect(selectRules(rules, { repositoryPath: `${repo}/` }).map((item) => item.id)).toEqual(["1", "2", "5"])
  })

  test("file scope narrows the selection once the touched files are known", () => {
    const touched = selectRules(rules, { repositoryPath: repo, files: ["src/app/page.tsx"] })
    expect(touched.map((item) => item.id)).toEqual(["1", "2", "5"])
    const untouched = selectRules(rules, { repositoryPath: repo, files: ["server/db.ts"] })
    // Rule 2 is scoped to .tsx files and none were touched, so it drops out.
    expect(untouched.map((item) => item.id)).toEqual(["1", "5"])
  })

  test("an unknown file list keeps scoped rules rather than silently dropping them", () => {
    // Most of what a user writes is scoped. Requiring a file list to include
    // them would disable the feature everywhere the list is not known yet.
    expect(selectRules(rules, { repositoryPath: repo, files: undefined }).map((item) => item.id)).toEqual([
      "1",
      "2",
      "5",
    ])
  })
})

describe("rendering rules for the agent", () => {
  test("the prompt block numbers each rule and names its file scope", () => {
    const text = formatRulesForPrompt([
      rule({ id: "1", description: "No query logic in controllers" }),
      rule({ id: "2", description: "Components stay presentational", filePatterns: ["src/**/*.tsx", "app/*.tsx"] }),
    ])
    expect(text).toContain("[vector:rules]")
    expect(text).toContain("1. No query logic in controllers")
    expect(text).toContain("2. Components stay presentational (applies to src/**/*.tsx, app/*.tsx)")
    // The agent has to be told what to do when a rule and the task disagree,
    // or it quietly picks one and the user never learns there was a conflict.
    expect(text).toContain("say so")
  })

  test("no rules produces no block at all rather than an empty heading", () => {
    expect(formatRulesForPrompt([])).toBe("")
    expect(formatRulesFile([])).toBe("")
  })

  test("the repository file is plain markdown a human can edit", () => {
    const file = formatRulesFile([rule({ id: "1", description: "No query logic in controllers" })])
    expect(file).toContain("# Project rules")
    expect(file).toContain("- No query logic in controllers")
    expect(file).toContain("Managed by Vector")
  })
})
