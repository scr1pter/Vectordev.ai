import { describe, expect, test } from "bun:test"
import { canAlwaysAllowPermission, canAutoAcceptPermission, computerPermissionDetails } from "./permission-policy"

describe("canAutoAcceptPermission", () => {
  test("allows ordinary permission prompts", () => {
    expect(canAutoAcceptPermission("edit")).toBe(true)
    expect(canAutoAcceptPermission("browser_external")).toBe(true)
  })

  test.each(["browser_sensitive", "computer_observe", "computer_interact", "computer_sensitive"])(
    "requires a manual decision for %s",
    (permission) => {
      expect(canAutoAcceptPermission(permission)).toBe(false)
    },
  )

  test("requires a manual decision for future computer permissions", () => {
    expect(canAutoAcceptPermission("computer_new_action")).toBe(false)
  })
})

describe("canAlwaysAllowPermission", () => {
  test("requires at least one permanent approval pattern", () => {
    expect(canAlwaysAllowPermission()).toBe(false)
    expect(canAlwaysAllowPermission("webfetch", [])).toBe(false)
    expect(canAlwaysAllowPermission("webfetch", ["https://example.com"])).toBe(true)
  })

  test.each(["computer_observe", "computer_interact", "computer_sensitive", "computer_future_action"])(
    "never offers permanent approval for %s",
    (permission) => {
      expect(canAlwaysAllowPermission(permission, ["window:42:0"])).toBe(false)
    },
  )
})

describe("computerPermissionDetails", () => {
  test("describes the exact action and human-readable target", () => {
    expect(
      computerPermissionDetails({
        permission: "computer_interact",
        patterns: ["window:42:0"],
        metadata: { action: "click", x: 120.4, y: 48.8, appName: "Safari", targetName: "Checkout" },
      }),
    ).toEqual({ action: "Click once at 120, 49", target: "Safari · Checkout", proposedText: undefined })
  })

  test("does not expose an internal window ID as the target", () => {
    const details = computerPermissionDetails({
      permission: "computer_sensitive",
      patterns: ["window:42:0"],
      metadata: { action: "type", targetId: "window:42:0" },
    })
    expect(details).toEqual({ action: "Type text in the selected app", target: undefined, proposedText: undefined })
    expect(JSON.stringify(details)).not.toContain("window:42:0")
  })

  test("returns the exact proposed text for explicit review", () => {
    const details = computerPermissionDetails({
      permission: "computer_sensitive",
      patterns: ["window:42:0"],
      metadata: { action: "type", text: "Send the release notes\nwhen ready" },
    })
    expect(details?.proposedText).toBe("Send the release notes\nwhen ready")
    expect(details?.action).toBe("Type 33 characters")
  })
})
