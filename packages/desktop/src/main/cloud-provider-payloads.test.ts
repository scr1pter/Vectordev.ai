import { describe, expect, test } from "bun:test"

import {
  addNetlifyDomainAlias,
  netlifyEnvironmentPayload,
  removeNetlifyDomainAlias,
  vercelEnvironmentPayload,
} from "./cloud-provider-payloads"

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

  test("creates secret Netlify variables across build and runtime scopes", () => {
    expect(netlifyEnvironmentPayload([{ key: "API_KEY", value: "secret" }])).toEqual([
      {
        key: "API_KEY",
        scopes: ["builds", "functions", "runtime"],
        values: [{ value: "secret", context: "all" }],
        is_secret: true,
      },
    ])
  })

  test("adds and removes Netlify aliases without duplicates", () => {
    expect(addNetlifyDomainAlias(["www.example.com"], "APP.EXAMPLE.COM")).toEqual([
      "www.example.com",
      "app.example.com",
    ])
    expect(removeNetlifyDomainAlias(["www.example.com", "app.example.com"], "APP.EXAMPLE.COM")).toEqual([
      "www.example.com",
    ])
  })
})
