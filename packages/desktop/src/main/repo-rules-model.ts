import { createHash } from "node:crypto"

// Per-repository rules the user writes in plain English — "we don't put
// database query logic in the controller" — scoped to a repository and
// optionally to file patterns inside it. Pure so matching and prompt
// composition can be tested without electron or a store.

export type RepoRule = {
  id: string
  description: string
  // Absolute path of the repository this applies to. Empty means every repository,
  // which is how a personal standard is expressed without repeating it.
  repositoryPath: string
  // Globs the rule is scoped to. Empty means the whole repository.
  filePatterns: string[]
  enabled: boolean
  createdAt: string
  updatedAt: string
}

// A rule reaches the agent as text, so the file scope has to survive as text
// too: instruction files are loaded whole, and nothing downstream re-reads a
// glob. Naming the scope in the sentence is what keeps it meaningful.
const RULES_HEADING = "[vector:rules]"

function escapeForRegExp(value: string) {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&")
}

// A deliberately small glob dialect: `**` crosses directories, `*` does not, and
// `?` is a single character. Electron's main process runs Node, not Bun, so
// Bun.Glob is unavailable here and a matcher has to exist rather than be
// borrowed.
export function globToRegExp(pattern: string) {
  const source = escapeForRegExp(pattern)
    .replace(/\*\*\//g, "__VECTOR_GLOB_SLASH__")
    .replace(/\*\*/g, "__VECTOR_GLOB_ANY__")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/__VECTOR_GLOB_SLASH__/g, "(?:.*/)?")
    .replace(/__VECTOR_GLOB_ANY__/g, ".*")
  return new RegExp(`^${source}$`)
}

export function matchesPattern(pattern: string, filePath: string) {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "")
  // A bare directory name should cover everything under it, which is what a
  // user means by "src" and never "the file literally called src".
  if (!/[*?]/.test(pattern) && !pattern.includes(".")) {
    const prefix = pattern.replace(/\/$/, "")
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return true
  }
  return globToRegExp(pattern.replace(/^\.\//, "")).test(normalized)
}

function appliesToRepository(rule: RepoRule, repositoryPath: string) {
  if (!rule.repositoryPath) return true
  const rulePath = rule.repositoryPath.replace(/[\\/]+$/, "")
  const target = repositoryPath.replace(/[\\/]+$/, "")
  return rulePath === target
}

// Everything that governs one repository: the rules written for it, plus the
// global rules that apply everywhere. Unlike selectRules this keeps DISABLED
// rules, because this is what the management panel lists — a disabled rule has
// to stay on screen or there is no way to switch it back on.
export function rulesForRepository(rules: readonly RepoRule[], repositoryPath: string): RepoRule[] {
  return rules.filter((rule) => appliesToRepository(rule, repositoryPath))
}

// `files` is what the agent is about to touch when that is known. When it is
// not, every scoped rule still applies: dropping them because no file list
// exists yet would silently disable most of what the user wrote.
export function selectRules(
  rules: readonly RepoRule[],
  input: { repositoryPath: string; files?: readonly string[] },
): RepoRule[] {
  return rules.filter((rule) => {
    if (!rule.enabled) return false
    if (!appliesToRepository(rule, input.repositoryPath)) return false
    if (!rule.filePatterns.length) return true
    if (!input.files?.length) return true
    return input.files.some((file) => rule.filePatterns.some((pattern) => matchesPattern(pattern, file)))
  })
}

function scopeSentence(rule: Pick<RepoRule, "filePatterns">) {
  if (!rule.filePatterns.length) return ""
  return ` (applies to ${rule.filePatterns.join(", ")})`
}

// A rule's bullet in the managed block, on one line so it reads back as the same rule after a round trip.
function ruleLine(rule: Pick<RepoRule, "description" | "filePatterns">) {
  return `${rule.description.replace(/\s+/g, " ").trim()}${scopeSentence(rule)}`
}

export function formatRulesForPrompt(rules: readonly RepoRule[]) {
  if (!rules.length) return ""
  return [
    RULES_HEADING,
    "Standards this team has written for this repository. Follow them for every change you make here. If one of them conflicts with what you were asked to do, say so rather than silently picking a side.",
    "",
    ...rules.map((rule, index) => `${index + 1}. ${rule.description.trim()}${scopeSentence(rule)}`),
  ].join("\n")
}

// The repository-local file the engine loads as an instruction file. Written by
// Vector, but a plain committed file on purpose: rules a team agrees on belong
// in the repository where the team can review and change them, not in one
// developer's application data.
const MANAGED_START = "<!-- vector:managed-rules:start -->"
const MANAGED_END = "<!-- vector:managed-rules:end -->"

export function formatRulesFile(rules: readonly RepoRule[], title = "Repository rules") {
  if (!rules.length) return ""
  return [
    MANAGED_START,
    `# ${title}`,
    "",
    "<!-- Managed by Vector: Vectorscope's Don't flag this again adds rules here. Each line starting with - is a rule: delete the line to remove the rule, or edit it to change the rule. Vector rewrites everything else in this section, so keep notes of your own outside the markers. -->",
    "",
    ...rules.map((rule) => `- ${ruleLine(rule)}`),
    "",
    MANAGED_END,
    "",
  ].join("\n")
}

function legacyRulesFile(rules: readonly RepoRule[], title: string) {
  if (!rules.length) return ""
  return [
    `# ${title}`,
    "",
    "<!-- Managed by Vector. Edit these in Vector under Rules, or edit this file directly. -->",
    "",
    ...rules.map((rule) => `- ${rule.description.trim()}${scopeSentence(rule)}`),
    "",
  ].join("\n")
}

// Replace only Vector's marked block. A teammate may keep ordinary Markdown in
// the same file; saving a rule in the UI must not erase those committed edits.
// The third argument lets the first marker-based save migrate an untouched
// legacy generated file without duplicating its previous managed bullets.
export function mergeRulesFile(
  existing: string,
  rules: readonly RepoRule[],
  previousRules: readonly RepoRule[] = rules,
  title = "Repository rules",
) {
  const managed = formatRulesFile(rules, title).trim()
  const range = managedRange(existing)
  if (range) {
    const before = existing.slice(0, range.start).trimEnd()
    const after = existing.slice(range.end + MANAGED_END.length).trimStart()
    return [before, managed, after].filter(Boolean).join("\n\n") + ([before, managed, after].some(Boolean) ? "\n" : "")
  }
  if (isLegacyRulesFile(existing, previousRules, title)) return managed ? `${managed}\n` : ""
  if (!managed) return existing
  return existing.trim() ? `${existing.trimEnd()}\n\n${managed}\n` : `${managed}\n`
}

// The rules one file holds: a repository's .vector/RULES.md, or the global file when repositoryPath is empty.
export function managesRule(rule: RepoRule, repositoryPath: string) {
  return rule.enabled && rule.repositoryPath.replace(/[\\/]+$/, "") === repositoryPath.replace(/[\\/]+$/, "")
}

// Vector has no page for these rules, so the managed block in the file is where people change them, and it wins over
// the saved list. A rule whose line was deleted is dropped and a line someone added or rewrote becomes a rule, so a
// hand edit survives the next save and reaches Claude Code, Codex and Cursor, which get rules from Vector rather than
// from the file. A missing file, or one without the block, holds no managed rules, except an untouched file from
// before the markers, which the next save migrates. Disabled rules are never in the file, so they are left alone.
export function reconcileRules(
  rules: readonly RepoRule[],
  repositoryPath: string,
  existing: string,
  now = new Date().toISOString(),
): RepoRule[] {
  const title = repositoryPath ? "Repository rules" : "Global rules"
  const managed = rules.filter((rule) => managesRule(rule, repositoryPath))
  if (existing.trim() && isLegacyRulesFile(existing, managed, title)) return [...rules]
  const unclaimed = [...managed]
  const kept = managedLines(existing).map((line, position) => {
    const index = unclaimed.findIndex((rule) => ruleLine(rule) === line)
    if (index >= 0) return unclaimed.splice(index, 1)[0]
    return ruleFromLine(line, position, repositoryPath.replace(/[\\/]+$/, ""), now)
  })
  return [...rules.filter((rule) => !managesRule(rule, repositoryPath)), ...kept]
}

function managedRange(existing: string) {
  const start = existing.indexOf(MANAGED_START)
  const end = existing.indexOf(MANAGED_END, Math.max(0, start))
  if (start < 0 || end < start) return undefined
  return { start, end }
}

// Files from before the markers were titled "Project rules"; match that exact text so they migrate, not duplicate.
function isLegacyRulesFile(existing: string, rules: readonly RepoRule[], title: string) {
  return existing.trim() === legacyRulesFile(rules, title === "Repository rules" ? "Project rules" : title).trim()
}

// Only bullets are rules; the heading and the comment inside the block are Vector's own.
function managedLines(existing: string) {
  const range = managedRange(existing)
  if (!range) return []
  return existing
    .slice(range.start + MANAGED_START.length, range.end)
    .split(/\r?\n/)
    .flatMap((line) => {
      const text = /^\s*[-*+]\s+(.*)$/.exec(line)?.[1]?.replace(/\s+/g, " ").trim()
      return text ? [text] : []
    })
}

// A line someone wrote by hand. Its scope reads back from the "(applies to ...)" Vector writes after each rule. The id
// comes from the line, so it stays the same on every read until a save stores the rule.
function ruleFromLine(line: string, position: number, repositoryPath: string, now: string): RepoRule {
  const scoped = /^(.*\S) \(applies to (.+)\)$/.exec(line)
  return {
    id: `file-${createHash("sha256").update(`${repositoryPath}\n${position}\n${line}`).digest("hex").slice(0, 32)}`,
    description: scoped?.[1] ?? line,
    repositoryPath,
    filePatterns: scoped?.[2].split(", ").flatMap((pattern) => (pattern.trim() ? [pattern.trim()] : [])) ?? [],
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }
}
