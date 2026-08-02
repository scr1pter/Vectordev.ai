import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scanChangedSecrets, scanProjectSecrets } from "./secret-scanner"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("workspace secret scanner", () => {
  test("reports newly introduced credentials without revealing their value", async () => {
    const root = await mkdtemp(join(tmpdir(), "vector-secret-"))
    roots.push(root)
    const source = join(root, "source")
    const isolated = join(root, "isolated")
    await Promise.all([mkdir(source), mkdir(isolated)])
    await writeFile(join(source, "config.ts"), 'export const mode = "dev"\n')
    await writeFile(join(isolated, "config.ts"), 'export const key = "ghp_abcdefghijklmnopqrstuvwxyz123456"\n')
    expect(await scanChangedSecrets(source, isolated, ["config.ts"])).toEqual([
      { file: "config.ts", line: 1, kind: "GitHub token" },
    ])
  })

  test("does not block unchanged credentials or documented placeholders", async () => {
    const root = await mkdtemp(join(tmpdir(), "vector-secret-"))
    roots.push(root)
    const source = join(root, "source")
    const isolated = join(root, "isolated")
    await Promise.all([mkdir(source), mkdir(isolated)])
    const existing = 'export const key = "sk-abcdefghijklmnopqrstuvwxyz123456"\n'
    await Promise.all([
      writeFile(join(source, "config.ts"), existing),
      writeFile(join(isolated, "config.ts"), `${existing}export const sample = "sk-your-key-here"\n`),
    ])
    expect(await scanChangedSecrets(source, isolated, ["config.ts"])).toEqual([])
  })

  test("scans deployable project files while skipping environment files and dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "vector-secret-"))
    roots.push(root)
    await mkdir(join(root, "src"), { recursive: true })
    await mkdir(join(root, "node_modules", "package"), { recursive: true })
    await Promise.all([
      writeFile(join(root, "src", "config.ts"), 'export const key = "sk_test_abcdefghijklmnopqrstuvwxyz"\n'),
      writeFile(join(root, ".env"), "SECRET=ghp_abcdefghijklmnopqrstuvwxyz123456\n"),
      writeFile(join(root, "node_modules", "package", "fixture.ts"), 'const key = "ghp_abcdefghijklmnopqrstuvwxyz123456"\n'),
    ])
    expect(await scanProjectSecrets(root)).toEqual([
      { file: "src/config.ts", line: 1, kind: "Stripe secret" },
    ])
  })
})
