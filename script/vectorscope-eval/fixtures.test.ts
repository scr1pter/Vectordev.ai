import { describe, expect, test } from "bun:test"
import { parseUnifiedDiff } from "../../packages/core/src/review/diff"
import { fixtureProblems, listFixtures, loadFixture, type Fixture } from "./fixture"

const names = await listFixtures()
const fixtures = await Promise.all(names.map(loadFixture))

describe("every fixture", () => {
  for (const fixture of fixtures)
    test(fixture.name, () => {
      expect(fixtureProblems(fixture)).toEqual([])
    })
})

describe("the fixture set", () => {
  test("has eight fixtures with one planted bug each and two clean ones", () => {
    expect(fixtures).toHaveLength(10)
    expect(fixtures.filter((fixture) => fixture.expected.length === 1)).toHaveLength(8)
    expect(fixtures.filter((fixture) => fixture.expected.length === 0)).toHaveLength(2)
  })

  test("planted bug ids are unique across fixtures", () => {
    const ids = fixtures.flatMap((fixture) => fixture.expected.map((expectation) => expectation.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("each fixture changes one to three files and 30 to 150 lines", () => {
    for (const fixture of fixtures) {
      const changed = fixture.files.reduce((sum, file) => sum + file.additions + file.deletions, 0)
      expect({ name: fixture.name, files: fixture.files.length >= 1 && fixture.files.length <= 3 }).toEqual({
        name: fixture.name,
        files: true,
      })
      expect({ name: fixture.name, changed: changed >= 30 && changed <= 150 }).toEqual({
        name: fixture.name,
        changed: true,
      })
    }
  })
})

describe("fixtureProblems", () => {
  const sample = fixtures.find((fixture) => fixture.name === "audit-log-pagination")!

  function withDiff(fixture: Fixture, diff: string): Fixture {
    return { ...fixture, diff, files: parseUnifiedDiff(diff) }
  }

  test("flags a hunk header whose counts are wrong", () => {
    const short = withDiff(sample, sample.diff.replace("@@ -14,11 +14,45 @@", "@@ -14,11 +14,40 @@"))
    expect(fixtureProblems(short).join("\n")).toContain("outside any hunk")
    const long = withDiff(sample, sample.diff.replace("@@ -14,11 +14,45 @@", "@@ -14,11 +14,47 @@"))
    expect(fixtureProblems(long).join("\n")).toContain("does not match its line counts")
  })

  test("flags a head copy that is not the post-image of the diff", () => {
    const edited = {
      ...sample,
      headFiles: sample.headFiles.map((file) => ({ ...file, text: file.text.replace("page * size", "page*size") })),
    }
    expect(fixtureProblems(edited)).toContain("head/src/admin/audit-log.ts is not the post-image of the diff")
    const shifted = {
      ...sample,
      headFiles: sample.headFiles.map((file) => ({ ...file, text: "// moved down a line\n" + file.text })),
    }
    expect(fixtureProblems(shifted)).toContain("head/src/admin/routes.ts is not the post-image of the diff")
  })

  test("flags missing and extra head copies", () => {
    const missing = { ...sample, headFiles: sample.headFiles.slice(1) }
    expect(fixtureProblems(missing)).toContain(`head/${sample.headFiles[0].path} is missing`)
    const extra = { ...sample, headFiles: [...sample.headFiles, { path: "src/other.ts", text: "export {}\n" }] }
    expect(fixtureProblems(extra)).toContain("head/src/other.ts is not changed by the diff")
  })

  test("flags an expectation that is not on an added line", () => {
    const planted = sample.expected[0]
    const context = { ...sample, expected: [{ ...planted, line: 1 }] }
    expect(fixtureProblems(context)).toContain(
      `expectation ${planted.id}: line 1 is not an added line of ${planted.path}`,
    )
    const elsewhere = { ...sample, expected: [{ ...planted, path: "src/admin/missing.ts" }] }
    expect(fixtureProblems(elsewhere).join("\n")).toContain("which the diff does not add or change")
    const backwards = { ...sample, expected: [{ ...planted, endLine: planted.line - 1 }] }
    expect(fixtureProblems(backwards).join("\n")).toContain(`endLine ${planted.line - 1}`)
  })
})
