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

  test("placeholder prose cannot hide a real credential elsewhere on the line", async () => {
    const root = await mkdtemp(join(tmpdir(), "vector-secret-"))
    roots.push(root)
    const source = join(root, "source")
    const isolated = join(root, "isolated")
    await Promise.all([mkdir(source), mkdir(isolated)])
    await writeFile(join(source, "config.ts"), "")
    await writeFile(
      join(isolated, "config.ts"),
      'export const example = "documentation"; export const token = "ghp_abcdefghijklmnopqrstuvwxyz123456"\n',
    )
    expect(await scanChangedSecrets(source, isolated, ["config.ts"])).toEqual([
      { file: "config.ts", line: 1, kind: "GitHub token" },
    ])
  })

  test("placeholder-looking text inside a credential cannot bypass the scanner", async () => {
    const root = await mkdtemp(join(tmpdir(), "vector-secret-"))
    roots.push(root)
    const source = join(root, "source")
    const isolated = join(root, "isolated")
    await Promise.all([mkdir(source), mkdir(isolated)])
    await writeFile(join(source, "config.ts"), "")
    await writeFile(join(isolated, "config.ts"), 'export const token = "ghp_aaaaaaaaaaexamplebbbbbbbbbb"\n')
    expect(await scanChangedSecrets(source, isolated, ["config.ts"])).toEqual([
      { file: "config.ts", line: 1, kind: "GitHub token" },
    ])
  })

  test("only a Supabase anonymous client JWT is treated as public", async () => {
    const root = await mkdtemp(join(tmpdir(), "vector-secret-"))
    roots.push(root)
    const source = join(root, "source")
    const isolated = join(root, "isolated")
    await Promise.all([mkdir(source), mkdir(isolated)])
    const jwt = (payload: object) =>
      `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${"s".repeat(32)}`
    await writeFile(join(source, "config.ts"), "")
    await writeFile(
      join(isolated, "config.ts"),
      [
        `export const forged = "${jwt({ role: "authenticated" })}"`,
        `export const unrelated = "${jwt({ iss: "other", ref: "project", role: "anon" })}"`,
        `export const publicAnon = "${jwt({ iss: "supabase", ref: "project", role: "anon" })}"`,
      ].join("\n"),
    )
    expect(await scanChangedSecrets(source, isolated, ["config.ts"])).toEqual([
      { file: "config.ts", line: 1, kind: "JWT" },
      { file: "config.ts", line: 2, kind: "JWT" },
    ])
  })

  test("scans deployable project files while skipping environment files and dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "vector-secret-"))
    roots.push(root)
    await mkdir(join(root, "src"), { recursive: true })
    await mkdir(join(root, "node_modules", "package"), { recursive: true })
    await Promise.all([
      writeFile(join(root, "src", "config.ts"), 'export const key = "sk_test_abcdefghijklmnopqrstuvwxyz"\n'),
      writeFile(join(root, ".env"), "SECRET=ghp_abcdefghijklmnopqrstuvwxyz123456\n"),
      writeFile(
        join(root, "node_modules", "package", "fixture.ts"),
        'const key = "ghp_abcdefghijklmnopqrstuvwxyz123456"\n',
      ),
    ])
    expect(await scanProjectSecrets(root)).toEqual([{ file: "src/config.ts", line: 1, kind: "Stripe secret" }])
  })

  test("fails closed and reports when the project file limit truncates the scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "vector-secret-"))
    roots.push(root)
    await Promise.all(
      Array.from({ length: 2_001 }, (_, index) =>
        writeFile(join(root, `${String(index).padStart(4, "0")}.txt`), "safe\n"),
      ),
    )
    expect(await scanProjectSecrets(root)).toContainEqual({
      file: ".",
      line: 0,
      kind: "secret scan incomplete: more than 2,000 files",
    })
  })

  test("fails closed when a source file is too large to scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "vector-secret-"))
    roots.push(root)
    await writeFile(join(root, "large.ts"), "x".repeat(2 * 1024 * 1024 + 1))
    expect(await scanProjectSecrets(root)).toContainEqual({
      file: "large.ts",
      line: 0,
      kind: "secret scan incomplete: file exceeds 2 MB",
    })
  })

  test("does not treat a large binary asset as unscanned source text", async () => {
    const root = await mkdtemp(join(tmpdir(), "vector-secret-"))
    roots.push(root)
    const image = Buffer.alloc(2 * 1024 * 1024 + 1)
    image.set(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    await writeFile(join(root, "hero.png"), image)

    expect(await scanProjectSecrets(root)).toEqual([])
  })

  test("fails closed when a project directory cannot be enumerated", async () => {
    const root = await mkdtemp(join(tmpdir(), "vector-secret-"))
    roots.push(root)
    const notDirectory = join(root, "project.txt")
    await writeFile(notDirectory, "safe")

    expect(await scanProjectSecrets(notDirectory)).toEqual([
      { file: ".", line: 0, kind: "secret scan incomplete: directory could not be read" },
    ])
  })

  test("fails closed when changed-file metadata cannot be read", async () => {
    const root = await mkdtemp(join(tmpdir(), "vector-secret-"))
    roots.push(root)
    const source = join(root, "source")
    const isolated = join(root, "isolated.txt")
    await mkdir(source)
    await writeFile(isolated, "not a directory")

    expect(await scanChangedSecrets(source, isolated, ["config.ts"])).toEqual([
      { file: "config.ts", line: 0, kind: "secret scan incomplete: file metadata could not be read" },
    ])
  })
})
