import { describe, expect, test } from "bun:test"
import { updaterEnabled } from "./updater-policy"

describe("desktop updater policy", () => {
  test("enables production and beta packages by default", () => {
    expect(updaterEnabled({ packaged: true, channel: "prod" })).toBe(true)
    expect(updaterEnabled({ packaged: true, channel: "beta" })).toBe(true)
  })

  test("keeps development builds off and supports an emergency disable", () => {
    expect(updaterEnabled({ packaged: false, channel: "prod" })).toBe(false)
    expect(updaterEnabled({ packaged: true, channel: "dev" })).toBe(false)
    expect(updaterEnabled({ packaged: true, channel: "prod", override: "0" })).toBe(false)
  })
})
