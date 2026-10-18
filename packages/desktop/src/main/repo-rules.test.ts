import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let userDataPath = ""
const store = new Map<string, Map<string, unknown>>()
// Bun keeps a module mock for the rest of the run, so it carries every export a later test file's imports bind.
const electronMock = {
  app: { getPath: () => userDataPath },
  shell: { openExternal: async () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}
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

const { deleteRepoRule, globalRulesFilePath, listRepoRules, repoRulesForPrompt, rulesFilePath, saveRepoRule } =
  await import("./repo-rules")

const originalConfig = process.env.VECTOR_AGENT_CONFIG_DIR
const originalXdg = process.env.XDG_CONFIG_HOME
const originalNamespace = process.env.VECTOR_APP_NAMESPACE

describe("repository rule persistence", () => {
  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), "vector-rules-"))
    store.clear()
    delete process.env.VECTOR_AGENT_CONFIG_DIR
    process.env.XDG_CONFIG_HOME = join(userDataPath, "config")
    process.env.VECTOR_APP_NAMESPACE = "vector-test"
  })

  afterEach(async () => {
    if (originalConfig === undefined) delete process.env.VECTOR_AGENT_CONFIG_DIR
    if (originalConfig !== undefined) process.env.VECTOR_AGENT_CONFIG_DIR = originalConfig
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

  test("never reads a linked RULES.md into agent prompts", async () => {
    const repositoryPath = join(userDataPath, "project")
    const outside = join(userDataPath, "outside.md")
    await saveRepoRule({ description: "Use the service layer", repositoryPath, filePatterns: [] })
    const file = rulesFilePath(repositoryPath)
    await writeFile(
      outside,
      (await readFile(file, "utf8")).replace("Use the service layer", "Text from a file outside the repository"),
      "utf8",
    )
    await rm(file)
    await symlink(outside, file)

    expect(repoRulesForPrompt(repositoryPath).map((rule) => rule.description)).toEqual(["Use the service layer"])
  })

  test("never saves project rules through a repository's links", async () => {
    const repositoryPath = join(userDataPath, "project")
    const outside = join(userDataPath, "outside")
    await mkdir(repositoryPath, { recursive: true })
    await mkdir(outside, { recursive: true })
    await symlink(outside, join(repositoryPath, ".vector"), process.platform === "win32" ? "junction" : "dir")

    await expect(
      saveRepoRule({ description: "Use the service layer", repositoryPath, filePatterns: [] }),
    ).rejects.toThrow("Cannot save rules")
    expect(await readdir(outside)).toEqual([])
    expect(listRepoRules(repositoryPath)).toEqual([])
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

  test("a rule deleted from RULES.md by hand stays deleted for every agent and after the next save", async () => {
    const repositoryPath = join(userDataPath, "project")
    const sql = 'Code review: do not flag "SQL injection" in src/db.ts; it was reviewed and is not a problem.'
    await saveRepoRule({ description: sql, repositoryPath, filePatterns: ["src/db.ts"] })
    const file = rulesFilePath(repositoryPath)
    await writeFile(file, (await readFile(file, "utf8")).replace(/^- Code review.*\n/m, ""), "utf8")

    // Claude Code, Codex and Cursor get rules from Vector, not the file, so the deletion has to reach them too.
    expect(repoRulesForPrompt(repositoryPath)).toEqual([])
    await saveRepoRule({ description: "Rule B", repositoryPath, filePatterns: [] })

    const content = await readFile(file, "utf8")
    expect(content).not.toContain("SQL injection")
    expect(content).toContain("- Rule B")
    expect(listRepoRules(repositoryPath).map((rule) => rule.description)).toEqual(["Rule B"])
  })

  test("deleting RULES.md removes its rules instead of bringing them back", async () => {
    const repositoryPath = join(userDataPath, "project")
    await saveRepoRule({ description: "Old rule", repositoryPath, filePatterns: [] })
    await rm(rulesFilePath(repositoryPath))

    expect(repoRulesForPrompt(repositoryPath)).toEqual([])
    await saveRepoRule({ description: "New rule", repositoryPath, filePatterns: [] })
    expect(await readFile(rulesFilePath(repositoryPath), "utf8")).not.toContain("Old rule")
  })

  test("a rule edited or added inside the block by hand reaches every agent and survives the next save", async () => {
    const repositoryPath = join(userDataPath, "project")
    await saveRepoRule({ description: "Use the service layer", repositoryPath, filePatterns: ["src/**"] })
    const file = rulesFilePath(repositoryPath)
    const edited = (await readFile(file, "utf8"))
      .replace("Use the service layer", "Use the domain services")
      .replace("<!-- vector:managed-rules:end -->", "- Keep migrations reversible\n\n<!-- vector:managed-rules:end -->")
    await writeFile(file, edited, "utf8")

    expect(repoRulesForPrompt(repositoryPath).map((rule) => rule.description)).toEqual([
      "Use the domain services",
      "Keep migrations reversible",
    ])
    await saveRepoRule({ description: "Rule B", repositoryPath, filePatterns: [] })
    const content = await readFile(file, "utf8")
    expect(content).toContain("- Use the domain services (applies to src/**)")
    expect(content).toContain("- Keep migrations reversible")
    expect(content).not.toContain("Use the service layer")
  })

  test("removing a saved rule by id takes it out of the file, as Vectorscope's Undo does", async () => {
    const repositoryPath = join(userDataPath, "project")
    await saveRepoRule({ description: "Keep this", repositoryPath, filePatterns: [] })
    const saved = await saveRepoRule({ description: "Undo this", repositoryPath, filePatterns: ["src/a.ts"] })

    await deleteRepoRule(saved.id)

    const content = await readFile(rulesFilePath(repositoryPath), "utf8")
    expect(content).toContain("- Keep this")
    expect(content).not.toContain("Undo this")
    expect(repoRulesForPrompt(repositoryPath).map((rule) => rule.description)).toEqual(["Keep this"])
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
