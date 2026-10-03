import { describe, expect, test } from "bun:test"
import { formatSessionCost } from "./session-cost"

const format = (value: number) => `$${value.toFixed(2)}`
const t = (key: "session.cost.unknown" | "session.cost.partial", params: { cost: string }) =>
  key === "session.cost.unknown" ? "Cost unknown" : `${params.cost} + unpriced`

describe("formatSessionCost", () => {
  test("a fully priced session shows its cost, free ones included", () => {
    expect(formatSessionCost({ cost: 1.5, unpricedSteps: undefined, format, t })).toBe("$1.50")
    expect(formatSessionCost({ cost: 0, unpricedSteps: 0, format, t })).toBe("$0.00")
  })

  test("a session made only of unpriced steps is unknown, not $0.00", () => {
    expect(formatSessionCost({ cost: 0, unpricedSteps: 3, format, t })).toBe("Cost unknown")
    expect(formatSessionCost({ cost: undefined, unpricedSteps: 1, format, t })).toBe("Cost unknown")
  })

  test("a session with some unpriced steps shows its cost as a lower bound", () => {
    expect(formatSessionCost({ cost: 0.42, unpricedSteps: 2, format, t })).toBe("$0.42 + unpriced")
  })
})
