import { describe, expect, test } from "bun:test"
import { Locale } from "../../src/util/locale"

describe("Locale.spend", () => {
  test("a fully priced session shows its cost, free ones included", () => {
    expect(Locale.spend(1.5, undefined)).toBe("$1.50")
    expect(Locale.spend(0, 0)).toBe("$0.00")
  })

  test("a session made only of unpriced steps is unknown, not $0.00", () => {
    expect(Locale.spend(0, 2)).toBe("cost unknown")
  })

  test("a session with some unpriced steps shows its cost as a lower bound", () => {
    expect(Locale.spend(0.42, 1)).toBe("$0.42 + unpriced")
  })
})
