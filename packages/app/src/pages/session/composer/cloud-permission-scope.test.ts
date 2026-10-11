import { describe, expect, test } from "bun:test"
import { cloudPermissionScope, permissionStatements } from "./cloud-permission-scope"

describe("cloud permission scope", () => {
  test("shows the provider, project and environment a cloud action would touch", () => {
    expect(
      cloudPermissionScope({
        permission: "vector_cloud_publish",
        metadata: {
          projectPath: "/work/shop",
          provider: "Vercel",
          project: "shop-web",
          environment: "production",
          summary: "Publish this project to the Vercel project shop-web as a production release.",
          production: true,
        },
      }),
    ).toEqual({
      summary: "Publish this project to the Vercel project shop-web as a production release.",
      rows: [
        { label: "Provider", value: "Vercel" },
        { label: "Project", value: "shop-web" },
        { label: "Environment", value: "production" },
      ],
    })
  })

  test("ignores other permissions and metadata that is not text", () => {
    expect(cloudPermissionScope({ permission: "bash", metadata: { provider: "Vercel" } })).toBeUndefined()
    expect(
      cloudPermissionScope({
        permission: "vector_cloud_database",
        metadata: { provider: 42, project: { name: "x" }, environment: "  ", summary: "" },
      }),
    ).toBeUndefined()
    expect(cloudPermissionScope({ permission: "vector_cloud_database", metadata: { project: "shop-db" } })).toEqual({
      summary: undefined,
      rows: [{ label: "Project", value: "shop-db" }],
    })
  })

  test("shows the SQL a prompt is about, saying when it was cut", () => {
    expect(
      permissionStatements({
        metadata: {
          statements: [
            { label: "Read-only SQL", sql: "select token from auth.refresh_tokens", length: 37, truncated: false },
            { label: "Down migration down/1_a.down.sql", sql: "drop table a;", length: 12_345, truncated: true },
            { label: "empty", sql: "  " },
            "not a statement",
          ],
        },
      }),
    ).toEqual([
      { label: "Read-only SQL", sql: "select token from auth.refresh_tokens", note: undefined },
      {
        label: "Down migration down/1_a.down.sql",
        sql: "drop table a;",
        note: "Showing the first 13 of 12,345 characters.",
      },
    ])
    expect(permissionStatements({ metadata: {} })).toEqual([])
  })
})
