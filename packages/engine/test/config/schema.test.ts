import { expect, test } from "bun:test"
import { parse } from "jsonc-parser"
import { ConfigSchema } from "../../src/config/schema"

test("schema defaults preserve comments and explicit custom schemas", () => {
  const input = '{\n  // Keep this comment\n  "model": "example/model"\n}'
  const configured = ConfigSchema.rewrite(input)
  expect(configured).toContain("// Keep this comment")
  expect(parse(configured)).toEqual({ $schema: "https://vectordev.ai/config.json", model: "example/model" })
  const custom = '{"$schema":"https://example.com/custom.json","model":"example/model"}'
  expect(ConfigSchema.rewrite(custom)).toBe(custom)
})

test("TUI schema defaults use the Vector TUI schema", () => {
  expect(parse(ConfigSchema.rewrite('{"theme":"vector"}', "tui"))).toEqual({
    $schema: "https://vectordev.ai/tui.json",
    theme: "vector",
  })
  const custom = '{"$schema":"https://example.com/tui.json"}'
  expect(parse(ConfigSchema.rewrite(custom, "tui")).$schema).toBe("https://vectordev.ai/tui.json")
})

test("rewrites recognized schema paths by shape and preserves settings and comments", () => {
  for (const kind of ["config", "tui", "theme", "desktop-theme"] as const) {
    const input = `{
 // permission must survive
 "$schema": "https://previous.example/schema/${kind}.json?version=1#root",
 "permission": {"bash": "deny"}
}`
    const updated = ConfigSchema.rewrite(input, kind)
    expect(updated).toContain("// permission must survive")
    expect(parse(updated)).toEqual({ $schema: `https://vectordev.ai/${kind}.json`, permission: { bash: "deny" } })
    expect(ConfigSchema.rewrite(updated, kind)).toBe(updated)
  }
})

test("does not replace arbitrary custom schemas or malformed schema values", () => {
  for (const schema of [
    "https://enterprise.example/custom.json",
    "https://vectordev.ai/config.json",
    "./local.json",
    12,
  ]) {
    const input = JSON.stringify({ $schema: schema, permission: { bash: "deny" } })
    expect(ConfigSchema.rewrite(input)).toBe(input)
  }
})
