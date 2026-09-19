import { describe, expect, test } from "bun:test"
import { buildReviewBody } from "@opencode-ai/core/review/format"
import { buildCreateReviewPayload, splitHalves } from "@opencode-ai/core/review/github-payload"
import { parseReviewMarker } from "@opencode-ai/core/review/state"
import type { PlacedFinding } from "@opencode-ai/core/review/types"

const HEAD = "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3"

function placed(overrides: Partial<PlacedFinding> = {}): PlacedFinding {
  return {
    id: "3f9a1c07be21",
    path: "src/a.ts",
    line: 10,
    side: "RIGHT",
    severity: "concern",
    category: "bug",
    title: "Title",
    body: "Body",
    confidence: 0.9,
    source: "review",
    anchor: { path: "src/a.ts", side: "RIGHT", line: 10, hunk: 0 },
    suggestionAllowed: false,
    ...overrides,
  }
}

const body = buildReviewBody({ head: HEAD, run: "8f3c21aa", inline: [placed()] })

describe("buildCreateReviewPayload", () => {
  test("always sets commit_id and event COMMENT, never APPROVE or REQUEST_CHANGES", () => {
    for (const trust of ["trusted", "untrusted"] as const)
      for (const inline of [[], [placed()], [placed({ severity: "blocking" })]]) {
        const payload = buildCreateReviewPayload({ head: HEAD, inline, body, suggestions: true, trust })
        expect(payload.commit_id).toBe(HEAD)
        expect(payload.event).toBe("COMMENT")
        expect(payload.body).toBe(body)
        expect(JSON.stringify(payload)).not.toMatch(/APPROVE|REQUEST_CHANGES/)
      }
  })

  test("a single-line comment", () => {
    const payload = buildCreateReviewPayload({
      head: HEAD,
      inline: [placed()],
      body,
      suggestions: true,
      trust: "trusted",
    })
    expect(Object.keys(payload.comments[0]!).sort()).toEqual(["body", "line", "path", "side"])
    expect(payload.comments[0]).toMatchObject({ path: "src/a.ts", line: 10, side: "RIGHT" })
  })

  test("a multi-line comment on either side", () => {
    const right = placed({ anchor: { path: "src/a.ts", side: "RIGHT", line: 14, startLine: 12, hunk: 0 } })
    const left = placed({
      id: "3f9a1c07be22",
      side: "LEFT",
      anchor: { path: "src/a.ts", side: "LEFT", line: 7, startLine: 5, hunk: 0 },
    })
    const payload = buildCreateReviewPayload({
      head: HEAD,
      inline: [right, left],
      body,
      suggestions: true,
      trust: "trusted",
    })
    expect(payload.comments.map(({ body: _, ...shape }) => shape)).toEqual([
      { path: "src/a.ts", line: 14, side: "RIGHT", start_line: 12, start_side: "RIGHT" },
      { path: "src/a.ts", line: 7, side: "LEFT", start_line: 5, start_side: "LEFT" },
    ])
  })

  test("uses the anchor's path and line, not the model's", () => {
    const renamed = placed({
      path: "src/old.ts",
      line: 9,
      anchor: { path: "src/new.ts", side: "RIGHT", line: 11, hunk: 1 },
    })
    const payload = buildCreateReviewPayload({
      head: HEAD,
      inline: [renamed],
      body,
      suggestions: true,
      trust: "trusted",
    })
    expect(payload.comments[0]).toMatchObject({ path: "src/new.ts", line: 11 })
  })

  test("a fix is committable only when every rule allows it; otherwise it is a diff block", () => {
    const fix = { suggestion: "  return x", suggestionAllowed: true }
    const comment = (
      finding: PlacedFinding,
      options: { trust?: "trusted" | "untrusted"; suggestions?: boolean } = {},
    ) =>
      buildCreateReviewPayload({
        head: HEAD,
        inline: [finding],
        body,
        suggestions: options.suggestions ?? true,
        trust: options.trust ?? "trusted",
      }).comments[0]!.body
    const commit = "```suggestion\n  return x\n```"
    const diff = "```diff\n+  return x\n```"
    expect(comment(placed(fix))).toContain(commit)
    expect(comment(placed(fix), { trust: "untrusted" })).toContain(diff)
    expect(comment(placed({ ...fix, verified: true }), { trust: "untrusted" })).toContain(commit)
    expect(comment(placed(fix), { suggestions: false })).toContain(diff)
    expect(comment(placed({ ...fix, suggestionAllowed: false }))).toContain(diff)
    const none = comment(placed())
    expect(none).not.toContain("```suggestion")
    expect(none).not.toContain("```diff")
  })

  test("carries lead lines and sanitizes model text against the repository", () => {
    const finding = placed({
      body: "See [the caller](https://github.com/o/r/blob/main/b.ts) and [this](https://evil.example).",
    })
    const payload = buildCreateReviewPayload({
      head: HEAD,
      inline: [finding],
      body,
      suggestions: true,
      trust: "trusted",
      leads: { [finding.id]: "Returned after being fixed in `abc1234`" },
      repo: { owner: "o", repo: "r" },
    })
    const text = payload.comments[0]!.body
    expect(text).toContain("_Returned after being fixed in `abc1234`_")
    expect(text).toContain("See [the caller](https://github.com/o/r/blob/main/b.ts) and this.")
    expect(text).toEndWith("-->")
  })
})

describe("splitHalves", () => {
  const five = buildCreateReviewPayload({
    head: HEAD,
    inline: [1, 2, 3, 4, 5].map((n) =>
      placed({
        id: `00000000000${n}`,
        line: n * 10,
        anchor: { path: "src/a.ts", side: "RIGHT", line: n * 10, hunk: 0 },
      }),
    ),
    body,
    suggestions: true,
    trust: "trusted",
  })

  test("splits the comments in halves; the second half has the continued body with the same marker", () => {
    const [first, second] = splitHalves(five)
    expect(first.comments).toHaveLength(3)
    expect(second.comments).toHaveLength(2)
    expect([...first.comments, ...second.comments]).toEqual(five.comments)
    expect(first.body).toBe(body)
    expect(second.body).toBe(
      "Vectorscope review of `d4e5f6a` (continued).\n<!-- vector-review:review head=d4e5f6a run=8f3c21aa -->",
    )
    expect(parseReviewMarker(second.body)).toEqual(parseReviewMarker(body))
    for (const half of [first, second]) {
      expect(half.commit_id).toBe(HEAD)
      expect(half.event).toBe("COMMENT")
    }
  })

  test("splits again down to single comments", () => {
    const [, second] = splitHalves(five)
    const [a, b] = splitHalves(second)
    expect([a.comments.length, b.comments.length]).toEqual([1, 1])
    expect(a.body).toBe(second.body)
    const [one, empty] = splitHalves({ ...five, comments: five.comments.slice(0, 1) })
    expect([one.comments.length, empty.comments.length]).toEqual([1, 0])
  })
})
