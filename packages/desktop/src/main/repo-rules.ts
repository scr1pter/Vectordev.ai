import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { FSUtil } from "@vectordevai/core/fs-util"
import { vectorConfigDir } from "./config-path"
import { getStore } from "./store"
import {
  managesRule,
  mergeRulesFile,
  reconcileRules,
  rulesForRepository,
  selectRules,
  type RepoRule,
} from "./repo-rules-model"

const STORE_NAME = "repo-rules-state"
const STORE_KEY = "rules"

// The engine already loads this path as an instruction file for every prompt in
// the project (packages/engine/src/session/instruction.ts). Writing a real
// file in the repository rather than hiding rules in application data is the
// point: a standard the team agreed on is reviewable, diffable, and travels
// with the clone.
export const RULES_FILE_RELATIVE = join(".vector", "RULES.md")

export function rulesFilePath(repositoryPath: string) {
  return join(repositoryPath, RULES_FILE_RELATIVE)
}

export function globalRulesFilePath() {
  return join(vectorConfigDir(), "RULES.md")
}

// The saved list as the rules files say it is now: a line someone deleted from Vector's block, or the whole file, takes
// that rule away, and a line they added or edited there is a rule. The saved list alone would keep handing deleted
// rules to Claude Code, Codex and Cursor and write them back into the file on the next save. Pass the repositories a
// caller is about to read or write so their files count even when nothing is saved for them yet.
function readAll(...repositoryPaths: string[]): RepoRule[] {
  const stored = readStored()
  const targets = new Set(
    [...stored.filter((rule) => rule.enabled).map((rule) => rule.repositoryPath), ...repositoryPaths].map((path) =>
      path.replace(/[\\/]+$/, ""),
    ),
  )
  return [...targets].reduce((rules, target) => {
    const content = readRulesFileForReconcile(target)
    return content === undefined ? rules : reconcileRules(rules, target, content)
  }, stored)
}

function readStored(): RepoRule[] {
  const raw = getStore(STORE_NAME).get(STORE_KEY)
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is RepoRule => Boolean(item) && typeof item === "object" && "id" in item)
}

// Synchronous because the agent prompt is built synchronously; these files are a few lines each. A missing file reads
// as empty. A file that cannot be read for any other reason leaves its rules as saved: reading must not drop rules on
// a permissions error, and saving to that file still fails loudly in syncRulesFile.
function readRulesFileForReconcile(repositoryPath: string) {
  const target = repositoryPath ? rulesFilePath(repositoryPath) : globalRulesFilePath()
  // A repository can carry RULES.md as a link to a file of the user's; its contents must not reach agent prompts. The
  // saved rules stay as they are, as they do for any file that cannot be read.
  if (repositoryPath && existsSync(target) && !FSUtil.writableInside(repositoryPath, target)) return undefined
  try {
    return readFileSync(target, "utf8")
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "" : undefined
  }
}

function writeAll(rules: RepoRule[]) {
  getStore(STORE_NAME).set(STORE_KEY, rules)
}

export function listRepoRules(repositoryPath?: string): RepoRule[] {
  if (!repositoryPath) return readAll()
  const all = readAll(repositoryPath, "")
  // rulesForRepository, not selectRules: selectRules is the prompt filter and
  // drops disabled rules, which would make a disabled rule impossible to find
  // and re-enable from the panel that manages it.
  return rulesForRepository(all, repositoryPath)
}

export type SaveRepoRuleInput = {
  id?: string
  description: string
  repositoryPath: string
  filePatterns: string[]
  enabled?: boolean
}

export async function saveRepoRule(input: SaveRepoRuleInput) {
  const description = input.description.trim()
  if (!description) throw new Error("Write what the rule is before saving it.")
  const now = new Date().toISOString()
  const all = readAll(input.repositoryPath.trim())
  const existing = input.id ? all.find((rule) => rule.id === input.id) : undefined
  const patterns = input.filePatterns.map((pattern) => pattern.trim()).filter(Boolean)
  const saved: RepoRule = {
    id: existing?.id ?? randomUUID(),
    description,
    repositoryPath: input.repositoryPath.trim(),
    filePatterns: patterns,
    enabled: input.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  const next = existing ? all.map((rule) => (rule.id === saved.id ? saved : rule)) : [...all, saved]
  // A rule that moved between repositories has to leave the file it used to be
  // written into, or the old repository keeps enforcing it.
  await commitRules(next, all, [existing?.repositoryPath, saved.repositoryPath])
  return saved
}

export async function deleteRepoRule(id: string) {
  const all = readAll()
  const removed = all.find((rule) => rule.id === id)
  if (!removed) return listRepoRules()
  await commitRules(
    all.filter((rule) => rule.id !== id),
    all,
    [removed.repositoryPath],
  )
  return listRepoRules()
}

// Rewrites only Vector's managed block in the instruction file. Removing the
// last managed rule deletes an otherwise empty file but preserves any Markdown
// a teammate authored outside that block.
export async function syncRulesFile(repositoryPath: string, rules = readAll(), previousRules = rules) {
  const target = repositoryPath ? rulesFilePath(repositoryPath) : globalRulesFilePath()
  // A repository can carry its .vector, or RULES.md, as a link to any file of the user's, and writing follows it.
  if (repositoryPath && !FSUtil.writableInside(repositoryPath, target))
    throw new Error(`Cannot save rules to ${target}: it is a link, not a plain file, or outside ${repositoryPath}.`)
  const body = mergeRulesFile(
    (await readOptionalFile(target, "utf8")) ?? "",
    rules.filter((rule) => managesRule(rule, repositoryPath)),
    previousRules.filter((rule) => managesRule(rule, repositoryPath)),
    repositoryPath ? "Repository rules" : "Global rules",
  )
  if (!body.trim()) {
    await rm(target, { force: true })
    return
  }
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, body, "utf8")
  await rename(temporary, target).catch(async (error) => {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  })
}

async function commitRules(next: RepoRule[], previous: RepoRule[], repositoryPaths: (string | undefined)[]) {
  const paths = [...new Set(repositoryPaths.filter((path): path is string => path !== undefined))]
  const targets = paths.map((path) => (path ? rulesFilePath(path) : globalRulesFilePath()))
  const snapshots = await Promise.all(targets.map((target) => readOptionalFile(target)))
  try {
    for (const path of paths) await syncRulesFile(path, next, previous)
    writeAll(next)
  } catch (error) {
    await Promise.all(
      targets.map(async (target, index) => {
        if (paths[index] && !FSUtil.writableInside(paths[index], target)) return
        const snapshot = snapshots[index]
        if (!snapshot) return rm(target, { force: true }).catch(() => undefined)
        await mkdir(dirname(target), { recursive: true }).catch(() => undefined)
        return writeFile(target, snapshot).catch(() => undefined)
      }),
    )
    throw error
  }
}

function readOptionalFile(path: string): Promise<Buffer | undefined>
function readOptionalFile(path: string, encoding: "utf8"): Promise<string | undefined>
function readOptionalFile(path: string, encoding?: "utf8"): Promise<Buffer | string | undefined> {
  const content = encoding === "utf8" ? readFile(path, encoding) : readFile(path)
  return content.catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
}

// The rules that should ride along with an agent prompt. Kept separate from the
// file above because a prompt can be scoped to the files a run will touch,
// while an instruction file is always loaded whole.
export function repoRulesForPrompt(repositoryPath: string, files?: readonly string[]) {
  return selectRules(readAll(repositoryPath, ""), { repositoryPath, files })
}
