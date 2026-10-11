import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveCloudScope } from "./cloud-scope"

let root = ""

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=Vector Test", "-c", "user.email=test@vector.invalid", ...args],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

beforeEach(async () => {
  // git reports real paths, so the fixture uses them too (macOS links /var to /private/var).
  root = await realpath(await mkdtemp(join(tmpdir(), "vector-cloud-scope-")))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("cloud scope", () => {
  test("a parallel workspace resolves to the project the desktop created it from", async () => {
    const scope = await resolveCloudScope("/work/agents/ws-1/workspace", [
      { id: "ws-0", name: "Other", sourcePath: "/work/other", isolatedPath: "/work/agents/ws-0/workspace" },
      { id: "ws-1", name: "Agent 1", sourcePath: "/work/shop", isolatedPath: "/work/agents/ws-1/workspace" },
    ])
    expect(scope).toEqual({
      projectPath: "/work/shop",
      directory: "/work/agents/ws-1/workspace",
      workspace: { id: "ws-1", name: "Agent 1" },
    })
  })

  test("a linked git worktree resolves to its main worktree and keeps itself as the directory", async () => {
    const main = join(root, "shop")
    await mkdir(main)
    git(main, "init", "-q")
    git(main, "commit", "-q", "--allow-empty", "-m", "init")
    const worktree = join(root, "agent-worktree")
    git(main, "worktree", "add", "-q", "-b", "agent", worktree)

    expect(await resolveCloudScope(worktree)).toEqual({ projectPath: main, directory: worktree })
    expect(await resolveCloudScope(main)).toEqual({ projectPath: main, directory: main })
  })

  test("a folder outside git is its own scope", async () => {
    expect(await resolveCloudScope(root)).toEqual({ projectPath: root, directory: root })
  })

  test("a workspace that shares the main checkout is not treated as isolated", async () => {
    const scope = await resolveCloudScope(root, [{ id: "ws", name: "Shared", sourcePath: root, isolatedPath: root }])
    expect(scope).toEqual({ projectPath: root, directory: root })
  })
})
