import { expect, test } from "bun:test"
import path from "node:path"
import { unguardedBunReferences } from "../../script/node-bundle-guard"

// A bundle shaped like Bun.build's output, with each module's code after a `// <path>` marker at column 0.
const bundle = (join: (...parts: string[]) => string, newline: string) =>
  [
    `// ${join("..", "core", "src", "plugin", "local-sdk.ts")}`,
    "function prepare(file) {",
    '  if (typeof Bun === "undefined") return',
    '  Bun.plugin({ name: "compat", setup() {} })',
    '  return Bun.resolveSync("dep", file)',
    "}",
    "",
    `// ${join("src", "tool", "registry.ts")}`,
    'const source = Bun.file("tool.ts")',
    "",
  ].join(newline)

// The Windows release build runs the guard too, so its module markers must still match the allowed entries.
for (const [name, join, newline] of [
  ["posix", path.posix.join, "\n"],
  ["backslash", path.win32.join, "\n"],
  ["backslash and CRLF", path.win32.join, "\r\n"],
] as const) {
  test(`node bundle guard reads ${name} module markers`, () => {
    expect(unguardedBunReferences(bundle(join, newline), [])).toEqual([
      { line: 4, module: "../core/src/plugin/local-sdk.ts", api: "Bun.plugin" },
      { line: 5, module: "../core/src/plugin/local-sdk.ts", api: "Bun.resolveSync" },
      { line: 9, module: "src/tool/registry.ts", api: "Bun.file" },
    ])
    expect(unguardedBunReferences(bundle(join, newline))).toEqual([
      { line: 9, module: "src/tool/registry.ts", api: "Bun.file" },
    ])
  })
}
