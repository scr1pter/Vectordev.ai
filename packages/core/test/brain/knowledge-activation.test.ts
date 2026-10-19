import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { BrainFuse } from "@vectordevai/core/brain/fuse"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { added, text, withKnowledge } from "./fixture/knowledge"

// Code-anchored recall: a requirement comes in when the request touches its code, with no word in common with the
// request; a greeting touches nothing, and a file nobody linked brings nothing.

const SPEC = `# Auth spec

## 1 Sessions

The \`refreshTokenTtl\` MUST be 14 days.

Refresh tokens are single use.

## 2 Billing

Invoices MUST be issued in integer cents.

## 3 Profiles

Avatars MUST be square.
`

const CODE = {
  "src/auth/session.ts": "export const refreshTokenTtl = (days: number) => days * 86_400\n",
  "src/ui/theme.ts": "export const accent = '#7c3aed'\n",
}

const ask = (query: string, overrides: Partial<Parameters<BrainKnowledge.Interface["recall"]>[1]> = {}) => ({
  query,
  files: [],
  tier: "standard" as const,
  tight: false,
  personal: true,
  exclude: new Set<string>(),
  ...overrides,
})

describe("BrainFuse.activation", () => {
  test("a definition of an edited file outweighs a use of a read one, and drifted links count for less", () => {
    const active = BrainFuse.activation(
      [
        { path: "src/a.ts", weight: BrainFuse.SEED.edited },
        { path: "src/b.ts", weight: BrainFuse.SEED.read },
      ],
      [
        { owner: "r1", path: "src/a.ts", weight: 1, status: "fresh" },
        { owner: "r2", path: "src/b.ts", weight: 0.4, status: "fresh" },
        { owner: "r3", path: "src/a.ts", weight: 1, status: "drifted" },
        { owner: "r4", path: "src/a.ts", weight: 0.4, status: "fresh" },
        { owner: "r4", path: "src/b.ts", weight: 0.4, status: "fresh" },
      ],
    )
    expect(active.get("r1")).toBe(1)
    expect(active.get("r2")).toBeCloseTo(0.28)
    expect(active.get("r3")).toBeCloseTo(0.7)
    // Two touched files together: 1 − (1 − 0.4)(1 − 0.28).
    expect(active.get("r4")).toBeCloseTo(0.568)
    const spread = BrainFuse.spread(
      active,
      [
        { id: "r1", passage: "p1", section: "s1" },
        { id: "r5", passage: "p1", section: "s1" },
        { id: "r6", passage: "p2", section: "s1" },
        { id: "r7", term: "billing" },
      ],
      [{ path: "src/billing/invoice.ts", weight: 1 }],
    )
    expect(spread.get("r5")).toBe(0.5)
    expect(spread.get("r6")).toBe(0.25)
    expect(spread.get("r7")).toBe(0.3)
  })
})

describe("BrainKnowledge.recall with seeds", () => {
  test("a touched file brings its linked requirement first with no word in common; a greeting brings nothing", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          yield* added(setup, text("Auth spec.md", SPEC))
          const touched = [{ path: "src/auth/session.ts", weight: BrainFuse.SEED.edited }]
          return {
            plain: yield* setup.knowledge.recall(setup.place, ask("tidy up this module before the release")),
            seeded: yield* setup.knowledge.recall(
              setup.place,
              ask("tidy up this module before the release", { seeds: touched }),
            ),
            tight: yield* setup.knowledge.recall(
              setup.place,
              ask("tidy up this module before the release", { seeds: touched, tier: "light", tight: true }),
            ),
            hi: yield* setup.knowledge.recall(setup.place, ask("hi", { seeds: touched })),
            ok: yield* setup.knowledge.recall(setup.place, ask("ok", { seeds: touched })),
            elsewhere: yield* setup.knowledge.recall(
              setup.place,
              ask("tidy up this module before the release", { seeds: [{ path: "src/ui/theme.ts", weight: 1 }] }),
            ),
            records: (yield* setup.knowledge.records(setup.place, { personal: true })).records,
          }
        }),
      { files: CODE, git: true },
    )
    const ttl = result.records.find((record) => record.quote.includes("refreshTokenTtl"))!
    expect(result.plain.tokens).toBe(0)
    expect(result.seeded.cards).toContain(ttl.id)
    expect(result.seeded.why[ttl.id]).toBe("anchor:src/auth/session.ts:definition")
    expect(result.seeded.text).toContain("The refreshTokenTtl MUST be 14 days.")
    // With room for one card, it is the linked one.
    expect(result.tight.cards).toEqual([ttl.id])
    // Unrelated sections stay out.
    expect(result.seeded.text).not.toContain("integer cents")
    expect(result.seeded.text).not.toContain("square")
    for (const nothing of [result.hi, result.ok, result.elsewhere]) {
      expect(nothing.tokens).toBe(0)
      expect(nothing.text ?? "").toBe("")
    }
  }, 30_000)
})
