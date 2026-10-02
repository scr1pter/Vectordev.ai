import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

test("published schemas and dependency notices match their generators", async () => {
  await using tmp = await tmpdir()
  const root = path.resolve(import.meta.dir, "../../../..")
  for (const [cwd, command, outputs] of [
    [
      root,
      ["script/dependency-notices.ts", path.join(tmp.path, "notices.md")],
      [["DEPENDENCY_NOTICES.md", "notices.md"]],
    ],
    [
      path.join(root, "packages/engine"),
      ["script/schema.ts", path.join(tmp.path, "config.json"), path.join(tmp.path, "tui.json")],
      [
        ["packages/web/public/config.json", "config.json"],
        ["packages/web/public/tui.json", "tui.json"],
      ],
    ],
  ] as const) {
    const child = Bun.spawn([process.execPath, ...command], { cwd, stdout: "pipe", stderr: "pipe" })
    const [code, error] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ])
    expect(code, error).toBe(0)
    for (const [committed, generated] of outputs) {
      const expected = Buffer.from(await Bun.file(path.join(root, committed)).arrayBuffer())
      const actual = Buffer.from(await Bun.file(path.join(tmp.path, generated)).arrayBuffer())
      const matches = expected.equals(actual)
      expect(matches, matches ? committed : difference(committed, expected, actual)).toBe(true)
    }
  }
}, 60_000)

function difference(file: string, expected: Buffer, actual: Buffer) {
  const before = expected.toString("utf8").split("\n")
  const after = actual.toString("utf8").split("\n")
  const mismatch = before.findIndex((line, index) => line !== after[index])
  const index = mismatch < 0 ? before.length : mismatch
  const context = (lines: string[], bytes: number) => ({
    bytes,
    heading: lines
      .slice(0, index + 1)
      .findLast((line) => /^##\s/.test(line))
      ?.slice(0, 300),
    // Preserve CR and other control characters in the diagnostic; equality remains byte-exact.
    line: lines[index]?.slice(0, 400) ?? "<end of file>",
  })
  return `${file}: first different line ${index + 1}\n${JSON.stringify(
    { committed: context(before, expected.length), generated: context(after, actual.length) },
    null,
    2,
  )}`
}
