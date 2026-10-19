export * as BrainCode from "./code"

import path from "node:path"
import { BrainAnchor } from "./anchor"

// What code says about itself, read without running it: the symbols a file declares, what it imports and which files
// those imports are, the routes it registers, the environment variables it reads and the constants it gives a value.
// Regular expressions per language rather than a parser of each one: fast enough for 20,000 files, and wrong only in
// ways that cost a link, never a crash. The desktop's file ranking and the brain's code graph read code the same way.

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

/** A name a file declares, with its kind and line. */
export type Declaration = {
  name: string
  kind: SymbolKind
  line: number
  exported: boolean
}

export type Language =
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

/** A value code gives in a literal: a route it registers, an environment variable it reads, a constant it defines. */
export type Literal = {
  readonly kind: "route" | "env" | "constant"
  /** The route's shape (`/v1/users/*`), the variable's name, or the constant's name. */
  readonly value: string
  /** A route's method, when the registration gives one. */
  readonly method?: string
  readonly line: number
}

export const LIMIT = {
  /** A file larger than this is generated or data, not code anyone reads. */
  bytes: 768 * 1024,
  symbols: 400,
  imports: 200,
  dependencies: 256,
  literals: 200,
  /** Commits of history co-change reads. */
  commits: 400,
  // A thousand-file refactor commit says nothing about which files belong together, so wide commits are dropped
  // rather than diluting every pair.
  commitFiles: 32,
  neighbours: 16,
} as const

// The trailing entries are additions to the usual set: "out" holds bundled electron-vite output in this repository,
// and a bundle restates every symbol its sources declare, so reading it buries the sources it was built from.
export const EXCLUDED: ReadonlySet<string> = new Set([
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

const LANGUAGES = new Map<string, Language>([
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

const NAMED = new Set(["Dockerfile", "Makefile", "Procfile"])

const EXTENSIONS = [
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

const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx", "__init__.py", "mod.rs", "lib.rs", "index.php"]

const RESERVED = new Set([
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
  php: [/^[ \t]*use\s+([\w\\]+)/gm, /(?:require|include)(?:_once)?\s*\(?\s*["']([^"']+)["']/g],
  c: [/^[ \t]*#\s*include\s*[<"]([^>"]+)[>"]/gm],
  css: [/@import\s+(?:url\()?\s*["']?([^"')\s;]+)/g],
  text: [],
}

// Environment reads by language. Deno's `Deno.env.get("X")` is its own form, so `Deno.env.get` is never read as a
// variable called "get".
const ENV_READS = [
  /(?:process\.env|Bun\.env|import\.meta\.env)\.([A-Za-z_][A-Za-z0-9_]*)\b/g,
  /(?:process\.env|Bun\.env|import\.meta\.env|Deno\.env)\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]/g,
  /Deno\.env\.get\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]/g,
  /os\.environ(?:\.get)?\s*[[(]\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
  /\b(?:getenv|env::var)\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
]

// A line holding a string that starts with a path, the only kind of line that can register a route.
const ROUTE_LINE = /^.*["'`](?:(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) )?\/.*$/gm

/** The language a file is read as, or undefined when it is not one Vector reads as code. */
export function language(file: string): Language | undefined {
  const name = path.posix.basename(file.replaceAll("\\", "/"))
  return LANGUAGES.get(path.extname(name).toLowerCase()) ?? (NAMED.has(name) ? "text" : undefined)
}

/** Whether a repository path sits in a folder of dependencies, build output or caches. */
export function excluded(file: string) {
  return file.split("/").slice(0, -1).some((segment) => EXCLUDED.has(segment))
}

/** The symbols a file declares, at most `LIMIT.symbols`, in line order; one per kind and name. */
export function symbols(text: string, language: Language) {
  const offsets = lineOffsets(text)
  const found = new Map<string, Declaration>()
  for (const rule of SYMBOL_RULES[language]) {
    for (const match of text.matchAll(rule.pattern)) {
      if (found.size >= LIMIT.symbols) break
      const name = match[rule.name]
      if (!name || name.length < 2 || RESERVED.has(name)) continue
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

/** What a file imports, as written: module specifiers, include paths, `use` paths. */
export function imports(text: string, language: Language) {
  const found = new Set<string>()
  // Go groups its imports in a parenthesised block whose entries are bare strings, so the block has to be isolated
  // before the strings inside it can be told apart from any other quoted literal in the file.
  if (language === "go") {
    for (const block of text.matchAll(/^import\s*\(([\s\S]*?)^\)/gm)) {
      for (const entry of block[1]!.matchAll(/"([^"]+)"/g)) found.add(entry[1]!)
    }
    for (const single of text.matchAll(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) found.add(single[1]!)
    return [...found].slice(0, LIMIT.imports)
  }
  for (const pattern of IMPORT_PATTERNS[language]) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1]?.trim()
      if (value) found.add(value)
    }
  }
  return [...found].slice(0, LIMIT.imports)
}

/**
 * The routes a file registers, the environment variables it reads and the constants it gives a plain numeric value,
 * each with its line: what a document names that a symbol table does not hold.
 */
export function literals(text: string, declared: readonly Declaration[]): Literal[] {
  const offsets = lineOffsets(text)
  const found = new Map<string, Literal>()
  const add = (literal: Literal) => {
    const key = `${literal.kind}\0${literal.method ?? ""}\0${literal.value}\0${literal.line}`
    if (found.size < LIMIT.literals && !found.has(key)) found.set(key, literal)
  }
  for (const match of text.matchAll(ROUTE_LINE))
    for (const route of BrainAnchor.routes(match[0]))
      add({ kind: "route", value: route.route, ...(route.method ? { method: route.method } : {}), line: lineAt(offsets, match.index) })
  for (const pattern of ENV_READS)
    for (const match of text.matchAll(pattern)) add({ kind: "env", value: match[1]!, line: lineAt(offsets, match.index) })
  for (const symbol of declared) {
    if (symbol.kind !== "constant") continue
    const line = text.slice(offsets[symbol.line - 1], offsets[symbol.line] ?? text.length).replace(/\r?\n$/, "")
    if (BrainAnchor.value(line, symbol.name)) add({ kind: "constant", value: symbol.name, line: symbol.line })
  }
  return [...found.values()].sort((left, right) => left.line - right.line || left.value.localeCompare(right.value))
}

export type Lookup = {
  readonly paths: ReadonlySet<string>
  readonly byStem: ReadonlyMap<string, readonly string[]>
  readonly byDirectory: ReadonlyMap<string, readonly string[]>
}

/** The files of a repository by path, by name without extension, and by the folder they sit in. */
export function lookup(files: readonly string[]): Lookup {
  const byStem = new Map<string, string[]>()
  const byDirectory = new Map<string, string[]>()
  for (const file of files) {
    const name = file.split("/").at(-1)!
    const stem = name.slice(0, name.length - path.extname(name).length).toLowerCase()
    const stems = byStem.get(stem) ?? []
    stems.push(file)
    byStem.set(stem, stems)
    const directory = path.posix.dirname(file).split("/").at(-1)!.toLowerCase()
    const siblings = byDirectory.get(directory) ?? []
    siblings.push(file)
    byDirectory.set(directory, siblings)
  }
  return { paths: new Set(files), byStem, byDirectory }
}

/** The repository files a file's imports name, at most `LIMIT.dependencies`, never the file itself. */
export function dependencies(file: string, specifiers: readonly string[], language: Language, files: Lookup) {
  return [...new Set(specifiers.flatMap((specifier) => resolve(file, specifier, language, files)))]
    .filter((dependency) => dependency !== file)
    .slice(0, LIMIT.dependencies)
}

/** The repository files one import specifier names. */
export function resolve(file: string, specifier: string, language: Language, files: Lookup) {
  const normalised = language === "python" && specifier.startsWith(".") ? pythonSpecifier(specifier) : specifier
  // A relative attempt runs first for every language because `require_relative`, `#include "util.h"` and a sibling
  // Python module all name a neighbouring file without any leading dot to mark them as relative.
  if (!normalised.includes("::") && !normalised.includes("\\")) {
    const direct = matchFile(
      path.posix.normalize(path.posix.join(path.posix.dirname(file), normalised)).replace(/^\.\//, ""),
      files,
    )
    if (direct.length) return direct
  }
  if (normalised.startsWith(".")) return []

  const segments = specifierSegments(normalised, language)
  if (!segments.length) return []
  // Go names a package directory; the other languages name a module path whose trailing segments may be items inside
  // the module rather than files.
  const attempts =
    language === "go"
      ? [segments.slice(-3), segments.slice(-2), segments.slice(-1)]
      : [segments, segments.slice(0, -1), segments.slice(0, -2)]
  for (const attempt of attempts) {
    if (!attempt.length) continue
    const matched = matchSuffix(attempt, files)
    if (matched.length) return matched
  }
  return []
}

/**
 * Which files history changed together: for each file, the files committed with it in the recent commits of `git log
 * --format=%H --name-only`, counted, its `LIMIT.neighbours` most frequent. `known` maps a logged path to the
 * repository's own, or drops it.
 */
export function coChange(log: string, known: (file: string) => string | undefined) {
  const pairs = new Map<string, Map<string, number>>()
  const counted = { commits: 0 }
  const commit = (files: readonly string[]) => {
    if (files.length < 2 || files.length > LIMIT.commitFiles) return
    counted.commits += 1
    for (const left of files) {
      for (const right of files) {
        if (left === right) continue
        const neighbours = pairs.get(left) ?? new Map<string, number>()
        neighbours.set(right, (neighbours.get(right) ?? 0) + 1)
        pairs.set(left, neighbours)
      }
    }
  }
  const current: string[] = []
  for (const line of log.split("\n")) {
    const value = line.trim()
    if (!value) continue
    if (/^[0-9a-f]{40}$/.test(value)) {
      commit(current.splice(0))
      continue
    }
    const file = known(value)
    if (file) current.push(file)
  }
  commit(current)
  return {
    pairs: new Map(
      [...pairs].map(([file, neighbours]) => [
        file,
        new Map([...neighbours].sort((left, right) => right[1] - left[1]).slice(0, LIMIT.neighbours)),
      ]),
    ),
    commits: counted.commits,
  }
}

function lineOffsets(text: string) {
  const offsets = [0]
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) offsets.push(index + 1)
  return offsets
}

function lineAt(offsets: readonly number[], position: number) {
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

function matchFile(base: string, files: Lookup) {
  if (!base || base.startsWith("..")) return []
  if (files.paths.has(base)) return [base]
  const direct = EXTENSIONS.map((extension) => `${base}${extension}`).find((candidate) => files.paths.has(candidate))
  if (direct) return [direct]
  const indexed = INDEX_FILES.map((name) => `${base}/${name}`).find((candidate) => files.paths.has(candidate))
  return indexed ? [indexed] : []
}

function matchSuffix(segments: readonly string[], files: Lookup) {
  // A C include carries its extension inside the last segment; a dotted module path never does, so stripping an
  // extension that is not there is a no-op.
  const parts = [...segments.slice(0, -1), segments.at(-1)!.replace(/\.[A-Za-z0-9]{1,5}$/, "")]
  const stem = parts.at(-1)!.toLowerCase()
  const named = files.byStem.get(stem) ?? []
  const directories = files.byDirectory.get(stem) ?? []
  // A namespace prefix rarely maps onto a directory one for one, so the longest suffix that exists on disk wins and a
  // bare module name is the last resort.
  for (let start = 0; start < parts.length; start += 1) {
    const suffix = parts.slice(start).join("/").toLowerCase()
    const matched = named.filter((file) => {
      const withoutExtension = file.slice(0, file.length - path.extname(file).length).toLowerCase()
      return withoutExtension === suffix || withoutExtension.endsWith(`/${suffix}`)
    })
    if (matched.length) return matched.slice(0, 8)
    const inDirectory = directories.filter((file) => {
      const parent = path.posix.dirname(file).toLowerCase()
      return parent === suffix || parent.endsWith(`/${suffix}`)
    })
    if (inDirectory.length) return inDirectory.slice(0, 8)
  }
  return []
}
