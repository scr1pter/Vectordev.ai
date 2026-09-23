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
  expect(ConfigSchema.rewrite(custom, "tui")).toBe(custom)
})
