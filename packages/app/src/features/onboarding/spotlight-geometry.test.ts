import { describe, expect, test } from "bun:test"
import { padRect, placeCard, rectsDiffer } from "./spotlight-geometry"

const viewport = { width: 1280, height: 800 }
const card = { width: 360, height: 220 }

describe("padRect", () => {
  test("expands symmetrically", () => {
    expect(padRect({ top: 100, left: 200, width: 40, height: 20 }, 6)).toEqual({
      top: 94,
      left: 194,
      width: 52,
      height: 32,
    })
  })
})

describe("rectsDiffer", () => {
  test("ignores sub-epsilon movement", () => {
    const a = { top: 10, left: 10, width: 100, height: 40 }
    expect(rectsDiffer(a, { ...a, top: 10.3 })).toBe(false)
    expect(rectsDiffer(a, { ...a, top: 12 })).toBe(true)
  })

  test("treats missing sides as different", () => {
    const a = { top: 10, left: 10, width: 100, height: 40 }
    expect(rectsDiffer(undefined, a)).toBe(true)
    expect(rectsDiffer(undefined, undefined)).toBe(false)
  })
})

describe("placeCard", () => {
  test("centers when there is no target", () => {
    const placed = placeCard({ viewport, card })
    expect(placed.placement).toBe("center")
    expect(placed.left).toBe((viewport.width - card.width) / 2)
    expect(placed.top).toBe((viewport.height - card.height) / 2)
  })

  test("prefers the right side of a left-rail target", () => {
    const placed = placeCard({ viewport, card, target: { top: 0, left: 0, width: 320, height: 800 } })
    expect(placed.placement).toBe("right")
    expect(placed.left).toBeGreaterThan(320)
  })

  test("flips left when the target hugs the right edge", () => {
    const placed = placeCard({ viewport, card, target: { top: 300, left: 1100, width: 160, height: 60 } })
    expect(placed.placement).toBe("left")
    expect(placed.left + card.width).toBeLessThanOrEqual(1100)
  })

  test("honors an explicit placement that fits", () => {
    const placed = placeCard({
      viewport,
      card,
      placement: "top",
      target: { top: 700, left: 400, width: 400, height: 80 },
    })
    expect(placed.placement).toBe("top")
    expect(placed.top + card.height).toBeLessThanOrEqual(700)
  })

  test("clamps inside the viewport when nothing fits", () => {
    const placed = placeCard({
      viewport: { width: 500, height: 400 },
      card,
      target: { top: 0, left: 0, width: 500, height: 400 },
    })
    expect(placed.left).toBeGreaterThanOrEqual(16)
    expect(placed.top).toBeGreaterThanOrEqual(16)
    expect(placed.left + card.width).toBeLessThanOrEqual(500 - 16)
  })

  test("keeps the card off the very edge for tall sidebar targets", () => {
    const placed = placeCard({ viewport, card, target: { top: 0, left: 0, width: 280, height: 800 } })
    expect(placed.top).toBeGreaterThanOrEqual(16)
    expect(placed.top + card.height).toBeLessThanOrEqual(800 - 16)
  })
})
