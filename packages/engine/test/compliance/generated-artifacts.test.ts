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
    for (const [committed, generated] of outputs)
      expect(
        Buffer.from(await Bun.file(path.join(root, committed)).arrayBuffer()).equals(
          Buffer.from(await Bun.file(path.join(tmp.path, generated)).arrayBuffer()),
        ),
        committed,
      ).toBe(true)
  }
}, 60_000)
