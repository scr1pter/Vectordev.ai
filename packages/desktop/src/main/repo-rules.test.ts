import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let userDataPath = ""
const store = new Map<string, Map<string, unknown>>()
const electronMock = { app: { getPath: () => userDataPath } }
mock.module("electron", () => ({ default: electronMock, ...electronMock }))
mock.module("./store", () => ({
  getStore: (name = "default") => {
    if (!store.has(name)) store.set(name, new Map())
    const bucket = store.get(name)!
    return {
      get: (key: string) => bucket.get(key),
      set: (key: string, value: unknown) => bucket.set(key, value),
      delete: (key: string) => bucket.delete(key),
      path: join(userDataPath, `${name}.json`),
    }
  },
  removeStoreFileIfEmpty: () => undefined,
}))

const { globalRulesFilePath, listRepoRules, rulesFilePath, saveRepoRule } = await import("./repo-rules")

const originalConfig = process.env.OPENCODE_CONFIG_DIR
const originalXdg = process.env.XDG_CONFIG_HOME
const originalNamespace = process.env.VECTOR_APP_NAMESPACE

describe("repository rule persistence", () => {
  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), "vector-rules-"))
    store.clear()
    delete process.env.OPENCODE_CONFIG_DIR
    process.env.XDG_CONFIG_HOME = join(userDataPath, "config")
    process.env.VECTOR_APP_NAMESPACE = "vector-test"
  })

  afterEach(async () => {
    if (originalConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR
    if (originalConfig !== undefined) process.env.OPENCODE_CONFIG_DIR = originalConfig
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME
    if (originalXdg !== undefined) process.env.XDG_CONFIG_HOME = originalXdg
    if (originalNamespace === undefined) delete process.env.VECTOR_APP_NAMESPACE
    if (originalNamespace !== undefined) process.env.VECTOR_APP_NAMESPACE = originalNamespace
    await rm(userDataPath, { recursive: true, force: true })
  })

  test("global rules sync to the same config directory the engine loads", async () => {
    await saveRepoRule({ description: "Run focused tests", repositoryPath: "", filePatterns: [] })

    expect(globalRulesFilePath()).toBe(join(userDataPath, "config", "vector-test", "RULES.md"))
    expect(await readFile(globalRulesFilePath(), "utf8")).toContain("Run focused tests")
  })

  test("saving a project rule preserves teammate-authored Markdown", async () => {
    const repositoryPath = join(userDataPath, "project")
    await mkdir(join(repositoryPath, ".vector"), { recursive: true })
    await writeFile(rulesFilePath(repositoryPath), "# Team notes\n\nKeep this paragraph.\n", "utf8")

    await saveRepoRule({ description: "Use the service layer", repositoryPath, filePatterns: ["src/**"] })

    const content = await readFile(rulesFilePath(repositoryPath), "utf8")
    expect(content).toContain("Keep this paragraph.")
    expect(content).toContain("Use the service layer (applies to src/**)")
  })

  test("editing after disable and re-enable keeps one rule and its file", async () => {
    const repositoryPath = join(userDataPath, "project")
    const saved = await saveRepoRule({ description: "Use the service layer", repositoryPath, filePatterns: [] })

    await saveRepoRule({
      id: saved.id,
      description: saved.description,
      repositoryPath,
      filePatterns: [],
      enabled: false,
    })
    expect(await stat(rulesFilePath(repositoryPath)).catch(() => undefined)).toBeUndefined()

    await saveRepoRule({
      id: saved.id,
      description: saved.description,
      repositoryPath,
      filePatterns: [],
      enabled: true,
    })
    const edited = await saveRepoRule({
      id: saved.id,
      description: "Use the updated service boundary",
      repositoryPath,
      filePatterns: [],
    })

    expect(edited.enabled).toBe(true)
    expect(listRepoRules(repositoryPath)).toEqual([edited])
    expect(await readFile(rulesFilePath(repositoryPath), "utf8")).toContain("Use the updated service boundary")
  })

  test("a failed move restores the old rules file and store record", async () => {
    const repositoryPath = join(userDataPath, "project")
    const blockedPath = join(userDataPath, "not-a-directory")
    await mkdir(repositoryPath, { recursive: true })
    await writeFile(blockedPath, "blocked", "utf8")
    const saved = await saveRepoRule({ description: "Keep transactions atomic", repositoryPath, filePatterns: [] })
    const before = await readFile(rulesFilePath(repositoryPath), "utf8")

    await expect(
      saveRepoRule({
        id: saved.id,
        description: saved.description,
        repositoryPath: blockedPath,
        filePatterns: [],
      }),
    ).rejects.toThrow()

    expect(await readFile(rulesFilePath(repositoryPath), "utf8")).toBe(before)
    expect(listRepoRules(repositoryPath).map((rule) => rule.id)).toEqual([saved.id])
    expect(await stat(rulesFilePath(blockedPath)).catch(() => undefined)).toBeUndefined()
  })

  test("an unreadable existing rules path is never treated as an empty file", async () => {
    const repositoryPath = join(userDataPath, "project")
    await mkdir(rulesFilePath(repositoryPath), { recursive: true })

    await expect(
      saveRepoRule({ description: "Must not overwrite", repositoryPath, filePatterns: [] }),
    ).rejects.toThrow()

    expect((await stat(rulesFilePath(repositoryPath))).isDirectory()).toBe(true)
    expect(listRepoRules(repositoryPath)).toEqual([])
  })
})
