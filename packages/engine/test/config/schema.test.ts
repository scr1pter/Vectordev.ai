import { expect, test } from "bun:test"
import { parse } from "jsonc-parser"
import { ConfigSchema } from "../../src/config/schema"

test("schema migration preserves comments and only replaces the exact legacy value", () => {
  const legacy =
    '{\n  // Keep this comment\n  "$schema": "https://opencode.ai/config.json",\n  "model": "example/model"\n}'
  const migrated = ConfigSchema.rewrite(legacy)
  expect(migrated).toContain("// Keep this comment")
  expect(parse(migrated)).toEqual({ $schema: "https://vectordev.ai/config.json", model: "example/model" })
  const custom = '{"$schema":"https://example.com/custom.json","model":"example/model"}'
  expect(ConfigSchema.rewrite(custom)).toBe(custom)
  const similar = '{"$schema":"https://opencode.ai/config.json?custom=1"}'
  expect(ConfigSchema.rewrite(similar)).toBe(similar)
})

test("TUI schema migration uses the TUI schema and leaves custom schemas untouched", () => {
  expect(parse(ConfigSchema.rewrite('{"$schema":"https://opencode.ai/tui.json","theme":"vector"}', "tui"))).toEqual({
    $schema: "https://vectordev.ai/tui.json",
    theme: "vector",
  })
  const custom = '{"$schema":"https://example.com/tui.json"}'
  expect(ConfigSchema.rewrite(custom, "tui")).toBe(custom)
})
