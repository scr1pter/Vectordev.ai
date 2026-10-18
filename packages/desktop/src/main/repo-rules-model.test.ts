import { describe, expect, test } from "bun:test"

import {
  formatRulesFile,
  formatRulesForPrompt,
  matchesPattern,
  mergeRulesFile,
  reconcileRules,
  rulesForRepository,
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
    rule({
      id: "2",
      description: "Components stay presentational",
      repositoryPath: repo,
      filePatterns: ["src/**/*.tsx"],
    }),
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

  test("a trailing Windows separator is not a different repository", () => {
    expect(
      selectRules(
        [rule({ repositoryPath: "C:\\Users\\me\\Vector\\" })],
        { repositoryPath: "C:\\Users\\me\\Vector" },
      ),
    ).toHaveLength(1)
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

  test("an empty initial file list is still unknown and keeps scoped rules", () => {
    expect(selectRules(rules, { repositoryPath: repo, files: [] }).map((item) => item.id)).toEqual(["1", "2", "5"])
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
    expect(file).toContain("# Repository rules")
    expect(file).toContain("- No query logic in controllers")
    expect(file).toContain("Managed by Vector")
    // Vector has no Rules page any more, so the file must not send anyone to one.
    expect(file).toContain("Vectorscope's Don't flag this again adds rules here")
    expect(file).not.toContain("under Rules")
    expect(file).not.toMatch(/project/i)
  })

  test("a file written before the markers, titled Project rules, migrates instead of doubling", () => {
    const rules = [rule({ id: "1", description: "No query logic in controllers" })]
    const legacy = [
      "# Project rules",
      "",
      "<!-- Managed by Vector. Edit these in Vector under Rules, or edit this file directly. -->",
      "",
      "- No query logic in controllers",
      "",
    ].join("\n")
    const merged = mergeRulesFile(legacy, [...rules, rule({ id: "2", description: "Use repository services" })], rules)
    expect(merged).not.toContain("# Project rules")
    expect(merged.match(/No query logic in controllers/g)).toHaveLength(1)
    expect(merged).toContain("# Repository rules")
    expect(merged).toContain("- Use repository services")
  })

  test("managed updates preserve teammate-authored Markdown outside the block", () => {
    const first = formatRulesFile([rule({ id: "1", description: "No query logic in controllers" })])
    const withManual = `# Team notes\n\nNever commit generated fixtures.\n\n${first}`
    const merged = mergeRulesFile(withManual, [rule({ id: "2", description: "Use repository services" })])
    expect(merged).toContain("Never commit generated fixtures.")
    expect(merged).toContain("Use repository services")
    expect(merged).not.toContain("No query logic in controllers")
  })

  test("removing the last managed rule leaves manual Markdown intact", () => {
    const existing = `# Team notes\n\nKeep this.\n\n${formatRulesFile([rule({ id: "1", description: "Managed" })])}`
    expect(mergeRulesFile(existing, [])).toBe("# Team notes\n\nKeep this.\n")
  })
})

describe("the managed block is where rules are changed", () => {
  const repo = "/work/alpha"
  const sql = rule({
    id: "sql",
    description: 'Code review: do not flag "SQL injection" in src/db.ts; it was reviewed and is not a problem.',
    repositoryPath: repo,
    filePatterns: ["src/db.ts"],
  })
  const services = rule({ id: "services", description: "Use repository services", repositoryPath: repo })

  test("a line deleted by hand drops that rule, and the next save does not write it back", () => {
    const edited = formatRulesFile([sql, services]).replace(/^- Code review.*\n/m, "")
    const rules = reconcileRules([sql, services], repo, edited)
    expect(rules.map((item) => item.id)).toEqual(["services"])
    const next = mergeRulesFile(edited, [...rules, rule({ id: "b", description: "Rule B", repositoryPath: repo })])
    expect(next).not.toContain("SQL injection")
    expect(next).toContain("- Use repository services")
    expect(next).toContain("- Rule B")
  })

  test("rules whose lines are untouched keep their ids, in the file's order", () => {
    const file = formatRulesFile([services, sql])
    expect(reconcileRules([sql, services], repo, file)).toEqual([services, sql])
  })

  test("a line edited or added by hand becomes the rule, with its scope read back", () => {
    const edited = formatRulesFile([sql, services])
      .replace("Use repository services", "Use the service layer")
      .replace("<!-- vector:managed-rules:end -->", "- Keep migrations reversible (applies to db/**, migrations)\n\n<!-- vector:managed-rules:end -->")
    const rules = reconcileRules([sql, services], repo, edited, "2026-10-17T00:00:00.000Z")
    expect(rules.map((item) => [item.description, item.filePatterns])).toEqual([
      ['Code review: do not flag "SQL injection" in src/db.ts; it was reviewed and is not a problem.', ["src/db.ts"]],
      ["Use the service layer", []],
      ["Keep migrations reversible", ["db/**", "migrations"]],
    ])
    expect(rules[0]).toBe(sql)
    expect(rules.slice(1).every((item) => item.enabled && item.repositoryPath === repo)).toBe(true)
    // Read twice before any save, a hand-written rule is the same rule, so it can be removed by id.
    expect(reconcileRules([sql, services], repo, edited).map((item) => item.id)).toEqual(rules.map((item) => item.id))
    expect(mergeRulesFile(edited, rules)).toContain("- Keep migrations reversible (applies to db/**, migrations)")
  })

  test("a deleted file, or a file without the block, holds no managed rules", () => {
    expect(reconcileRules([sql, services], repo, "")).toEqual([])
    expect(reconcileRules([sql, services], repo, "# Team notes\n\nKeep this.\n")).toEqual([])
  })

  test("other repositories, global rules and disabled rules are not this file's to change", () => {
    const other = rule({ id: "other", description: "Other repo", repositoryPath: "/work/beta" })
    const global = rule({ id: "global", description: "Everywhere" })
    const disabled = rule({ id: "off", description: "Switched off", repositoryPath: repo, enabled: false })
    expect(reconcileRules([other, global, disabled, sql], repo, "")).toEqual([other, global, disabled])
    expect(reconcileRules([global, sql], "", "")).toEqual([sql])
  })

  test("an untouched file from before the markers keeps its rules until the save that migrates it", () => {
    const legacy = [
      "# Project rules",
      "",
      "<!-- Managed by Vector. Edit these in Vector under Rules, or edit this file directly. -->",
      "",
      "- Use repository services",
      "",
    ].join("\n")
    expect(reconcileRules([services], repo, legacy)).toEqual([services])
  })

  test("a description with a line break is written on one line and still reads back as itself", () => {
    const multiline = rule({ id: "m", description: "Keep handlers small\nand pure", repositoryPath: repo })
    const file = formatRulesFile([multiline])
    expect(file).toContain("- Keep handlers small and pure")
    expect(reconcileRules([multiline], repo, file)).toEqual([multiline])
  })

  test("the file tells people that deleting a line removes the rule", () => {
    const file = formatRulesFile([services])
    expect(file).toContain("delete the line to remove the rule, or edit it to change the rule")
    expect(file).toContain("keep notes of your own outside the markers")
  })
})

describe("listing the rules that govern one repository", () => {
  const alpha = "/work/alpha"
  const beta = "/work/beta"
  const all = [
    rule({ id: "a", description: "Alpha only", repositoryPath: alpha }),
    rule({ id: "b", description: "Beta only", repositoryPath: beta }),
    rule({ id: "g", description: "Everywhere", repositoryPath: "" }),
    rule({ id: "a-off", description: "Alpha, switched off", repositoryPath: alpha, enabled: false }),
  ]

  test("one repository never sees another repository's rules", () => {
    // The reported bug: every project's panel listed every project's rules,
    // because the caller asked for the unscoped list.
    expect(rulesForRepository(all, alpha).map((r) => r.id)).toEqual(["a", "g", "a-off"])
    expect(rulesForRepository(all, beta).map((r) => r.id)).toEqual(["b", "g"])
  })

  test("a global rule governs every repository", () => {
    expect(rulesForRepository(all, "/work/gamma").map((r) => r.id)).toEqual(["g"])
  })

  test("disabled rules stay listed, unlike the prompt filter", () => {
    // A disabled rule has to remain on screen or there is no way to switch it
    // back on. selectRules drops it because prompts must not carry it.
    expect(rulesForRepository(all, alpha).some((r) => r.id === "a-off")).toBe(true)
    expect(selectRules(all, { repositoryPath: alpha }).some((r) => r.id === "a-off")).toBe(false)
  })

  test("a trailing separator does not make a repository foreign to itself", () => {
    expect(rulesForRepository(all, `${alpha}/`).map((r) => r.id)).toEqual(["a", "g", "a-off"])
  })
})
