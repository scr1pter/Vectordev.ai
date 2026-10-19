import { expect, test } from "bun:test"
import { canAlwaysAllowPermission, canAutoApprovePermission, cloudPermissionDetails } from "../../src/util/permission"

test("automatic permission mode never approves doom-loop continuation", () => {
  expect(canAutoApprovePermission("edit")).toBe(true)
  expect(canAutoApprovePermission("doom_loop")).toBe(false)
  expect(canAutoApprovePermission("browser_sensitive")).toBe(false)
  expect(canAutoApprovePermission("computer_interact")).toBe(false)
})

test("a change to a memory file after outside content always asks", () => {
  expect(canAutoApprovePermission("memory_source", ["*"])).toBe(false)
  expect(canAlwaysAllowPermission("memory_source", ["*"])).toBe(false)
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

test("Cloud permission details retain the full SQL and exact account scope", () => {
  const sql = "select '" + "x".repeat(20_000) + "';\nselect 2;"
  const details = cloudPermissionDetails({
    permission: "vector_cloud_database",
    metadata: {
      provider: "Supabase",
      project: "shop",
      environment: "production",
      summary: "Apply migration",
      statements: [{ label: "Migration 001", sql, length: sql.length }, null, { sql: 2 }],
    },
  })
  expect(details?.rows).toEqual([
    { label: "Provider", value: "Supabase" },
    { label: "Supabase project", value: "shop" },
    { label: "Environment", value: "production" },
  ])
  expect(details?.summary).toBe("Apply migration")
  expect(details?.statements).toEqual([{ label: "Migration 001", sql, incomplete: false }])
  expect(cloudPermissionDetails({ permission: "edit", metadata: {} })).toBeUndefined()
  expect(
    cloudPermissionDetails({
      permission: "vector_cloud_database",
      metadata: { statements: [{ label: "old", sql: "select", length: 99 }] },
    })?.statements[0].incomplete,
  ).toBe(true)
})
