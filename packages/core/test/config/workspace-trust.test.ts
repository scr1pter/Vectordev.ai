import fs from "node:fs/promises"
import path from "node:path"
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

  test("only allows HTTPS and HTTP loopback endpoints", () => {
    expect(WorkspaceTrust.remoteUrlAllowed("https://example.com/api")).toBe(true)
    expect(WorkspaceTrust.remoteUrlAllowed("http://127.0.0.1:4096/api")).toBe(true)
    expect(WorkspaceTrust.remoteUrlAllowed("http://localhost:4096/api")).toBe(true)
    expect(WorkspaceTrust.remoteUrlAllowed("http://example.com/api")).toBe(false)
    expect(WorkspaceTrust.remoteUrlAllowed("https://user:secret@example.com/api")).toBe(false)
  })
})
