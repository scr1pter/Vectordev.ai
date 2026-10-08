import { describe, expect, test } from "bun:test"
import {
  decodeReport,
  decodeVerify,
  extractJson,
  MAX_REPORT_FINDINGS,
  REVIEW_REPORT_JSON_SCHEMA,
  VERIFY_JSON_SCHEMA,
} from "@vectordevai/core/review/schema"
import { CATEGORIES, SEVERITIES } from "@vectordevai/core/review/types"

// Every key used anywhere in a schema, at any depth.
function keys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keys)
  if (!value || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, inner]) => [key, ...keys(inner)])
}

describe("schemas", () => {
  const finding = REVIEW_REPORT_JSON_SCHEMA.properties.findings.items

  test("the finding enums equal SEVERITIES and CATEGORIES", () => {
    expect(finding.properties.severity.enum).toEqual([...SEVERITIES])
    expect(finding.properties.category.enum).toEqual([...CATEGORIES])
    expect(finding.properties.side.enum).toEqual(["RIGHT", "LEFT"])
    expect(REVIEW_REPORT_JSON_SCHEMA.properties.risk.enum).toEqual(["low", "medium", "high"])
  })

  test("the finding shape and its required fields", () => {
    expect(finding.required).toEqual(["path", "line", "severity", "category", "title", "body", "confidence"])
    expect(finding.properties.line).toMatchObject({ type: "integer", minimum: 1 })
    expect(finding.properties.title.maxLength).toBe(100)
    expect(finding.properties.confidence).toMatchObject({ minimum: 0, maximum: 1 })
    expect(Object.keys(finding.properties)).toContain("duplicateOf")
    expect(REVIEW_REPORT_JSON_SCHEMA.properties.priorStatus.items.properties.status.enum).toEqual(["fixed", "open"])
  })

  test("uses only conservative JSON Schema", () => {
    for (const schema of [REVIEW_REPORT_JSON_SCHEMA, VERIFY_JSON_SCHEMA]) {
      const used = keys(schema)
      expect(used).not.toContain("anyOf")
      expect(used).not.toContain("oneOf")
      expect(used).not.toContain("$ref")
      expect(used).not.toContain("additionalProperties")
    }
  })

  test("the verify schema", () => {
    const result = VERIFY_JSON_SCHEMA.properties.results.items
    expect(result.properties.verdict.enum).toEqual(["confirmed", "rejected"])
    expect(result.required).toEqual(["id", "verdict", "reason"])
  })
})

describe("extractJson", () => {
  test("recovers a fenced block, with or without a language", () => {
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```\nDone.')).toEqual({ a: 1 })
    expect(extractJson('```\n{"b":2}\n```')).toEqual({ b: 2 })
  })

  test("skips a fence that is not JSON", () => {
    expect(extractJson('```ts\nconst x = 1\n```\n```json\n{"c":3}\n```')).toEqual({ c: 3 })
  })

  test("recovers the outermost object from prose, even with a fence inside a string", () => {
    const text = 'Result: {"summary":"ok","findings":[{"suggestion":"```js\\nx\\n```"}]} (end)'
    expect(extractJson(text)).toEqual({ summary: "ok", findings: [{ suggestion: "```js\nx\n```" }] })
  })

  test("returns undefined when nothing parses to an object", () => {
    expect(extractJson("no json here")).toBeUndefined()
    expect(extractJson("42")).toBeUndefined()
    expect(extractJson("{ broken")).toBeUndefined()
  })
})

describe("decodeReport", () => {
  test("decodes a well-formed report", () => {
    const report = decodeReport({
      summary: "Adds rotation.",
      risk: "medium",
      files: [{ path: "src/a.ts", note: "rotation loop" }],
      findings: [
        {
          path: "src/a.ts",
          line: 52,
          endLine: 54,
          side: "RIGHT",
          severity: "blocking",
          category: "bug",
          title: "Refresh can restore a session after logout",
          body: "Explained.",
          suggestion: "    if (x) return",
          confidence: 0.86,
          evidence: ["src/auth/client.ts:31"],
          rule: "Auth state changes must be race-free",
          duplicateOf: "3f9a1c07be21",
        },
      ],
      priorStatus: [{ id: "abcdefabcdef", status: "fixed", reason: "the guard was added" }],
    })
    expect(report).toEqual({
      summary: "Adds rotation.",
      risk: "medium",
      files: [{ path: "src/a.ts", note: "rotation loop" }],
      findings: [
        {
          path: "src/a.ts",
          line: 52,
          endLine: 54,
          side: "RIGHT",
          severity: "blocking",
          category: "bug",
          title: "Refresh can restore a session after logout",
          body: "Explained.",
          suggestion: "    if (x) return",
          confidence: 0.86,
          evidence: ["src/auth/client.ts:31"],
          rule: "Auth state changes must be race-free",
          duplicateOf: "3f9a1c07be21",
        },
      ],
      priorStatus: [{ id: "abcdefabcdef", status: "fixed", reason: "the guard was added" }],
    })
  })

  test("is lenient about sides, enums, numbers and paths", () => {
    const report = decodeReport({
      summary: "s",
      risk: "extreme",
      findings: [
        {
          path: "./src/a.ts",
          line: "52",
          severity: "critical",
          category: "correctness",
          title: "A",
          body: "b",
          confidence: "0.8",
        },
        { path: "src/b.ts", line: 3, side: "left", severity: "NIT", category: "Style", title: "B", confidence: 85 },
        {
          path: "src/c.ts",
          line: "L7",
          endLine: 7,
          severity: "concern",
          category: "tests",
          title: "C",
          confidence: 2.5e3,
        },
        { path: "src/d.ts", line: 0, severity: "concern", category: "docs", title: "D", confidence: -1 },
        { path: "src/e.ts", severity: "concern", category: "bug", title: "E" },
      ],
    })
    expect(report?.risk).toBe("low")
    expect(
      report?.findings.map((f) => [f.path, f.line, f.endLine, f.side, f.severity, f.category, f.confidence]),
    ).toEqual([
      ["src/a.ts", 52, undefined, "RIGHT", "concern", "bug", 0.8],
      ["src/b.ts", 3, undefined, "LEFT", "nit", "style", 0.85],
      ["src/c.ts", 7, undefined, "RIGHT", "concern", "tests", 1],
      ["src/d.ts", 1, undefined, "RIGHT", "concern", "docs", 0],
      ["src/e.ts", 1, undefined, "RIGHT", "concern", "bug", 0.5],
    ])
    expect(report?.files).toEqual([])
  })

  test("drops findings without a path or a title, and clamps the title", () => {
    const report = decodeReport({
      summary: "s",
      findings: [
        { line: 1, title: "no path", severity: "nit", category: "bug", confidence: 1 },
        { path: "src/a.ts", line: 1, title: "   ", severity: "nit", category: "bug", confidence: 1 },
        { path: "src/a.ts", line: 1, title: `  ${"x".repeat(150)}\n`, severity: "nit", category: "bug", confidence: 1 },
        "not an object",
      ],
    })
    expect(report?.findings).toHaveLength(1)
    expect(report?.findings[0]?.title).toBe("x".repeat(100))
  })

  test("cleans suggestions but keeps their indentation", () => {
    const decode = (suggestion: unknown) =>
      decodeReport({
        summary: "s",
        findings: [{ path: "a.ts", line: 1, title: "t", severity: "nit", category: "bug", confidence: 1, suggestion }],
      })?.findings[0]?.suggestion
    expect(decode("```ts\n    return x\n```")).toBe("    return x")
    expect(decode("\n    return x\n\n")).toBe("    return x")
    expect(decode("\treturn x\r\n\treturn y")).toBe("\treturn x\n\treturn y")
    expect(decode("   \n  ")).toBeUndefined()
    expect(decode(42)).toBeUndefined()
  })

  test("keeps only valid priorStatus entries", () => {
    const report = decodeReport({
      summary: "s",
      findings: [],
      priorStatus: [
        { id: "a", status: "FIXED", reason: "yes" },
        { id: "b", status: "maybe", reason: "?" },
        { status: "open", reason: "no id" },
      ],
    })
    expect(report?.priorStatus).toEqual([{ id: "a", status: "fixed", reason: "yes" }])
  })

  test("decodes text, and returns undefined when there is no report", () => {
    expect(decodeReport('```json\n{"summary":"from text","findings":[]}\n```')?.summary).toBe("from text")
    expect(decodeReport({ findings: [] })).toEqual({ summary: "", risk: "low", files: [], findings: [] })
    expect(decodeReport({ note: "nothing" })).toBeUndefined()
    expect(decodeReport("plain text")).toBeUndefined()
    expect(decodeReport(null)).toBeUndefined()
    expect(decodeReport([{ summary: "array" }])).toBeUndefined()
  })

  test("finds the report after an unrelated JSON fence", () => {
    const output =
      'Read result:\n```json\n{"path":"src/a.ts","content":"example"}\n```\nReview:\n```json\n{"summary":"Actual review","risk":"medium","findings":[]}\n```'
    expect(decodeReport(output)?.summary).toBe("Actual review")
    expect(
      decodeReport(
        '```json\n{"summary":"Tool result"}\n```\n```json\n{"summary":"Actual review","risk":"medium","findings":[]}\n```',
      )?.summary,
    ).toBe("Actual review")
  })

  test("finds separate JSON objects in prose and preserves braces inside strings", () => {
    const output =
      'Read result: {"path":"src/a.ts"}. Review: {"summary":"Handle {nested} and \\\"quoted\\\" input","findings":[]}. Done.'
    expect(decodeReport(output)?.summary).toBe('Handle {nested} and "quoted" input')
  })

  test("a stray bracket in the prose does not hide the report after it", () => {
    expect(
      decodeReport('Checked the half-open range [0, n). {"summary":"Real review","risk":"low","findings":[]}')?.summary,
    ).toBe("Real review")
    // An odd number of quotes in the prose cannot flip the scanner either.
    expect(decodeReport('A 5" screen and [0, n). {"summary":"Still found","findings":[]}')?.summary).toBe("Still found")
  })

  test("a report quoted before the real one does not win", () => {
    const output = [
      "The earlier run said:",
      '```json\n{"summary":"LGTM","risk":"low","findings":[]}\n```',
      "My review of the current head:",
      '```json\n{"summary":"Two problems","risk":"high","findings":[{"path":"src/a.ts","line":3,"severity":"blocking","category":"bug","title":"Null read","body":"b","confidence":0.9}]}\n```',
    ].join("\n")
    const report = decodeReport(output)
    expect(report?.summary).toBe("Two problems")
    expect(report?.findings).toHaveLength(1)
  })

  test("drops a fix too long for a comment, and caps the summary", () => {
    const base = { path: "a.ts", line: 1, severity: "concern", category: "bug", title: "t", body: "b", confidence: 0.9 }
    const report = decodeReport({
      summary: "s".repeat(10_000),
      risk: "low",
      files: [],
      findings: [
        { ...base, suggestion: "x\n".repeat(81) },
        { ...base, suggestion: "y".repeat(8_001) },
        { ...base, suggestion: "z".repeat(8_000) },
      ],
    })!
    expect(report.summary).toHaveLength(4_000)
    expect(report.findings.map((finding) => finding.suggestion?.length)).toEqual([undefined, undefined, 8_000])
  })

  test("keeps at most MAX_REPORT_FINDINGS findings", () => {
    const findings = Array.from({ length: 150 }, (_, i) => ({
      path: "a.ts",
      line: i + 1,
      title: `t${i}`,
      severity: "concern",
      category: "bug",
      confidence: 0.9,
    }))
    expect(decodeReport({ summary: "s", findings })?.findings).toHaveLength(MAX_REPORT_FINDINGS)
  })
})

describe("decodeVerify", () => {
  test("decodes results, leniently", () => {
    expect(
      decodeVerify({
        results: [
          { id: "a", verdict: "Confirmed", reason: " real " },
          { id: "b", verdict: "reject", reason: "not triggered" },
          { id: "c", verdict: "unsure", reason: "?" },
          { verdict: "confirmed" },
        ],
      }),
    ).toEqual([
      { id: "a", verdict: "confirmed", reason: "real" },
      { id: "b", verdict: "rejected", reason: "not triggered" },
    ])
  })

  test("accepts a bare array or text, and returns undefined for anything else", () => {
    expect(decodeVerify([{ id: "a", verdict: "rejected", reason: "r" }])).toHaveLength(1)
    expect(decodeVerify('{"results":[{"id":"a","verdict":"confirmed","reason":"r"}]}')).toHaveLength(1)
    expect(decodeVerify({ summary: "no results" })).toBeUndefined()
    expect(decodeVerify("nothing")).toBeUndefined()
  })

  test("unrelated JSON never reads as an empty set of verdicts", () => {
    expect(decodeVerify('Files I read: {"results":["src/a.ts","src/b.ts"]}')).toBeUndefined()
    expect(decodeVerify('{"results":[{"path":"src/a.ts"}]}')).toBeUndefined()
  })

  test("finds verification results after unrelated JSON", () => {
    expect(
      decodeVerify(
        '```json\n{"path":"src/a.ts"}\n```\n```json\n{"results":[{"id":"a","verdict":"confirmed","reason":"Read the caller"}]}\n```',
      ),
    ).toEqual([{ id: "a", verdict: "confirmed", reason: "Read the caller" }])
    expect(decodeVerify('Results: [{"id":"a","verdict":"rejected","reason":"Not reachable"}] Done.')).toEqual([
      { id: "a", verdict: "rejected", reason: "Not reachable" },
    ])
    expect(
      decodeVerify(
        '```json\n["src/a.ts"]\n```\n```json\n{"results":[{"id":"a","verdict":"confirmed","reason":"Read the caller"}]}\n```',
      ),
    ).toEqual([{ id: "a", verdict: "confirmed", reason: "Read the caller" }])
  })
})
