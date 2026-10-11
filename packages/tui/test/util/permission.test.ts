import { expect, test } from "bun:test"
import { canAlwaysAllowPermission, canAutoApprovePermission } from "../../src/util/permission"

test("automatic permission mode never approves doom-loop continuation", () => {
  expect(canAutoApprovePermission("edit")).toBe(true)
  expect(canAutoApprovePermission("doom_loop")).toBe(false)
  expect(canAutoApprovePermission("browser_sensitive")).toBe(false)
  expect(canAutoApprovePermission("computer_interact")).toBe(false)
})

test("sensitive permissions can only be allowed once", () => {
  expect(canAlwaysAllowPermission("webfetch", ["https://example.com"])).toBe(true)
  expect(canAlwaysAllowPermission("browser_sensitive", ["*"])).toBe(false)
  expect(canAlwaysAllowPermission("computer_sensitive", ["window:42:0"])).toBe(false)
})
