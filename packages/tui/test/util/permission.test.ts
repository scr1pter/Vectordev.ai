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

test.each(["vector_cloud_publish", "vector_cloud_database", "vector_cloud_environment", "vector_cloud_hosting"])(
  "Cloud write %s never auto-accepts or retains approval",
  (permission) => {
    expect(canAutoApprovePermission(permission, ["*"])).toBe(false)
    expect(canAlwaysAllowPermission(permission, ["*"])).toBe(false)
  },
)

test("Cloud each-time requests stay manual and repeatable inspection can auto-accept", () => {
  expect(canAutoApprovePermission("vector_cloud_future", [])).toBe(false)
  expect(canAutoApprovePermission("vector_cloud_future")).toBe(false)
  expect(canAlwaysAllowPermission("vector_cloud_future", [])).toBe(false)
  expect(canAutoApprovePermission("vector_cloud_inspect", ["supabase/project/preview"])).toBe(true)
})
