import { createHash } from "node:crypto"
import { readFile, readdir, stat } from "node:fs/promises"
import { extname, join, normalize, relative, resolve } from "node:path"

import { getStore } from "./store"

const STORE_NAME = "context-budget-index"
const STORE_KEY = "projects"
const MAX_INDEXED_FILES = 20_000
const MAX_SOURCE_BYTES = 768 * 1024
const DEFAULT_TOKEN_BUDGET = 32_000
const DEFAULT_FILE_LIMIT = 48

export type TaskDifficulty = "trivial" | "simple" | "standard" | "complex"

export type AgentTaskPreparation = {
  difficulty: TaskDifficulty
  useQuickAgent: boolean
  recommendedVariant: "light" | "balanced" | "max"
  retryLimit: number
  context?: ContextBudgetPack
  instruction?: string
}

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".vercel",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
])

const SOURCE_EXTENSIONS = new Set([
  ".astro",
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".kts",
  ".md",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".vue",
  ".yaml",
  ".yml",
])

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "before",
  "build",
  "change",
  "code",
  "create",
  "feature",
  "file",
  "from",
  "have",
  "into",
  "make",
  "need",
  "please",
  "project",
  "should",
  "that",
  "this",
  "using",
  "want",
  "with",
])

export type ContextIndexFile = {
  path: string
  bytes: number
  modifiedAt: number
  estimatedTokens: number
  imports: string[]
  dependencies: string[]
  symbols: string[]
}

export type ContextProjectIndex = {
  root: string
  fingerprint: string
  generatedAt: string
  files: ContextIndexFile[]
}

export type ContextBudgetFile = {
  path: string
  reason: string
  score: number
  estimatedTokens: number
}

export type ContextBudgetPack = {
  root: string
  task: string
  generatedAt: string
  indexedFileCount: number
  selectedFileCount: number
  estimatedTokens: number
  tokenBudget: number
  files: ContextBudgetFile[]
  architectureSummary: string
}

type FileCandidate = {
  path: string
  bytes: number
  modifiedAt: number
}

type PersistedIndexes = Record<string, ContextProjectIndex>

const TRIVIAL_TASK = /^(?:hi|hey|hello|yo|sup|thanks|thank you|ok|okay|cool|nice|good morning|good afternoon|good evening)[!.?\s]*$/i
const COMPLEX_TERMS = [
  /\barchitecture\b/i,
  /\bmigrat(?:e|ion)\b/i,
  /\brefactor\b/i,
  /\bmulti[- ]?file\b/i,
  /\bcodebase\b/i,
  /\bend[- ]?to[- ]?end\b/i,
  /\bproduction[- ]?ready\b/i,
  /\bparallel\b/i,
  /\bperformance\b/i,
  /\bsecurity\b/i,
  /\b(?:build|implement|fix|test) (?:everything|all|the entire|the whole)\b/i,
]
const ACTION_TERMS = /\b(?:add|build|change|debug|delete|edit|fix|implement|improve|investigate|refactor|remove|rename|repair|test|update)\b/i

export function classifyTaskDifficulty(task: string): TaskDifficulty {
  const text = task.trim()
  if (!text || TRIVIAL_TASK.test(text)) return "trivial"

  const paths = explicitPaths(text)
  const complexSignals = COMPLEX_TERMS.filter((pattern) => pattern.test(text)).length
  if (text.length >= 900 || paths.size >= 4 || complexSignals >= 2) return "complex"
  if (complexSignals === 1 && (text.length >= 260 || ACTION_TERMS.test(text))) return "complex"
  if (ACTION_TERMS.test(text) || text.length >= 180 || paths.size >= 2) return "standard"
  return "simple"
}

export function contextBudgetForDifficulty(difficulty: TaskDifficulty) {
  if (difficulty === "trivial") return { tokenBudget: 0, fileLimit: 0 }
  if (difficulty === "simple") return { tokenBudget: 12_000, fileLimit: 18 }
  if (difficulty === "complex") return { tokenBudget: 96_000, fileLimit: 120 }
  return { tokenBudget: 36_000, fileLimit: 56 }
}

function slash(path: string) {
  return path.replaceAll("\\", "/")
}

function projectKey(root: string) {
  return createHash("sha256").update(resolve(root)).digest("hex").slice(0, 24)
}

function estimateTokens(textOrBytes: string | number) {
  const length = typeof textOrBytes === "number" ? textOrBytes : Buffer.byteLength(textOrBytes, "utf8")
  return Math.max(1, Math.ceil(length / 4))
}

async function listCandidates(root: string) {
  const output: FileCandidate[] = []
  const visit = async (current: string) => {
    if (output.length >= MAX_INDEXED_FILES) return
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (output.length >= MAX_INDEXED_FILES) break
      if (entry.name === ".DS_Store") continue
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await visit(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      const extension = extname(entry.name).toLowerCase()
      if (!SOURCE_EXTENSIONS.has(extension) && !["Dockerfile", "Makefile", "Procfile"].includes(entry.name)) continue
      const info = await stat(fullPath).catch(() => undefined)
      if (!info || info.size > MAX_SOURCE_BYTES) continue
      output.push({ path: slash(relative(root, fullPath)), bytes: info.size, modifiedAt: info.mtimeMs })
    }
  }
  await visit(root)
  return output.sort((left, right) => left.path.localeCompare(right.path))
}

function fingerprint(candidates: FileCandidate[]) {
  const hash = createHash("sha256")
  for (const file of candidates) hash.update(`${file.path}:${file.bytes}:${Math.floor(file.modifiedAt)}\n`)
  return hash.digest("hex")
}

function extractImports(text: string, extension: string) {
  const imports = new Set<string>()
  const patterns = [
    /(?:import|export)[\s\S]{0,180}?from\s*["']([^"']+)["']/g,
    /(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
    /(?:src|href)\s*=\s*["']([^"'#?]+)["']/g,
    /@import\s+(?:url\()?\s*["']?([^"')\s;]+)["']?/g,
  ]
  if (extension === ".py") {
    patterns.push(/^\s*from\s+([\w.]+)\s+import\s+/gm, /^\s*import\s+([\w.]+)/gm)
  }
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1]?.trim()
      if (value) imports.add(value)
    }
  }
  return [...imports].slice(0, 160)
}

function extractSymbols(text: string, extension: string) {
  const symbols = new Set<string>()
  const patterns = [
    /\b(?:class|function|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:=|:)/g,
    /\b(?:def|class)\s+([A-Za-z_][\w]*)/g,
    /\b(?:fn|struct|trait|enum|impl)\s+([A-Za-z_][\w]*)/g,
  ]
  if ([".md", ".html", ".css", ".scss"].includes(extension)) {
    patterns.push(/(?:^|[\s.#])([A-Za-z][\w-]{3,})(?=[\s.{:#])/gm)
  }
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1]?.trim()
      if (value && value.length > 2) symbols.add(value)
    }
  }
  return [...symbols].slice(0, 300)
}

function resolveImport(fromPath: string, specifier: string, knownPaths: Set<string>) {
  if (!specifier.startsWith(".")) return undefined
  const base = slash(normalize(join(fromPath, "..", specifier))).replace(/^\.\//, "")
  const candidates = [
    base,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".json", ".css", ".scss", ".vue", ".svelte"].map(
      (extension) => `${base}${extension}`,
    ),
    ...["index.ts", "index.tsx", "index.js", "index.jsx", "__init__.py"].map((name) => `${base}/${name}`),
  ]
  return candidates.find((candidate) => knownPaths.has(candidate))
}

function readPersistedIndexes() {
  const value = getStore(STORE_NAME).get(STORE_KEY)
  return value && typeof value === "object" ? (value as PersistedIndexes) : {}
}

function persistIndex(index: ContextProjectIndex) {
  const indexes = readPersistedIndexes()
  indexes[projectKey(index.root)] = index
  const entries = Object.entries(indexes)
    .sort(([, left], [, right]) => right.generatedAt.localeCompare(left.generatedAt))
    .slice(0, 8)
  getStore(STORE_NAME).set(STORE_KEY, Object.fromEntries(entries))
}

export async function buildContextIndex(root: string, force = false): Promise<ContextProjectIndex> {
  const resolvedRoot = resolve(root)
  const candidates = await listCandidates(resolvedRoot)
  const currentFingerprint = fingerprint(candidates)
  const cached = readPersistedIndexes()[projectKey(resolvedRoot)]
  if (!force && cached?.fingerprint === currentFingerprint) return cached

  const files: ContextIndexFile[] = []
  for (const candidate of candidates) {
    const text = await readFile(join(resolvedRoot, candidate.path), "utf8").catch(() => "")
    const extension = extname(candidate.path).toLowerCase()
    files.push({
      ...candidate,
      estimatedTokens: estimateTokens(text || candidate.bytes),
      imports: extractImports(text, extension),
      dependencies: [],
      symbols: extractSymbols(text, extension),
    })
  }
  const paths = new Set(files.map((file) => file.path))
  for (const file of files) {
    file.dependencies = file.imports
      .map((specifier) => resolveImport(file.path, specifier, paths))
      .filter((value): value is string => Boolean(value))
  }
  const index = {
    root: resolvedRoot,
    fingerprint: currentFingerprint,
    generatedAt: new Date().toISOString(),
    files,
  }
  persistIndex(index)
  return index
}

function taskTerms(task: string) {
  return [...new Set(task.toLowerCase().match(/[a-z_$][a-z0-9_$-]{2,}/g) ?? [])].filter(
    (term) => !STOP_WORDS.has(term),
  )
}

function explicitPaths(task: string) {
  return new Set(
    (task.match(/[A-Za-z0-9_@./-]+\.[A-Za-z0-9]{1,8}/g) ?? []).map((path) => slash(path).replace(/^\.\//, "")),
  )
}

function architectureSummary(index: ContextProjectIndex) {
  const topDirectories = new Map<string, number>()
  for (const file of index.files) {
    const top = file.path.includes("/") ? file.path.split("/")[0]! : "(root)"
    topDirectories.set(top, (topDirectories.get(top) ?? 0) + 1)
  }
  const areas = [...topDirectories.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 10)
    .map(([name, count]) => `${name} (${count})`)
  const edges = index.files.reduce((total, file) => total + file.dependencies.length, 0)
  return `${index.files.length} indexed source files across ${areas.join(", ") || "the project root"}; ${edges} local dependency links mapped.`
}

export async function createContextBudgetPack(
  root: string,
  task: string,
  options: { tokenBudget?: number; fileLimit?: number; forceIndex?: boolean } = {},
): Promise<ContextBudgetPack> {
  const index = await buildContextIndex(root, options.forceIndex)
  const terms = taskTerms(task)
  const mentioned = explicitPaths(task)
  const byPath = new Map(index.files.map((file) => [file.path, file]))
  const reverseDependencies = new Map<string, string[]>()
  for (const file of index.files) {
    for (const dependency of file.dependencies) {
      reverseDependencies.set(dependency, [...(reverseDependencies.get(dependency) ?? []), file.path])
    }
  }

  const scores = new Map<string, { score: number; reasons: Set<string> }>()
  const addScore = (path: string, score: number, reason: string) => {
    const current = scores.get(path) ?? { score: 0, reasons: new Set<string>() }
    current.score += score
    current.reasons.add(reason)
    scores.set(path, current)
  }

  for (const file of index.files) {
    const pathLower = file.path.toLowerCase()
    const basename = pathLower.split("/").at(-1) ?? pathLower
    if ([...mentioned].some((path) => file.path === path || file.path.endsWith(`/${path}`) || basename === path)) {
      addScore(file.path, 1_000, "explicitly named in the task")
    }
    const pathMatches = terms.filter((term) => pathLower.includes(term))
    if (pathMatches.length) addScore(file.path, pathMatches.length * 32, `path matches ${pathMatches.slice(0, 3).join(", ")}`)
    const symbolMatches = terms.filter((term) => file.symbols.some((symbol) => symbol.toLowerCase() === term))
    if (symbolMatches.length) addScore(file.path, symbolMatches.length * 24, `defines ${symbolMatches.slice(0, 3).join(", ")}`)
    if (/^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|vite\.config\.|next\.config\.|src\/.*(?:app|main|index)\.)/i.test(file.path)) {
      addScore(file.path, 5, "project entry/configuration file")
    }
  }

  const seeds = [...scores.entries()]
    .sort((left, right) => right[1].score - left[1].score)
    .slice(0, 16)
    .map(([path]) => path)
  for (const seed of seeds) {
    const file = byPath.get(seed)
    for (const dependency of file?.dependencies ?? []) addScore(dependency, 18, `imported by ${seed}`)
    for (const dependent of reverseDependencies.get(seed) ?? []) addScore(dependent, 12, `depends on ${seed}`)
  }

  const tokenBudget = Math.max(4_000, options.tokenBudget ?? DEFAULT_TOKEN_BUDGET)
  const fileLimit = Math.max(4, options.fileLimit ?? DEFAULT_FILE_LIMIT)
  const selected: ContextBudgetFile[] = []
  let totalTokens = 0
  for (const [path, rank] of [...scores.entries()].sort((left, right) => right[1].score - left[1].score)) {
    const file = byPath.get(path)
    if (!file || rank.score <= 0 || selected.length >= fileLimit) continue
    const explicit = rank.score >= 1_000
    if (!explicit && totalTokens + file.estimatedTokens > tokenBudget) continue
    selected.push({
      path,
      score: rank.score,
      reason: [...rank.reasons].slice(0, 3).join("; "),
      estimatedTokens: file.estimatedTokens,
    })
    totalTokens += file.estimatedTokens
  }

  return {
    root: index.root,
    task,
    generatedAt: new Date().toISOString(),
    indexedFileCount: index.files.length,
    selectedFileCount: selected.length,
    estimatedTokens: totalTokens,
    tokenBudget,
    files: selected,
    architectureSummary: architectureSummary(index),
  }
}

export function formatContextBudgetForAgent(pack: ContextBudgetPack) {
  if (!pack.files.length) {
    return `Vector indexed ${pack.indexedFileCount} source files but found no high-confidence task matches. Inspect the repository structure before selecting files.`
  }
  return [
    `Vector local context index: ${pack.architectureSummary}`,
    `Context budget: inspect these ${pack.selectedFileCount} files first (about ${pack.estimatedTokens.toLocaleString()} tokens if all are read; budget ${pack.tokenBudget.toLocaleString()}):`,
    ...pack.files.map((file) => `- ${file.path} — ${file.reason}`),
    "You may inspect additional files only when imports, references, test failures, or the task prove they are needed.",
  ].join("\n")
}

export async function prepareAgentTask(root: string, task: string): Promise<AgentTaskPreparation> {
  const difficulty = classifyTaskDifficulty(task)
  if (difficulty === "trivial") {
    return {
      difficulty,
      useQuickAgent: true,
      recommendedVariant: "light",
      retryLimit: 0,
    }
  }

  const budget = contextBudgetForDifficulty(difficulty)
  const context = await createContextBudgetPack(root, task, budget)
  const workflow =
    difficulty === "complex"
      ? [
          "Create and maintain a visible implementation plan before broad edits.",
          "Use independent subagents for parallel codebase exploration or review when that reduces risk.",
          "After editing, run the strongest relevant build, typecheck, lint, or test commands available.",
          "If validation or the controlled browser reports a failure, diagnose from the evidence, repair it, and validate again. Allow up to two evidence-driven repair passes.",
          "Use the controlled browser when UI behavior matters: inspect the live page, console, runtime errors, and failed requests, then retest after repairs.",
        ]
      : difficulty === "standard"
        ? [
            "Write a concise implementation plan, keep it updated while working, and avoid unrelated edits.",
            "Run a targeted validation after editing. If it fails, make one evidence-driven repair pass and rerun it.",
            "Use the controlled browser for user-facing behavior when it is attached in Preview.",
          ]
        : [
            "Inspect only the most relevant files first and keep the change tightly scoped.",
            "Run a targeted syntax, type, or test check when code changes.",
          ]

  return {
    difficulty,
    useQuickAgent: false,
    recommendedVariant: difficulty === "complex" ? "max" : difficulty === "standard" ? "balanced" : "light",
    retryLimit: difficulty === "complex" ? 2 : difficulty === "standard" ? 1 : 0,
    context,
    instruction: [
      `<vector_task_intelligence difficulty="${difficulty}" retry_limit="${difficulty === "complex" ? 2 : difficulty === "standard" ? 1 : 0}">`,
      formatContextBudgetForAgent(context),
      ...workflow,
      "Read .vector/BRAIN.md when present. After a successful meaningful task, update it only with durable architecture decisions, accepted conventions, user corrections, or recurring failure lessons; never store secrets or routine narration.",
      "Treat this index as a starting map, not a hard boundary: expand context when imports, references, errors, or test evidence require it.",
      "</vector_task_intelligence>",
    ].join("\n"),
  }
}
