import { expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("ordinary plugin build emits its own files without writing the SDK build output", async () => {
  const source = path.resolve(import.meta.dirname, "..")
  const root = await mkdtemp(path.join(os.tmpdir(), "vector-plugin-build-"))
  const plugin = path.join(root, "packages/plugin")
  const sdk = path.join(root, "packages/sdk/js")
  try {
    for (const [from, to] of [
      [source, plugin],
      [path.resolve(source, "../sdk/js"), sdk],
    ]) {
      await mkdir(to, { recursive: true })
      await cp(path.join(from, "src"), path.join(to, "src"), { recursive: true })
      await cp(path.join(from, "package.json"), path.join(to, "package.json"))
    }
    await cp(path.join(source, "tsconfig.json"), path.join(plugin, "tsconfig.json"))
    await symlink(path.resolve(source, "../sdk/js/node_modules"), path.join(sdk, "node_modules"), "dir")
    await mkdir(path.join(plugin, "node_modules"))
    for (const entry of await readdir(path.join(source, "node_modules"))) {
      if (!entry.startsWith("@")) {
        await symlink(
          await realpath(path.join(source, "node_modules", entry)),
          path.join(plugin, "node_modules", entry),
          "dir",
        )
        continue
      }
      await mkdir(path.join(plugin, "node_modules", entry))
      for (const name of await readdir(path.join(source, "node_modules", entry)))
        await symlink(
          entry === "@vectordevai" && name === "sdk"
            ? sdk
            : await realpath(path.join(source, "node_modules", entry, name)),
          path.join(plugin, "node_modules", entry, name),
          "dir",
        )
    }
    const sentinel = path.join(sdk, "dist/parallel-sdk-output.txt")
    await Bun.write(sentinel, "An independent SDK build owns this output.\n")
    const before = await stat(sentinel)
    const child = Bun.spawn([process.execPath, "run", "build"], { cwd: plugin, stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(await Bun.file(path.join(plugin, "dist/index.js")).exists()).toBe(true)
    expect(await Bun.file(path.join(plugin, "dist/index.d.ts")).exists()).toBe(true)
    expect(await readdir(path.join(sdk, "dist"))).toEqual(["parallel-sdk-output.txt"])
    expect(await Bun.file(sentinel).text()).toBe("An independent SDK build owns this output.\n")
    expect((await stat(sentinel)).mtimeMs).toBe(before.mtimeMs)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
