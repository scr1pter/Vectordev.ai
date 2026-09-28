import { expect, test } from "bun:test"
import { spendCapLabel } from "../../src/feature-plugins/sidebar/context"

test("spendCapLabel shows spend against the cap only when the run has a dollar cap", () => {
  expect(spendCapLabel({ spentUsd: 0.84, capUsd: 2 })).toBe("$0.84 of $2.00")
  expect(spendCapLabel({ spentUsd: 5.021, capUsd: 5 })).toBe("$5.02 of $5.00")
  expect(spendCapLabel({ spentUsd: 0.84 })).toBeUndefined()
  expect(spendCapLabel(undefined)).toBeUndefined()
})
