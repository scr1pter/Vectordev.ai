import { randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getStore } from "./store"
import { formatRulesFile, selectRules, type RepoRule } from "./repo-rules-model"

const STORE_NAME = "repo-rules-state"
const STORE_KEY = "rules"

// The engine already loads this path as an instruction file for every prompt in
// the project (packages/opencode/src/session/instruction.ts). Writing a real
// file in the repository rather than hiding rules in application data is the
// point: a standard the team agreed on is reviewable, diffable, and travels
// with the clone.
export const RULES_FILE_RELATIVE = join(".vector", "RULES.md")

export function rulesFilePath(repositoryPath: string) {
  return join(repositoryPath, RULES_FILE_RELATIVE)
}

function readAll(): RepoRule[] {
  const raw = getStore(STORE_NAME).get(STORE_KEY)
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is RepoRule => Boolean(item) && typeof item === "object" && "id" in item)
}

function writeAll(rules: RepoRule[]) {
  getStore(STORE_NAME).set(STORE_KEY, rules)
}

export function listRepoRules(repositoryPath?: string): RepoRule[] {
  const all = readAll()
  if (!repositoryPath) return all
  return selectRules(all, { repositoryPath })
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
  const all = readAll()
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
  writeAll(existing ? all.map((rule) => (rule.id === saved.id ? saved : rule)) : [...all, saved])
  // A rule that moved between repositories has to leave the file it used to be
  // written into, or the old repository keeps enforcing it.
  if (existing && existing.repositoryPath !== saved.repositoryPath) await syncRulesFile(existing.repositoryPath)
  await syncRulesFile(saved.repositoryPath)
  return saved
}

export async function deleteRepoRule(id: string) {
  const all = readAll()
  const removed = all.find((rule) => rule.id === id)
  if (!removed) return listRepoRules()
  writeAll(all.filter((rule) => rule.id !== id))
  await syncRulesFile(removed.repositoryPath)
  return listRepoRules()
}

// Rewrites the repository's rules file from the store. An empty rule set deletes
// the file rather than leaving an empty heading behind, so a project the user
// cleared out stops carrying a Vector artifact around.
export async function syncRulesFile(repositoryPath: string) {
  if (!repositoryPath) return
  const target = rulesFilePath(repositoryPath)
  const body = formatRulesFile(selectRules(readAll(), { repositoryPath }))
  if (!body) {
    await rm(target, { force: true }).catch(() => undefined)
    return
  }
  await mkdir(dirname(target), { recursive: true }).catch(() => undefined)
  await writeFile(target, body, "utf8")
}

// The rules that should ride along with an agent prompt. Kept separate from the
// file above because a prompt can be scoped to the files a run will touch,
// while an instruction file is always loaded whole.
export function repoRulesForPrompt(repositoryPath: string, files?: readonly string[]) {
  return selectRules(readAll(), { repositoryPath, files })
}
