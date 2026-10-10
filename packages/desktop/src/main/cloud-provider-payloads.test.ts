import { describe, expect, test } from "bun:test"

import { vercelEnvironmentPayload } from "./cloud-provider-payloads"

describe("cloud provider payloads", () => {
  test("creates encrypted Vercel variables for every deployment environment", () => {
    expect(vercelEnvironmentPayload([{ key: "DATABASE_URL", value: "postgres://local" }])).toEqual([
      {
        key: "DATABASE_URL",
        value: "postgres://local",
        type: "encrypted",
        target: ["production", "preview", "development"],
        comment: "Synced by Vector",
      },
    ])
  })
})
