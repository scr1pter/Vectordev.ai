import { expect, test } from "bun:test"
import { canAutoApprovePermission } from "../../src/util/permission"

test("automatic permission mode never approves doom-loop continuation", () => {
  expect(canAutoApprovePermission("edit")).toBe(true)
  expect(canAutoApprovePermission("doom_loop")).toBe(false)
})
