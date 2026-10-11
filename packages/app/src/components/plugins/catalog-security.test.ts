import { describe, expect, test } from "bun:test"
import { assertPluginInstallable, isPinnedPluginCommand, isSecurePluginRemoteUrl, PLUGIN_CATALOG } from "./catalog"

describe("plugin supply-chain policy", () => {
  test("accepts immutable package versions and rejects latest or unversioned commands", () => {
    expect(isPinnedPluginCommand(["npx", "-y", "@vendor/plugin@1.2.3"])).toBe(true)
    expect(isPinnedPluginCommand(["uvx", "vendor-plugin@1.2.3"])).toBe(true)
    expect(isPinnedPluginCommand(["docker", "run", "vendor/plugin@sha256:" + "a".repeat(64)])).toBe(true)
    expect(isPinnedPluginCommand(["npx", "-y", "@vendor/plugin@latest"])).toBe(false)
    expect(isPinnedPluginCommand(["npx", "-y", "@vendor/plugin"])).toBe(false)
    expect(isPinnedPluginCommand(["npx", "-y", "mutable-plugin", "pinned-decoy@1.2.3"])).toBe(false)
    expect(isPinnedPluginCommand(["uvx", "vendor-plugin"])).toBe(false)
  })

  test("blocks an unpinned catalog install before returning executable config", () => {
    const plugin = PLUGIN_CATALOG.find((item) => item.id === "supabase")
    const config = plugin?.build?.({ SUPABASE_ACCESS_TOKEN: "secret" })
    expect(config).toBeDefined()
    expect(() => assertPluginInstallable(config!)).toThrow("not pinned")
  })

  test("allows only credential-free HTTPS remote plugin endpoints", () => {
    expect(isSecurePluginRemoteUrl("https://mcp.example.test/path")).toBe(true)
    expect(isSecurePluginRemoteUrl("http://mcp.example.test/path")).toBe(false)
    expect(isSecurePluginRemoteUrl("https://user:secret@mcp.example.test/path")).toBe(false)
    expect(isSecurePluginRemoteUrl("https://mcp.example.test/path?token=secret")).toBe(false)
    expect(isSecurePluginRemoteUrl("javascript:alert(1)")).toBe(false)
  })
})
