import { describe, expect, test } from "bun:test"
import { BrainPack } from "@vectordevai/core/brain/pack"

const card = (id: string, value: number, extra: Partial<BrainPack.Candidate> = {}): BrainPack.Candidate => ({
  id,
  value,
  cost: 40,
  ...extra,
})

const ids = (cards: readonly BrainPack.Candidate[]) => cards.map((item) => item.id)

describe("BrainPack.pack", () => {
  test("nothing eligible costs nothing, and nothing fits a budget of 0", () => {
    expect(BrainPack.pack([], 500)).toEqual([])
    expect(BrainPack.pack([card("a", 1)], 0)).toEqual([])
  })

  test("takes the most worth per token first and never passes the budget", () => {
    const picked = BrainPack.pack(
      [card("cheap", 0.6, { cost: 20 }), card("dear", 1, { cost: 100 }), card("middle", 0.9, { cost: 40 })],
      70,
    )
    expect(ids(picked)).toEqual(["cheap", "middle"])
    expect(picked.reduce((sum, item) => sum + item.cost, 0)).toBeLessThanOrEqual(70)
  })

  test("a second card from the same section is worth half, so another section's card goes first", () => {
    const picked = BrainPack.pack(
      [
        card("s1-a", 1, { document: "d1", section: "s1" }),
        card("s1-b", 0.9, { document: "d1", section: "s1" }),
        card("s2-a", 0.6, { document: "d2", section: "s2" }),
      ],
      80,
    )
    expect(ids(picked)).toEqual(["s1-a", "s2-a"])
  })

  test("at most two cards from a section and four from a document", () => {
    const section = BrainPack.pack(
      ["a", "b", "c"].map((id) => card(id, 1, { document: "d1", section: "s1", cost: 10 })),
      1_000,
    )
    expect(section).toHaveLength(2)
    const document = BrainPack.pack(
      ["a", "b", "c", "d", "e", "f"].map((id) => card(id, 1, { document: "d1", section: id, cost: 10 })),
      1_000,
    )
    expect(document).toHaveLength(4)
  })

  test("a card about a subject already picked is left out", () => {
    const picked = BrainPack.pack(
      [
        card("v2", 1, { subject: "requirement|retry", document: "d2" }),
        card("v1", 0.9, { subject: "requirement|retry", document: "d1" }),
        card("other", 0.5, { subject: "requirement|upload", document: "d3" }),
      ],
      1_000,
    )
    expect(ids(picked)).toEqual(["v2", "other"])
  })

  test("two cards that disagree go in together or not at all", () => {
    const pair = [
      card("old", 0.9, { conflicts: ["new"], document: "d1", cost: 30 }),
      card("new", 0.2, { conflicts: ["old"], document: "d2", cost: 30 }),
    ]
    expect(ids(BrainPack.pack(pair, 60)).toSorted()).toEqual(["new", "old"])
    // Room for one only: neither side is heard alone.
    expect(BrainPack.pack(pair, 40)).toEqual([])
  })

  test("stops once the next card is worth little next to the first", () => {
    const picked = BrainPack.pack([card("best", 1), card("weak", 0.1)], 1_000)
    expect(ids(picked)).toEqual(["best"])
  })
})
