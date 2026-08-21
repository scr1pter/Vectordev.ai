import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises"
import { dirname, extname, join, normalize, relative, resolve } from "node:path"
import { untrustedChildEnvironment } from "@opencode-ai/core/child-environment"

// A lexical + structural index: BM25 over identifiers and path segments, an
// import graph, a symbol table, and git co-change counts. There are no
// embeddings and no model of meaning here; a token that never appears in a file
// can never retrieve it.

const INDEX_VERSION = 1
const MAX_INDEXED_FILES = 20_000
const MAX_SOURCE_BYTES = 768 * 1024
const MAX_TOTAL_BYTES = 128 * 1024 * 1024
// Every distinct term costs roughly fourteen bytes in the persisted cache, so a
// twenty-thousand file monorepo would write hundreds of megabytes without a cap.
const MAX_TERMS_PER_FILE = 192
const MAX_IDENTIFIERS_SCANNED = 200_000
const MAX_SYMBOLS_PER_FILE = 400
const MAX_IMPORTS_PER_FILE = 200
const MAX_DEPENDENCIES_PER_FILE = 256
const CO_CHANGE_COMMITS = 400
// A thousand-file refactor commit says nothing about which files belong
// together, so wide commits are dropped rather than diluting every pair.
const CO_CHANGE_MAX_COMMIT_FILES = 32
const CO_CHANGE_MAX_NEIGHBOURS = 16

const BM25_K1 = 1.2
const BM25_B = 0.75

const DEFAULT_SEED_LIMIT = 16
const DEFAULT_RESULT_LIMIT = 200
const EXPLICIT_PATH_SCORE = 1_000
const SYMBOL_DEFINITION_WEIGHT = 3.5
const SYMBOL_SUBWORD_WEIGHT = 1.2
const PATH_SEGMENT_WEIGHT = 1.5
const IMPORTED_DAMPING = 0.32
const IMPORTER_DAMPING = 0.22
const SECOND_HOP_DAMPING = 0.35
const CO_CHANGE_DAMPING = 0.18
const EXPANSION_FLOOR = 0.01

// Mirrors the exclusion set in context-budget.ts. The two must stay in sync or
// the pack and the ranking would disagree about what the project contains.
// The trailing entries are additions: "out" alone holds 199MB of bundled
// electron-vite output in this repository, and a bundle re-states every symbol
// its sources declare, so indexing it buries the sources it was built from.
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
  ".dart_tool",
  ".gradle",
  ".mypy_cache",
  ".output",
  ".parcel-cache",
  ".pytest_cache",
  ".svelte-kit",
  ".tox",
  ".venv",
  "__pycache__",
  "bower_components",
  "out",
  "venv",
])

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "constant"
  | "struct"
  | "trait"
  | "module"

export type IndexedSymbol = {
  name: string
  kind: SymbolKind
  line: number
  exported: boolean
}

export type IndexedFile = {
  path: string
  bytes: number
  modifiedAt: number
  estimatedTokens: number
  language: Language
  imports: string[]
  dependencies: string[]
  symbols: IndexedSymbol[]
  tokens: Map<string, number>
  tokenCount: number
}

export type RepoIndexStats = {
  parsedFiles: number
  reusedFiles: number
  droppedFiles: number
  bytesRead: number
  durationMs: number
  coChangeCommits: number
}

export type RepoIndex = {
  root: string
  generatedAt: string
  head: string
  files: IndexedFile[]
  coChange: Map<string, Map<string, number>>
  stats: RepoIndexStats
}

export type RankedFile = {
  path: string
  score: number
  reasons: string[]
  estimatedTokens: number
  bytes: number
  hops: number
  symbols: IndexedSymbol[]
}

export type IndexOptions = {
  cacheDirectory?: string
  coChange?: boolean
}

export type RankOptions = {
  limit?: number
  seedLimit?: number
  expansion?: boolean
  coChange?: boolean
}

type Language =
  | "typescript"
  | "markup"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "ruby"
  | "php"
  | "c"
  | "css"
  | "text"

const LANGUAGE_BY_EXTENSION = new Map<string, Language>([
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".js", "typescript"],
  [".jsx", "typescript"],
  [".mjs", "typescript"],
  [".cjs", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".vue", "markup"],
  [".svelte", "markup"],
  [".astro", "markup"],
  [".html", "markup"],
  [".py", "python"],
  [".pyi", "python"],
  [".go", "go"],
  [".rs", "rust"],
  [".java", "java"],
  [".kt", "java"],
  [".kts", "java"],
  [".rb", "ruby"],
  [".php", "php"],
  [".c", "c"],
  [".cc", "c"],
  [".cpp", "c"],
  [".cxx", "c"],
  [".h", "c"],
  [".hpp", "c"],
  [".m", "c"],
  [".mm", "c"],
  [".cs", "java"],
  [".swift", "typescript"],
  [".css", "css"],
  [".scss", "css"],
  [".sass", "css"],
  [".less", "css"],
  [".md", "text"],
  [".mdx", "text"],
  [".json", "text"],
  [".yaml", "text"],
  [".yml", "text"],
  [".toml", "text"],
  [".sql", "text"],
  [".sh", "text"],
])

const EXTRA_INDEXED_FILENAMES = new Set(["Dockerfile", "Makefile", "Procfile"])

const FILE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".css",
  ".scss",
  ".vue",
  ".svelte",
  ".astro",
  ".json",
]

const INDEX_FILENAMES = [
  "index.ts",
  "index.tsx",
  "index.js",
  "index.jsx",
  "__init__.py",
  "mod.rs",
  "lib.rs",
  "index.php",
]

// Keywords and prose filler are dropped before they reach the term table. BM25
// would already discount them through idf, but keeping them out saves a large
// slice of the persisted cache.
const STOP_TERMS = new Set([
  "abstract",
  "about",
  "after",
  "again",
  "also",
  "and",
  "args",
  "async",
  "await",
  "before",
  "bool",
  "boolean",
  "break",
  "case",
  "catch",
  "char",
  "class",
  "code",
  "const",
  "continue",
  "declare",
  "def",
  "default",
  "defer",
  "delete",
  "each",
  "else",
  "elif",
  "end",
  "enum",
  "error",
  "err",
  "export",
  "extends",
  "false",
  "file",
  "final",
  "float",
  "for",
  "from",
  "func",
  "function",
  "have",
  "impl",
  "implements",
  "import",
  "int",
  "interface",
  "into",
  "let",
  "make",
  "match",
  "mod",
  "module",
  "namespace",
  "new",
  "nil",
  "none",
  "not",
  "null",
  "number",
  "package",
  "please",
  "print",
  "private",
  "protected",
  "public",
  "pub",
  "require",
  "return",
  "self",
  "should",
  "static",
  "str",
  "string",
  "struct",
  "super",
  "switch",
  "that",
  "the",
  "this",
  "throw",
  "trait",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "use",
  "using",
  "val",
  "var",
  "void",
  "want",
  "while",
  "with",
  "yield",
])

const RESERVED_SYMBOL_NAMES = new Set([
  "case",
  "catch",
  "class",
  "const",
  "default",
  "do",
  "else",
  "enum",
  "for",
  "function",
  "if",
  "return",
  "switch",
  "throw",
  "try",
  "typeof",
  "var",
  "while",
  "with",
])

type SymbolRule = {
  pattern: RegExp
  kind: SymbolKind
  name: number
  exported?: number
  exportedWhenBlank?: boolean
  exportedWhenCapitalised?: boolean
}

const TYPESCRIPT_SYMBOLS: SymbolRule[] = [
  {
    pattern: /^[ \t]*(export\s+)?(?:declare\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm,
    kind: "function",
    name: 2,
    exported: 1,
  },
  {
    pattern: /^[ \t]*(export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
    kind: "class",
    name: 2,
    exported: 1,
  },
  {
    pattern: /^[ \t]*(export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/gm,
    kind: "interface",
    name: 2,
    exported: 1,
  },
  {
    pattern: /^[ \t]*(export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/gm,
    kind: "type",
    name: 2,
    exported: 1,
  },
  {
    pattern: /^[ \t]*(export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/gm,
    kind: "enum",
    name: 2,
    exported: 1,
  },
  {
    pattern: /^[ \t]*(export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    kind: "constant",
    name: 2,
    exported: 1,
  },
  {
    pattern:
      /^[ \t]{2,}(?:(?:public|private|protected|static|readonly|override|async)\s+)*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*[:{]/gm,
    kind: "method",
    name: 1,
  },
]

const SYMBOL_RULES: Record<Language, SymbolRule[]> = {
  typescript: TYPESCRIPT_SYMBOLS,
  markup: TYPESCRIPT_SYMBOLS,
  python: [
    { pattern: /^([ \t]*)(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, kind: "function", name: 2, exportedWhenBlank: true },
    { pattern: /^([ \t]*)class\s+([A-Za-z_]\w*)/gm, kind: "class", name: 2, exportedWhenBlank: true },
    { pattern: /^()([A-Z_][A-Z0-9_]{2,})\s*(?::[^=]+)?=/gm, kind: "constant", name: 2, exportedWhenBlank: true },
  ],
  go: [
    {
      pattern: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm,
      kind: "function",
      name: 1,
      exportedWhenCapitalised: true,
    },
    { pattern: /^type\s+([A-Za-z_]\w*)\s+struct\b/gm, kind: "struct", name: 1, exportedWhenCapitalised: true },
    { pattern: /^type\s+([A-Za-z_]\w*)\s+interface\b/gm, kind: "interface", name: 1, exportedWhenCapitalised: true },
    { pattern: /^type\s+([A-Za-z_]\w*)\s+(?!struct\b|interface\b)/gm, kind: "type", name: 1, exportedWhenCapitalised: true },
    { pattern: /^(?:var|const)\s+([A-Za-z_]\w*)/gm, kind: "constant", name: 1, exportedWhenCapitalised: true },
  ],
  rust: [
    { pattern: /^[ \t]*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm, kind: "function", name: 2, exported: 1 },
    { pattern: /^[ \t]*(pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/gm, kind: "struct", name: 2, exported: 1 },
    { pattern: /^[ \t]*(pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/gm, kind: "trait", name: 2, exported: 1 },
    { pattern: /^[ \t]*(pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/gm, kind: "enum", name: 2, exported: 1 },
    { pattern: /^[ \t]*(pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/gm, kind: "type", name: 2, exported: 1 },
    { pattern: /^[ \t]*(pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/gm, kind: "module", name: 2, exported: 1 },
    { pattern: /^[ \t]*(pub(?:\([^)]*\))?\s+)?(?:static|const)\s+([A-Za-z_]\w*)/gm, kind: "constant", name: 2, exported: 1 },
  ],
  java: [
    {
      pattern: /^[ \t]*(public\s+)?(?:static\s+|final\s+|abstract\s+|sealed\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/gm,
      kind: "class",
      name: 2,
      exported: 1,
    },
    {
      pattern:
        /^[ \t]+(public\s+|protected\s+)?(?:static\s+|final\s+|synchronized\s+|abstract\s+)*[\w.<>,\[\]]+\s+([A-Za-z_]\w*)\s*\([^()]*\)\s*[{;]/gm,
      kind: "method",
      name: 2,
      exported: 1,
    },
  ],
  ruby: [
    { pattern: /^[ \t]*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/gm, kind: "function", name: 1 },
    { pattern: /^[ \t]*class\s+([A-Z][\w:]*)/gm, kind: "class", name: 1, exportedWhenCapitalised: true },
    { pattern: /^[ \t]*module\s+([A-Z][\w:]*)/gm, kind: "module", name: 1, exportedWhenCapitalised: true },
  ],
  php: [
    {
      pattern: /^[ \t]*(?:(public|private|protected)\s+)?(?:static\s+)?function\s+([A-Za-z_]\w*)/gm,
      kind: "function",
      name: 2,
    },
    { pattern: /^[ \t]*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/gm, kind: "class", name: 1 },
    { pattern: /^[ \t]*interface\s+([A-Za-z_]\w*)/gm, kind: "interface", name: 1 },
    { pattern: /^[ \t]*trait\s+([A-Za-z_]\w*)/gm, kind: "trait", name: 1 },
  ],
  c: [
    { pattern: /^[ \t]*(?:typedef\s+)?(?:struct|union)\s+([A-Za-z_]\w*)/gm, kind: "struct", name: 1 },
    { pattern: /^[ \t]*(?:typedef\s+)?enum\s+([A-Za-z_]\w*)/gm, kind: "enum", name: 1 },
    { pattern: /^[ \t]*class\s+([A-Za-z_]\w*)/gm, kind: "class", name: 1 },
    { pattern: /^[A-Za-z_][\w\s*&:<>,]*?\b([A-Za-z_]\w*)\s*\([^;()]*\)\s*\{/gm, kind: "function", name: 1 },
    { pattern: /^[ \t]*#define\s+([A-Z_][A-Z0-9_]*)/gm, kind: "constant", name: 1 },
  ],
  css: [{ pattern: /^[ \t]*(?:\.|#)([A-Za-z][\w-]{2,})/gm, kind: "constant", name: 1 }],
  text: [{ pattern: /^#{1,4}\s+([A-Za-z][\w -]{2,})/gm, kind: "module", name: 1 }],
}

const TYPESCRIPT_IMPORTS = [
  /(?:^|[\s;}])(?:import|export)\s[^;'"]{0,240}?from\s*["']([^"']+)["']/g,
  /(?:^|[\s;=(,])import\s*\(\s*["']([^"']+)["']\s*\)/g,
  /(?:^|[\s;=(,])require\s*\(\s*["']([^"']+)["']\s*\)/g,
  /^[ \t]*import\s+["']([^"']+)["']/gm,
]

const IMPORT_PATTERNS: Record<Language, RegExp[]> = {
  typescript: TYPESCRIPT_IMPORTS,
  markup: [...TYPESCRIPT_IMPORTS, /(?:src|href)\s*=\s*["']([^"'#?]+)["']/g, /@import\s+["']([^"']+)["']/g],
  python: [/^[ \t]*from\s+([.\w]+)\s+import\s/gm, /^[ \t]*import\s+([.\w]+)/gm],
  go: [],
  rust: [/^[ \t]*(?:pub\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm, /^[ \t]*(?:pub\s+)?use\s+([\w:]+)/gm],
  java: [/^[ \t]*import\s+(?:static\s+)?([\w.]+)\s*;/gm],
  ruby: [/^[ \t]*require(?:_relative)?\s*\(?\s*["']([^"']+)["']/gm],
  php: [
    /^[ \t]*use\s+([\w\\]+)/gm,
    /(?:require|include)(?:_once)?\s*\(?\s*["']([^"']+)["']/g,
  ],
  c: [/^[ \t]*#\s*include\s*[<"]([^>"]+)[>"]/gm],
  css: [/@import\s+(?:url\()?\s*["']?([^"')\s;]+)/g],
  text: [],
}

const IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_]{1,63}/g
const EXPLICIT_PATH_PATTERN = /[A-Za-z0-9_@./-]+\.[A-Za-z0-9]{1,8}/g

type PathLookup = {
  paths: Set<string>
  byStem: Map<string, string[]>
  byDirectory: Map<string, string[]>
}

const memory = new Map<string, RepoIndex>()

/** Drops the in-process index cache. The next refresh reloads from disk. */
export function clearIndexCache(projectPath?: string) {
  if (!projectPath) return memory.clear()
  memory.delete(resolve(projectPath))
}

/** Discards any cached index and re-parses every file in the project. */
export function buildIndex(projectPath: string, options: IndexOptions = {}) {
  clearIndexCache(projectPath)
  return indexProject(projectPath, options, true)
}

/** Re-parses only the files whose size or mtime changed since the last build. */
export function refreshIndex(projectPath: string, options: IndexOptions = {}) {
  return indexProject(projectPath, options, false)
}

async function indexProject(projectPath: string, options: IndexOptions, force: boolean): Promise<RepoIndex> {
  const startedAt = Date.now()
  const root = resolve(projectPath)
  const previous = force ? undefined : (memory.get(root) ?? (await loadPersisted(root, options.cacheDirectory)))
  const cached = new Map((previous?.files ?? []).map((file) => [file.path, file]))
  const candidates = await listCandidates(root)

  const files: IndexedFile[] = []
  const stats = { parsedFiles: 0, reusedFiles: 0, droppedFiles: 0, bytesRead: 0 }
  for (const candidate of candidates) {
    const reusable = cached.get(candidate.path)
    if (reusable && reusable.bytes === candidate.bytes && reusable.modifiedAt === candidate.modifiedAt) {
      files.push(reusable)
      stats.reusedFiles += 1
      continue
    }
    if (stats.bytesRead + candidate.bytes > MAX_TOTAL_BYTES) {
      stats.droppedFiles += 1
      continue
    }
    const text = await readFile(join(root, candidate.path), "utf8").catch(() => "")
    files.push(parseFile(candidate, text))
    stats.parsedFiles += 1
    stats.bytesRead += candidate.bytes
  }

  const lookup = buildLookup(files)
  for (const file of files) {
    file.dependencies = [
      ...new Set(file.imports.flatMap((specifier) => resolveSpecifier(file.path, specifier, file.language, lookup))),
    ]
      .filter((dependency) => dependency !== file.path)
      .slice(0, MAX_DEPENDENCIES_PER_FILE)
  }

  const repository =
    options.coChange === false
      ? { head: "", coChange: new Map<string, Map<string, number>>(), commits: 0 }
      : await gitCoChange(root, lookup.paths, previous)
  const index: RepoIndex = {
    root,
    generatedAt: new Date().toISOString(),
    head: repository.head,
    files,
    coChange: repository.coChange,
    stats: {
      ...stats,
      durationMs: Date.now() - startedAt,
      coChangeCommits: repository.commits,
    },
  }
  memory.set(root, index)
  if (options.cacheDirectory) await persist(index, options.cacheDirectory)
  return index
}

type FileCandidate = { path: string; bytes: number; modifiedAt: number }

async function listCandidates(root: string) {
  const output: FileCandidate[] = []
  const visit = async (current: string) => {
    if (output.length >= MAX_INDEXED_FILES) return
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (output.length >= MAX_INDEXED_FILES) break
      if (entry.name === ".DS_Store") continue
      const fullPath = join(current, entry.name)
      // Dirent.isDirectory() is false for symlinked directories, which keeps the
      // walk from following a link back into a directory it already visited.
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await visit(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      if (!LANGUAGE_BY_EXTENSION.has(extname(entry.name).toLowerCase()) && !EXTRA_INDEXED_FILENAMES.has(entry.name)) continue
      const info = await stat(fullPath).catch(() => undefined)
      if (!info || info.size > MAX_SOURCE_BYTES) continue
      output.push({ path: slash(relative(root, fullPath)), bytes: info.size, modifiedAt: info.mtimeMs })
    }
  }
  await visit(root)
  return output.sort((left, right) => left.path.localeCompare(right.path))
}

function parseFile(candidate: FileCandidate, text: string): IndexedFile {
  const language = LANGUAGE_BY_EXTENSION.get(extname(candidate.path).toLowerCase()) ?? "text"
  const symbols = extractSymbols(text, language)
  const terms = extractTerms(text, candidate.path, symbols)
  return {
    path: candidate.path,
    bytes: candidate.bytes,
    modifiedAt: candidate.modifiedAt,
    estimatedTokens: Math.max(1, Math.ceil((text.length || candidate.bytes) / 4)),
    language,
    imports: extractImports(text, language),
    dependencies: [],
    symbols,
    tokens: terms.tokens,
    tokenCount: terms.tokenCount,
  }
}

function slash(path: string) {
  return path.replaceAll("\\", "/")
}

function lineOffsets(text: string) {
  const offsets = [0]
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) offsets.push(index + 1)
  return offsets
}

function lineAt(offsets: number[], position: number) {
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (offsets[mid]! <= position) {
      low = mid
      continue
    }
    high = mid - 1
  }
  return low + 1
}

function extractSymbols(text: string, language: Language) {
  const offsets = lineOffsets(text)
  const found = new Map<string, IndexedSymbol>()
  for (const rule of SYMBOL_RULES[language]) {
    for (const match of text.matchAll(rule.pattern)) {
      if (found.size >= MAX_SYMBOLS_PER_FILE) break
      const name = match[rule.name]
      if (!name || name.length < 2 || RESERVED_SYMBOL_NAMES.has(name)) continue
      const key = `${rule.kind}:${name}`
      if (found.has(key)) continue
      found.set(key, {
        name,
        kind: rule.kind,
        line: lineAt(offsets, match.index ?? 0),
        exported: rule.exportedWhenCapitalised
          ? /^[A-Z]/.test(name)
          : rule.exportedWhenBlank
            ? !match[rule.exported ?? 1]
            : Boolean(rule.exported && match[rule.exported]),
      })
    }
  }
  return [...found.values()].sort((left, right) => left.line - right.line)
}

function extractImports(text: string, language: Language) {
  const imports = new Set<string>()
  // Go groups its imports in a parenthesised block whose entries are bare
  // strings, so the block has to be isolated before the strings inside it can be
  // told apart from any other quoted literal in the file.
  if (language === "go") {
    for (const block of text.matchAll(/^import\s*\(([\s\S]*?)^\)/gm)) {
      for (const entry of block[1]!.matchAll(/"([^"]+)"/g)) imports.add(entry[1]!)
    }
    for (const single of text.matchAll(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) imports.add(single[1]!)
    return [...imports].slice(0, MAX_IMPORTS_PER_FILE)
  }
  for (const pattern of IMPORT_PATTERNS[language]) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1]?.trim()
      if (value) imports.add(value)
    }
  }
  return [...imports].slice(0, MAX_IMPORTS_PER_FILE)
}

function splitIdentifier(identifier: string) {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
}

function extractTerms(text: string, path: string, symbols: IndexedSymbol[]) {
  const tokens = new Map<string, number>()
  const protectedTerms = new Set<string>()
  let tokenCount = 0
  const add = (term: string, weight: number) => {
    // The persisted cache encodes this table as a space separated "term count"
    // list, so a term containing whitespace would shift every pair after it on
    // decode and overwrite an unrelated term with NaN. Markdown headings and
    // paths with spaces both reach here, and their sub-words are added
    // separately, so dropping the joined form costs no retrieval.
    if (term.length < 3 || term.length > 40 || STOP_TERMS.has(term) || /\s/.test(term)) return
    tokens.set(term, (tokens.get(term) ?? 0) + weight)
    tokenCount += weight
  }

  let scanned = 0
  for (const match of text.matchAll(IDENTIFIER_PATTERN)) {
    if (scanned >= MAX_IDENTIFIERS_SCANNED) break
    scanned += 1
    const identifier = match[0]
    const lower = identifier.toLowerCase()
    add(lower, 1)
    for (const part of splitIdentifier(identifier)) {
      const partial = part.toLowerCase()
      if (partial !== lower) add(partial, 1)
    }
  }

  // Path segments are short but highly indicative of intent, so they carry more
  // weight per occurrence than a body identifier does.
  for (const segment of path.toLowerCase().split(/[/.\s]+/)) {
    add(segment, PATH_SEGMENT_WEIGHT)
    protectedTerms.add(segment)
    for (const part of segment.split(/[-_]/)) {
      add(part, PATH_SEGMENT_WEIGHT)
      protectedTerms.add(part)
    }
  }

  for (const symbol of symbols) {
    const lower = symbol.name.toLowerCase()
    add(lower, symbol.exported ? 3 : 2)
    protectedTerms.add(lower)
    for (const part of splitIdentifier(symbol.name)) {
      const partial = part.toLowerCase()
      if (partial === lower) continue
      add(partial, 1)
      protectedTerms.add(partial)
    }
  }

  if (tokens.size <= MAX_TERMS_PER_FILE) return { tokens, tokenCount }
  // The declared and path-derived terms are the ones a task is most likely to
  // name, so they survive the cap even when a generated file floods the table.
  const kept = [...tokens.entries()]
    .sort(
      (left, right) =>
        Number(protectedTerms.has(right[0])) - Number(protectedTerms.has(left[0])) || right[1] - left[1],
    )
    .slice(0, MAX_TERMS_PER_FILE)
  return { tokens: new Map(kept), tokenCount }
}

function buildLookup(files: IndexedFile[]): PathLookup {
  const byStem = new Map<string, string[]>()
  const byDirectory = new Map<string, string[]>()
  for (const file of files) {
    const name = file.path.split("/").at(-1)!
    const stem = name.slice(0, name.length - extname(name).length).toLowerCase()
    byStem.set(stem, [...(byStem.get(stem) ?? []), file.path])
    const directory = dirname(file.path).split("/").at(-1)!.toLowerCase()
    byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), file.path])
  }
  return { paths: new Set(files.map((file) => file.path)), byStem, byDirectory }
}

function resolveSpecifier(fromPath: string, specifier: string, language: Language, lookup: PathLookup) {
  const normalised = language === "python" && specifier.startsWith(".") ? pythonSpecifier(specifier) : specifier
  // A relative attempt runs first for every language because `require_relative`,
  // `#include "util.h"` and a sibling Python module all name a neighbouring file
  // without any leading dot to mark them as relative.
  if (!normalised.includes("::") && !normalised.includes("\\")) {
    const direct = matchFile(slash(normalize(join(dirname(fromPath), normalised))).replace(/^\.\//, ""), lookup)
    if (direct.length) return direct
  }
  if (normalised.startsWith(".")) return []

  const segments = specifierSegments(normalised, language)
  if (!segments.length) return []
  // Go names a package directory; the other languages name a module path whose
  // trailing segments may be items inside the module rather than files.
  const attempts =
    language === "go"
      ? [segments.slice(-3), segments.slice(-2), segments.slice(-1)]
      : [segments, segments.slice(0, -1), segments.slice(0, -2)]
  for (const attempt of attempts) {
    if (!attempt.length) continue
    const matched = matchSuffix(attempt, lookup)
    if (matched.length) return matched
  }
  return []
}

function pythonSpecifier(specifier: string) {
  const level = specifier.match(/^\.+/)![0].length
  const rest = specifier.slice(level).replaceAll(".", "/")
  return `${"../".repeat(level - 1)}./${rest}`
}

function specifierSegments(specifier: string, language: Language) {
  if (language === "rust") return specifier.replace(/^(?:crate|self|super)::/, "").split("::").filter(Boolean)
  if (language === "php") return specifier.split(/[\\/]/).filter(Boolean)
  if (language === "python" || language === "java") return specifier.split(".").filter(Boolean)
  return specifier.split("/").filter(Boolean)
}

function matchFile(base: string, lookup: PathLookup) {
  if (!base || base.startsWith("..")) return []
  if (lookup.paths.has(base)) return [base]
  const direct = FILE_EXTENSIONS.map((extension) => `${base}${extension}`).find((candidate) => lookup.paths.has(candidate))
  if (direct) return [direct]
  const indexed = INDEX_FILENAMES.map((name) => `${base}/${name}`).find((candidate) => lookup.paths.has(candidate))
  return indexed ? [indexed] : []
}

function matchSuffix(segments: string[], lookup: PathLookup) {
  // A C include carries its extension inside the last segment; a dotted module
  // path never does, so stripping an extension that is not there is a no-op.
  const parts = [...segments.slice(0, -1), segments.at(-1)!.replace(/\.[A-Za-z0-9]{1,5}$/, "")]
  const stem = parts.at(-1)!.toLowerCase()
  const files = lookup.byStem.get(stem) ?? []
  const directories = lookup.byDirectory.get(stem) ?? []
  // A namespace prefix rarely maps onto a directory one for one, so the longest
  // suffix that exists on disk wins and a bare module name is the last resort.
  for (let start = 0; start < parts.length; start += 1) {
    const suffix = parts.slice(start).join("/").toLowerCase()
    const matched = files.filter((path) => {
      const withoutExtension = path.slice(0, path.length - extname(path).length).toLowerCase()
      return withoutExtension === suffix || withoutExtension.endsWith(`/${suffix}`)
    })
    if (matched.length) return matched.slice(0, 8)
    const inDirectory = directories.filter((path) => {
      const parent = dirname(path).toLowerCase()
      return parent === suffix || parent.endsWith(`/${suffix}`)
    })
    if (inDirectory.length) return inDirectory.slice(0, 8)
  }
  return []
}

async function gitCoChange(root: string, known: Set<string>, previous: RepoIndex | undefined) {
  const revision = (await git(root, ["rev-parse", "--show-toplevel", "HEAD"])).split("\n")
  const topLevel = revision[0]?.trim()
  const head = revision[1]?.trim() ?? ""
  if (!topLevel || !head) return { head: "", coChange: new Map<string, Map<string, number>>(), commits: 0 }
  // Co-change comes from committed history alone, so an unchanged HEAD means the
  // previous counts are still exact. The log scan below dominates a warm
  // refresh, so it has to be skipped here rather than run and then discarded.
  if (head === previous?.head && previous.coChange.size > 0)
    return { head, coChange: previous.coChange, commits: previous.stats.coChangeCommits }
  // git reports the physical repository path, so the project root has to lose its
  // symlinks too or every path it reports would fall outside the index.
  const realRoot = await realpath(root).catch(() => root)

  const log = await git(root, ["log", "--no-merges", "--format=%H", "--name-only", "-n", String(CO_CHANGE_COMMITS)])
  const pairs = new Map<string, Map<string, number>>()
  let commits = 0
  const record = (files: string[]) => {
    if (files.length < 2 || files.length > CO_CHANGE_MAX_COMMIT_FILES) return
    commits += 1
    for (const left of files) {
      for (const right of files) {
        if (left === right) continue
        const neighbours = pairs.get(left) ?? new Map<string, number>()
        neighbours.set(right, (neighbours.get(right) ?? 0) + 1)
        pairs.set(left, neighbours)
      }
    }
  }

  let current: string[] = []
  for (const line of log.split("\n")) {
    const value = line.trim()
    if (!value) continue
    if (/^[0-9a-f]{40}$/.test(value)) {
      record(current)
      current = []
      continue
    }
    // git reports paths from the repository root, which is not the project root
    // when Vector has a subdirectory of a larger repository open.
    const candidate = slash(relative(realRoot, join(topLevel, value)))
    if (known.has(candidate)) current.push(candidate)
  }
  record(current)

  const coChange = new Map(
    [...pairs].map(([path, neighbours]) => [
      path,
      new Map([...neighbours].sort((left, right) => right[1] - left[1]).slice(0, CO_CHANGE_MAX_NEIGHBOURS)),
    ]),
  )
  return { head, coChange, commits }
}

function git(cwd: string, args: string[]) {
  // A missing git binary, a detached worktree and a plain directory all just mean
  // there is no history signal to add, so every failure resolves to no output.
  return new Promise<string>((resolveOutput) =>
    execFile(
      "git",
      args,
      { cwd, env: untrustedChildEnvironment(), timeout: 8_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => resolveOutput(error ? "" : stdout),
    ),
  )
}

type PersistedFile = Omit<IndexedFile, "tokens"> & { tokens: string }

type PersistedIndex = {
  version: number
  root: string
  generatedAt: string
  head: string
  files: PersistedFile[]
  coChange: Record<string, Record<string, number>>
  stats: RepoIndexStats
}

function cachePath(root: string, cacheDirectory: string) {
  return join(cacheDirectory, `repo-index-${createHash("sha256").update(root).digest("hex").slice(0, 24)}.json`)
}

async function persist(index: RepoIndex, cacheDirectory: string) {
  await mkdir(cacheDirectory, { recursive: true }).catch(() => undefined)
  const payload: PersistedIndex = {
    version: INDEX_VERSION,
    root: index.root,
    generatedAt: index.generatedAt,
    head: index.head,
    // A term table serialises to roughly half the bytes as a space separated
    // "term count" list compared with a JSON object of one key per term.
    files: index.files.map((file) => ({
      ...file,
      tokens: [...file.tokens].map(([term, count]) => `${term} ${count}`).join(" "),
    })),
    coChange: Object.fromEntries([...index.coChange].map(([path, neighbours]) => [path, Object.fromEntries(neighbours)])),
    stats: index.stats,
  }
  const target = cachePath(index.root, cacheDirectory)
  // Write beside the target and rename so a crash mid-write cannot leave a
  // half-written cache that the next launch would have to discard.
  const staging = `${target}.${process.pid}.tmp`
  await writeFile(staging, JSON.stringify(payload), "utf8").catch(() => undefined)
  await rename(staging, target).catch(() => undefined)
}

async function loadPersisted(root: string, cacheDirectory?: string) {
  if (!cacheDirectory) return undefined
  const raw = await readFile(cachePath(root, cacheDirectory), "utf8").catch(() => "")
  if (!raw) return undefined
  const parsed = parseIndex(raw)
  if (!parsed || parsed.version !== INDEX_VERSION || parsed.root !== root || !Array.isArray(parsed.files)) return undefined
  return {
    root: parsed.root,
    generatedAt: parsed.generatedAt,
    head: parsed.head ?? "",
    files: parsed.files.map((file) => ({ ...file, tokens: decodeTerms(file.tokens) })),
    coChange: new Map(
      Object.entries(parsed.coChange ?? {}).map(([path, neighbours]) => [path, new Map(Object.entries(neighbours))]),
    ),
    stats: parsed.stats ?? { parsedFiles: 0, reusedFiles: 0, droppedFiles: 0, bytesRead: 0, durationMs: 0, coChangeCommits: 0 },
  } satisfies RepoIndex
}

function parseIndex(raw: string) {
  // The cache is ours but it lives on a user's disk, where truncation and
  // partial restores from backup software both produce unparseable JSON.
  try {
    return JSON.parse(raw) as PersistedIndex
  } catch {
    return undefined
  }
}

function decodeTerms(encoded: string) {
  const parts = encoded ? encoded.split(" ") : []
  const tokens = new Map<string, number>()
  for (let index = 0; index + 1 < parts.length; index += 2) tokens.set(parts[index]!, Number(parts[index + 1]))
  return tokens
}

export function queryTerms(query: string) {
  const terms = new Set<string>()
  for (const match of query.toLowerCase().matchAll(IDENTIFIER_PATTERN)) {
    const identifier = match[0]
    if (identifier.length >= 3 && !STOP_TERMS.has(identifier)) terms.add(identifier)
    for (const part of splitIdentifier(identifier)) {
      if (part.length >= 3 && !STOP_TERMS.has(part)) terms.add(part)
    }
  }
  for (const match of query.matchAll(/[A-Za-z_$][\w$]*/g)) {
    for (const part of splitIdentifier(match[0])) {
      const partial = part.toLowerCase()
      if (partial.length >= 3 && !STOP_TERMS.has(partial)) terms.add(partial)
    }
  }
  return [...terms]
}

function explicitPaths(query: string) {
  return new Set((query.match(EXPLICIT_PATH_PATTERN) ?? []).map((path) => slash(path).replace(/^\.\//, "")))
}

type Rank = { score: number; hops: number; reasons: Array<{ weight: number; text: string }>; symbols: IndexedSymbol[] }

/**
 * Ranks the indexed files against a task description. Scoring is BM25 over
 * identifiers and path segments, plus declaration hits, import graph expansion
 * and git co-change — all lexical and structural, never an embedding.
 */
export function rankFiles(index: RepoIndex, query: string, options: RankOptions = {}): RankedFile[] {
  const terms = queryTerms(query)
  const mentioned = explicitPaths(query)
  if (!terms.length && !mentioned.size) return []

  const total = index.files.length
  const averageLength = Math.max(1, index.files.reduce((sum, file) => sum + file.tokenCount, 0) / Math.max(1, total))
  // The Lucene form of idf stays positive even for a term in every document, so
  // a token like "logger" contributes a rounding error instead of a ranking.
  const idf = new Map(
    terms.map((term) => {
      const documents = index.files.filter((file) => file.tokens.has(term)).length
      return [term, Math.log(1 + (total - documents + 0.5) / (documents + 0.5))]
    }),
  )

  const ranks = new Map<string, Rank>()
  const add = (path: string, score: number, weight: number, text: string, hops: number) => {
    const current = ranks.get(path) ?? { score: 0, hops, reasons: [], symbols: [] }
    current.score += score
    current.hops = Math.min(current.hops, hops)
    if (text && !current.reasons.some((reason) => reason.text === text)) current.reasons.push({ weight, text })
    ranks.set(path, current)
  }

  for (const file of index.files) {
    const lengthNormalisation = 1 - BM25_B + (BM25_B * file.tokenCount) / averageLength
    const matched: string[] = []
    const lexical = terms.reduce((sum, term) => {
      const frequency = file.tokens.get(term)
      if (!frequency) return sum
      matched.push(term)
      return sum + idf.get(term)! * ((frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * lengthNormalisation))
    }, 0)
    if (lexical > 0) add(file.path, lexical, lexical, `mentions ${matched.slice(0, 3).join(", ")}`, 0)

    const lowerPath = file.path.toLowerCase()
    if ([...mentioned].some((path) => file.path === path || file.path.endsWith(`/${path}`))) {
      add(file.path, EXPLICIT_PATH_SCORE, EXPLICIT_PATH_SCORE, "explicitly named in the task", 0)
    }
    const pathMatches = terms.filter((term) => lowerPath.includes(term))
    if (pathMatches.length) {
      const weight = pathMatches.reduce((sum, term) => sum + idf.get(term)!, 0)
      add(file.path, weight, weight, `path matches ${pathMatches.slice(0, 3).join(", ")}`, 0)
    }

    if (!lexical && !pathMatches.length) continue
    const declared = matchSymbols(file, terms)
    if (!declared.length) continue
    // Credit each query term once, at its best hit. Summing over every matching
    // declaration would let a stylesheet with a dozen "license" class names beat
    // the module that actually implements licensing.
    const strongestPerTerm = new Map<string, number>()
    for (const hit of declared) strongestPerTerm.set(hit.term, Math.max(strongestPerTerm.get(hit.term) ?? 0, hit.weight))
    const weight = [...strongestPerTerm].reduce((sum, [term, best]) => sum + best * idf.get(term)!, 0)
    const rank = ranks.get(file.path)
    if (rank) rank.symbols = declared.map((hit) => hit.symbol).slice(0, 6)
    add(
      file.path,
      weight,
      weight,
      `defines ${declared[0]!.symbol.name} (line ${declared[0]!.symbol.line})${declared.length > 1 ? ` and ${declared.length - 1} more` : ""}`,
      0,
    )
  }

  const seeds = [...ranks.entries()]
    .sort((left, right) => right[1].score - left[1].score)
    .slice(0, Math.max(1, options.seedLimit ?? DEFAULT_SEED_LIMIT))

  if (options.expansion !== false) expand(index, seeds, add)
  if (options.coChange !== false) {
    // A manifest or a root layout is touched by nearly every commit, so without
    // damping by how widely a file co-changes it would attach itself to every
    // seed and outrank the files the task actually names.
    const breadth = (path: string) =>
      1 / Math.log2(2 + [...(index.coChange.get(path)?.values() ?? [])].reduce((sum, count) => sum + count, 0))
    for (const [path, seed] of seeds) {
      const neighbours = index.coChange.get(path)
      if (!neighbours) continue
      const strongest = Math.max(...neighbours.values())
      for (const [neighbour, count] of neighbours) {
        const contribution = (seed.score * CO_CHANGE_DAMPING * count * breadth(neighbour)) / strongest
        if (contribution < EXPANSION_FLOOR) continue
        add(neighbour, contribution, contribution, `changed alongside ${path} in ${count} recent commits`, seed.hops + 1)
      }
    }
  }

  const byPath = new Map(index.files.map((file) => [file.path, file]))
  return [...ranks.entries()]
    .flatMap(([path, rank]) => {
      const file = byPath.get(path)
      if (!file || rank.score <= 0) return []
      return [
        {
          path,
          score: rank.score,
          hops: rank.hops,
          reasons: rank.reasons.sort((left, right) => right.weight - left.weight).map((reason) => reason.text),
          estimatedTokens: file.estimatedTokens,
          bytes: file.bytes,
          symbols: rank.symbols,
        },
      ]
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, options.limit ?? DEFAULT_RESULT_LIMIT))
}

function matchSymbols(file: IndexedFile, terms: string[]) {
  const hits: Array<{ term: string; symbol: IndexedSymbol; weight: number }> = []
  for (const symbol of file.symbols) {
    const lower = symbol.name.toLowerCase()
    const exact = terms.find((term) => term === lower)
    if (exact) {
      hits.push({ term: exact, symbol, weight: symbol.exported ? SYMBOL_DEFINITION_WEIGHT : SYMBOL_DEFINITION_WEIGHT * 0.6 })
      continue
    }
    const parts = splitIdentifier(symbol.name).map((part) => part.toLowerCase())
    const partial = terms.find((term) => parts.includes(term))
    if (partial) hits.push({ term: partial, symbol, weight: SYMBOL_SUBWORD_WEIGHT })
  }
  return hits.sort((left, right) => right.weight - left.weight)
}

function expand(index: RepoIndex, seeds: Array<[string, Rank]>, add: (path: string, score: number, weight: number, text: string, hops: number) => void) {
  const byPath = new Map(index.files.map((file) => [file.path, file]))
  const dependents = new Map<string, string[]>()
  for (const file of index.files) {
    for (const dependency of file.dependencies) {
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), file.path])
    }
  }
  // Damping by degree at both ends keeps a barrel file from spraying credit over
  // everything it re-exports, and keeps a utility that half the repository
  // imports from accumulating a share of every seed.
  const outward = (path: string) => 1 / Math.log2(2 + (byPath.get(path)?.dependencies.length ?? 0))
  const inward = (path: string) => 1 / Math.log2(2 + (dependents.get(path)?.length ?? 0))

  const spread = (from: string, amount: number, hop: number) => {
    const reached: Array<[string, number]> = []
    for (const dependency of byPath.get(from)?.dependencies ?? []) {
      const contribution = amount * IMPORTED_DAMPING * outward(from) * inward(dependency)
      if (contribution < EXPANSION_FLOOR) continue
      add(dependency, contribution, contribution, `imported by ${from}`, hop)
      reached.push([dependency, contribution])
    }
    for (const dependent of dependents.get(from) ?? []) {
      const contribution = amount * IMPORTER_DAMPING * inward(from) * outward(dependent)
      if (contribution < EXPANSION_FLOOR) continue
      add(dependent, contribution, contribution, `depends on ${from}`, hop)
      reached.push([dependent, contribution])
    }
    return reached
  }

  for (const [path, seed] of seeds) {
    for (const [neighbour, contribution] of spread(path, seed.score, seed.hops + 1)) {
      spread(neighbour, contribution * SECOND_HOP_DAMPING, seed.hops + 2)
    }
  }
}
