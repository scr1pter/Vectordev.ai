import { describe, expect, test } from "bun:test"
import { cloudPermissionScope } from "./cloud-permission-scope"

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
})
