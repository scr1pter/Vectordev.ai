import { describe, expect, test } from "bun:test"
import { ShareNext } from "../../src/share/share-next"

describe("Vector session sharing", () => {
  test("manual and automatic preferences allow the owned service while disabled stays off", () => {
    for (const setting of [undefined, "manual", "auto"]) expect(ShareNext.enabled(setting)).toBe(true)
    expect(ShareNext.enabled("disabled")).toBe(false)
    expect(ShareNext.disabledReason()).toContain("manual")
  })
})
