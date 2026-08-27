import { describe, expect, test } from "bun:test"
import { PLUGIN_CATALOG } from "./catalog"
import { pluginAuthValues, securePluginConfig } from "./secure-config"

function plugin(id: string) {
  const result = PLUGIN_CATALOG.find((item) => item.id === id)
  if (!result) throw new Error(`Missing plugin fixture: ${id}`)
  return result
}

describe("securePluginConfig", () => {
  test("moves a remote bearer token into the encrypted vault payload", () => {
    const prepared = securePluginConfig(plugin("github"), { token: "github-secret" })

    expect(prepared).toEqual({
      config: {
        type: "remote",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer {vault:token}" },
        oauth: false,
        enabled: true,
        timeout: 120_000,
      },
      secrets: { token: "github-secret" },
    })
    expect(JSON.stringify(prepared?.config)).not.toContain("github-secret")
  })

  test("moves local environment credentials into the encrypted vault payload", () => {
    const prepared = securePluginConfig(plugin("supabase"), {
      SUPABASE_ACCESS_TOKEN: "supabase-secret",
    })

    expect(prepared?.config).toMatchObject({
      type: "local",
      environment: { SUPABASE_ACCESS_TOKEN: "{vault:SUPABASE_ACCESS_TOKEN}" },
    })
    expect(prepared?.secrets).toEqual({ SUPABASE_ACCESS_TOKEN: "supabase-secret" })
    expect(JSON.stringify(prepared?.config)).not.toContain("supabase-secret")
  })

  test("protects a credential passed as a command argument", () => {
    const prepared = securePluginConfig(plugin("postgres"), {
      connection: "postgresql://user:password@example.com/database",
    })

    expect(prepared?.config).toMatchObject({
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-postgres", "{vault:connection}"],
    })
    expect(prepared?.secrets).toEqual({ connection: "postgresql://user:password@example.com/database" })
  })

  test("allows a documented optional credential to stay empty", () => {
    expect(
      pluginAuthValues(plugin("redis"), {
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: "6379",
        REDIS_PWD: "",
      }),
    ).toEqual({ REDIS_HOST: "127.0.0.1", REDIS_PORT: "6379", REDIS_PWD: "" })
    expect(pluginAuthValues(plugin("redis"), { REDIS_PORT: "6379" })).toBeUndefined()
  })
})
