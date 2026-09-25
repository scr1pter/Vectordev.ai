import { expect, test } from "bun:test"
import { logo } from "@vectordevai/tui/logo"
import path from "node:path"

test("non-TTY CLI output uses the shared Vector glyphs without ANSI colors", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { UI } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/cli/ui.ts"))}; console.log(JSON.stringify(UI.logo("  ")))`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const output = JSON.parse(await new Response(child.stdout).text())
  expect(await child.exited).toBe(0)
  expect(await new Response(child.stderr).text()).toBe("")
  expect(output).toBe(
    logo.left
      .map((row, index) => `  ${row} ${logo.right[index]}`.replaceAll("_", " ").replace(/[~^]/g, "▀"))
      .join("\n")
      .trimEnd(),
  )
  expect(Bun.stripANSI(output)).toBe(output)
})
