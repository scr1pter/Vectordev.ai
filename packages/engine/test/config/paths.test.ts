import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ConfigPaths } from "../../src/config/paths"
import { tmpdir } from "../fixture/fixture"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"

test("config project containment excludes the root sentinel and keeps missing-path boundaries", async () => {
  await using project = await tmpdir()
  await using outside = await tmpdir()
  const ctx = { directory: project.path, worktree: "/" }
  expect(ConfigPaths.projectPath(path.join(project.path, "missing.json"), ctx)).toBe(
    path.join(project.path, "missing.json"),
  )
  expect(ConfigPaths.projectContains(path.join(outside.path, "missing.json"), ctx)).toBe(false)
  expect(ConfigPaths.projectContains(`${project.path}-sibling/vector.json`, ctx)).toBe(false)
})

test("config files and directories reached through external aliases use their project identity", async () => {
  await using project = await tmpdir()
  await using outside = await tmpdir()
  await Bun.write(path.join(project.path, "vector.json"), "{}")
  const alias = path.join(outside.path, "alias")
  await fs.symlink(project.path, alias, process.platform === "win32" ? "junction" : "dir")
  const ctx = { directory: project.path, worktree: "/" }
  expect(ConfigPaths.projectPath(alias, ctx)).toBe(project.path)
  expect(ConfigPaths.projectPath(path.join(alias, "vector.json"), ctx)).toBe(path.join(project.path, "vector.json"))
})

test("lexical project config identity stays local when a directory link points outside", async () => {
  await using project = await tmpdir()
  await using outside = await tmpdir()
  await Bun.write(path.join(outside.path, "vector.json"), "{}")
  const alias = path.join(project.path, "alias")
  await fs.symlink(outside.path, alias, process.platform === "win32" ? "junction" : "dir")
  const ctx = { directory: project.path, worktree: "/" }
  expect(ConfigPaths.projectPath(alias, ctx)).toBe(alias)
  expect(ConfigPaths.projectPath(path.join(alias, "vector.json"), ctx)).toBe(path.join(alias, "vector.json"))
  expect(ConfigPaths.projectPath(path.join(outside.path, "vector.json"), ctx)).toBeUndefined()
})

test("config identities round-trip through a snapshot whose workspace uses an alias", async () => {
  await using project = await tmpdir()
  await using outside = await tmpdir()
  const file = path.join(project.path, "vector.json")
  await Bun.write(file, '{"permission":{"bash":"deny"}}')
  const alias = path.join(outside.path, "workspace-link")
  await fs.symlink(project.path, alias, process.platform === "win32" ? "junction" : "dir")
  const source = ConfigPaths.projectPath(file, { directory: alias, worktree: alias })
  expect(source).toBe(path.join(alias, "vector.json"))
  if (!source) throw new Error("Expected a project config source")
  const snapshot = await WorkspaceTrust.snapshot(alias, [source])
  expect(WorkspaceTrust.readFileString(snapshot, source)).toBe('{"permission":{"bash":"deny"}}')
  const trusted = await WorkspaceTrust.materialize(path.join(outside.path, "state"), snapshot)
  expect(await Bun.file(WorkspaceTrust.materializedPath(trusted, source)).json()).toEqual({ permission: { bash: "deny" } })
})
