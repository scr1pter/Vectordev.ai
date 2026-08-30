import { describe, expect, test } from "bun:test"
import { updaterEnabled, updaterPolicy } from "./updater-policy"

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

  test("reports why an update channel is unavailable", () => {
    expect(updaterPolicy({ packaged: false, channel: "prod" })).toEqual({
      enabled: false,
      reason: "not-packaged",
    })
    expect(updaterPolicy({ packaged: true, channel: "dev" })).toEqual({
      enabled: false,
      reason: "development-channel",
    })
    expect(updaterPolicy({ packaged: true, channel: "prod", override: "off" })).toEqual({
      enabled: false,
      reason: "emergency-disabled",
    })
  })
})
