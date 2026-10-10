import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, test } from "bun:test"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { tmpdir } from "../fixture/tmpdir"

describe("WorkspaceTrust", () => {
  test("stores canonical workspace approval outside the workspace and invalidates changed content", async () => {
    await using workspace = await tmpdir()
    await using state = await tmpdir()
    const config = path.join(workspace.path, "vector.json")
    await fs.writeFile(config, JSON.stringify({ plugins: ["example@1.0.0"] }))

    const initial = await WorkspaceTrust.snapshot(path.join(workspace.path, "."), [config])
    expect((await WorkspaceTrust.status(state.path, initial)).trusted).toBe(false)

    await WorkspaceTrust.approve(state.path, initial)
    expect((await WorkspaceTrust.status(state.path, initial)).trusted).toBe(true)
    expect(await fs.stat(path.join(state.path, "workspace-trust.json"))).toBeDefined()
    expect(await fs.stat(path.join(workspace.path, "workspace-trust.json")).catch(() => undefined)).toBeUndefined()

    await fs.writeFile(config, JSON.stringify({ plugins: ["example@1.0.1"] }))
    const changed = await WorkspaceTrust.snapshot(workspace.path, [config])
    expect(changed.workspace).toBe(initial.workspace)
    expect(changed.fingerprint).not.toBe(initial.fingerprint)
    expect((await WorkspaceTrust.status(state.path, changed)).trusted).toBe(false)
  })

  test("fingerprints sibling configs and local plugin sources but ignores housekeeping files", async () => {
    await using workspace = await tmpdir()
    const config = path.join(workspace.path, "vector.json")
    const plugin = path.join(workspace.path, "plugin.ts")
    await fs.writeFile(config, JSON.stringify({ plugin: ["./plugin.ts"] }))
    await fs.writeFile(plugin, "export default async () => ({})\n")
    const initial = await WorkspaceTrust.snapshot(workspace.path, [config])

    await fs.mkdir(path.join(workspace.path, ".vector"))
    await fs.writeFile(path.join(workspace.path, ".vector", ".gitignore"), "*\n")
    expect((await WorkspaceTrust.snapshot(workspace.path, [config])).fingerprint).toBe(initial.fingerprint)

    await fs.writeFile(plugin, "export default async () => ({ changed: true })\n")
    expect((await WorkspaceTrust.snapshot(workspace.path, [config])).fingerprint).not.toBe(initial.fingerprint)

    await fs.writeFile(plugin, "export default async () => ({})\n")
    await fs.writeFile(path.join(workspace.path, "tui.json"), JSON.stringify({ theme: "dark" }))
    expect((await WorkspaceTrust.snapshot(workspace.path, [config])).fingerprint).not.toBe(initial.fingerprint)
  })

  test("invalidates approval when referenced local executable content changes", async () => {
    await using workspace = await tmpdir()
    await using state = await tmpdir()
    const directory = path.join(workspace.path, "config")
    const config = path.join(directory, "vector.json")
    const targets = [
      path.join(directory, "shell"),
      path.join(workspace.path, "tools", "formatter"),
      path.join(workspace.path, "tools", "lsp.js"),
      path.join(workspace.path, "servers", "mcp.js"),
    ]
    await Promise.all([
      fs.mkdir(directory, { recursive: true }),
      fs.mkdir(path.join(workspace.path, "tools"), { recursive: true }),
      fs.mkdir(path.join(workspace.path, "servers"), { recursive: true }),
    ])
    await fs.writeFile(
      config,
      JSON.stringify({
        shell: "./shell",
        formatter: { custom: { command: ["./tools/formatter"] } },
        lsp: { custom: { command: ["node", "./tools/lsp.js"] } },
        mcp: { servers: { custom: { type: "local", cwd: "servers", command: ["node", "./mcp.js"] } } },
      }),
    )
    await Promise.all(targets.map((target) => fs.writeFile(target, "initial\n")))
    const initial = await WorkspaceTrust.snapshot(workspace.path, [config])
    await WorkspaceTrust.approve(state.path, initial)

    for (const target of targets) {
      await fs.writeFile(target, "changed\n")
      const changed = await WorkspaceTrust.snapshot(workspace.path, [config])
      expect(changed.fingerprint).not.toBe(initial.fingerprint)
      expect((await WorkspaceTrust.status(state.path, changed)).trusted).toBe(false)
      await fs.writeFile(target, "initial\n")
      expect((await WorkspaceTrust.snapshot(workspace.path, [config])).fingerprint).toBe(initial.fingerprint)
    }
  })

  test("materializes the exact approved bytes instead of reopening changed executable inputs", async () => {
    await using workspace = await tmpdir()
    await using state = await tmpdir()
    const config = path.join(workspace.path, "vector.json")
    const plugin = path.join(workspace.path, "plugin.ts")
    await fs.writeFile(config, JSON.stringify({ plugins: ["./plugin.ts"] }))
    await fs.writeFile(plugin, "export default 'approved'\n")

    const approved = await WorkspaceTrust.snapshot(workspace.path, [config])
    await WorkspaceTrust.approve(state.path, approved)
    const trusted = await WorkspaceTrust.materialize(state.path, approved)
    await fs.writeFile(config, JSON.stringify({ plugins: ["./changed.ts"] }))
    await fs.writeFile(plugin, "export default 'changed'\n")

    expect(WorkspaceTrust.readFileString(approved, config)).toBe(JSON.stringify({ plugins: ["./plugin.ts"] }))
    expect(await fs.readFile(WorkspaceTrust.materializedPath(trusted, plugin), "utf8")).toBe(
      "export default 'approved'\n",
    )
    expect((await WorkspaceTrust.status(state.path, approved)).trusted).toBe(true)
    expect(
      (await WorkspaceTrust.status(state.path, await WorkspaceTrust.snapshot(workspace.path, [config]))).trusted,
    ).toBe(false)
  })

  test("joins cross-process materializers and ignores unrelated runtime artifacts", async () => {
    await using workspace = await tmpdir()
    await using state = await tmpdir()
    const config = path.join(workspace.path, "vector.json")
    const plugin = path.join(workspace.path, "plugin.ts")
    await fs.writeFile(config, JSON.stringify({ plugins: ["./plugin.ts"] }))
    await fs.writeFile(plugin, "export default 'approved'\n")
    const approved = await WorkspaceTrust.snapshot(workspace.path, [config])
    const runner = path.join(state.path, "materialize.ts")
    await fs.writeFile(
      runner,
      `import { WorkspaceTrust } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "../../src/workspace-trust/workspace-trust.ts")).href)}
const snapshot = await WorkspaceTrust.snapshot(${JSON.stringify(workspace.path)}, [${JSON.stringify(config)}])
await WorkspaceTrust.materialize(${JSON.stringify(state.path)}, snapshot)
`,
    )
    const children = Array.from({ length: 8 }, () =>
      Bun.spawn({ cmd: [process.execPath, runner], stdout: "ignore", stderr: "ignore" }),
    )
    expect(await Promise.all(children.map((child) => child.exited))).toEqual(Array.from({ length: 8 }, () => 0))

    const copy = await WorkspaceTrust.materialize(state.path, approved)
    await fs.writeFile(path.join(copy.directory, ".runtime.lock"), "another process is preparing dependencies\n")

    const reused = await Promise.all(Array.from({ length: 16 }, () => WorkspaceTrust.materialize(state.path, approved)))
    expect(new Set(reused.map((item) => item.directory))).toEqual(new Set([copy.directory]))
    expect(await fs.readFile(WorkspaceTrust.materializedPath(reused[0]!, plugin), "utf8")).toBe(
      "export default 'approved'\n",
    )

    const copiedPlugin = WorkspaceTrust.materializedPath(reused[0]!, plugin)
    await fs.chmod(copiedPlugin, 0o600)
    await fs.writeFile(copiedPlugin, "export default 'tampered'\n")
    await expect(WorkspaceTrust.materialize(state.path, approved)).rejects.toThrow("changed at")
  })

  test("does not traverse directory symlinks outside the workspace", async () => {
    if (process.platform === "win32") return
    await using workspace = await tmpdir()
    await using external = await tmpdir()
    const config = path.join(workspace.path, "vector.json")
    const linked = path.join(workspace.path, ".vector", "plugins")
    await fs.mkdir(path.dirname(linked), { recursive: true })
    await fs.writeFile(config, "{}")
    await fs.writeFile(path.join(external.path, "plugin.ts"), "export default 'initial'\n")
    await fs.symlink(external.path, linked, "dir")

    const initial = await WorkspaceTrust.snapshot(workspace.path, [config])
    await fs.writeFile(path.join(external.path, "plugin.ts"), "export default 'changed'\n")

    expect((await WorkspaceTrust.snapshot(workspace.path, [config])).fingerprint).toBe(initial.fingerprint)
  })

  test("bounds recursive trust traversal", async () => {
    await using workspace = await tmpdir()
    const root = path.join(workspace.path, ".vector")
    let directory = root
    for (let depth = 0; depth < 66; depth++) directory = path.join(directory, `d${depth}`)
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, "plugin.ts"), "export default {}\n")

    await expect(WorkspaceTrust.snapshot(workspace.path, [root])).rejects.toThrow("traversal exceeded 64 levels")
  })

  test("only allows HTTPS and HTTP loopback endpoints", () => {
    expect(WorkspaceTrust.remoteUrlAllowed("https://example.com/api")).toBe(true)
    expect(WorkspaceTrust.remoteUrlAllowed("http://127.0.0.1:4096/api")).toBe(true)
    expect(WorkspaceTrust.remoteUrlAllowed("http://localhost:4096/api")).toBe(true)
    expect(WorkspaceTrust.remoteUrlAllowed("http://example.com/api")).toBe(false)
    expect(WorkspaceTrust.remoteUrlAllowed("https://user:secret@example.com/api")).toBe(false)
  })
})
