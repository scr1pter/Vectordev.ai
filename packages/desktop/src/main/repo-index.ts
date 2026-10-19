import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"
import { BrainCode } from "@vectordevai/core/brain/code"
import { BrainLexical } from "@vectordevai/core/brain/lexical"

// A lexical + structural index: BM25 over identifiers and path segments, an
// import graph, a symbol table, and git co-change counts. There are no
// embeddings and no model of meaning here; a token that never appears in a file
// can never retrieve it. Files are read by BrainCode, the same symbol and import
// parsers the brain's code graph uses.

const INDEX_VERSION = 1
const MAX_INDEXED_FILES = 20_000
const MAX_TOTAL_BYTES = 128 * 1024 * 1024
// Every distinct term costs roughly fourteen bytes in the persisted cache, so a
// twenty-thousand file monorepo would write hundreds of megabytes without a cap.
const MAX_TERMS_PER_FILE = 192
const MAX_IDENTIFIERS_SCANNED = 200_000

// The tokenizer (BrainLexical) is shared with Vector's brain, so a request reads the same way when it ranks files and
// when it ranks memory.

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

// BrainCode.EXCLUDED mirrors the exclusion set in context-budget.ts. The two
// must stay in sync or the pack and the ranking would disagree about what the
// project contains.

export type SymbolKind = BrainCode.SymbolKind

export type IndexedSymbol = BrainCode.Declaration

export type IndexedFile = {
  path: string
  bytes: number
  modifiedAt: number
  estimatedTokens: number
  language: BrainCode.Language
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

const EXPLICIT_PATH_PATTERN = /[A-Za-z0-9_@./-]+\.[A-Za-z0-9]{1,8}/g

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

  const lookup = BrainCode.lookup(files.map((file) => file.path))
  for (const file of files) file.dependencies = BrainCode.dependencies(file.path, file.imports, file.language, lookup)

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
        if (!BrainCode.EXCLUDED.has(entry.name)) await visit(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      if (!BrainCode.language(entry.name)) continue
      const info = await stat(fullPath).catch(() => undefined)
      if (!info || info.size > BrainCode.LIMIT.bytes) continue
      output.push({ path: slash(relative(root, fullPath)), bytes: info.size, modifiedAt: info.mtimeMs })
    }
  }
  await visit(root)
  return output.sort((left, right) => left.path.localeCompare(right.path))
}

function parseFile(candidate: FileCandidate, text: string): IndexedFile {
  const language = BrainCode.language(candidate.path) ?? "text"
  const symbols = BrainCode.symbols(text, language)
  const terms = extractTerms(text, candidate.path, symbols)
  return {
    path: candidate.path,
    bytes: candidate.bytes,
    modifiedAt: candidate.modifiedAt,
    estimatedTokens: Math.max(1, Math.ceil((text.length || candidate.bytes) / 4)),
    language,
    imports: BrainCode.imports(text, language),
    dependencies: [],
    symbols,
    tokens: terms.tokens,
    tokenCount: terms.tokenCount,
  }
}

function slash(path: string) {
  return path.replaceAll("\\", "/")
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
    if (term.length < 3 || term.length > 40 || BrainLexical.STOP_TERMS.has(term) || /\s/.test(term)) return
    tokens.set(term, (tokens.get(term) ?? 0) + weight)
    tokenCount += weight
  }

  let scanned = 0
  for (const match of text.matchAll(BrainLexical.IDENTIFIER_PATTERN)) {
    if (scanned >= MAX_IDENTIFIERS_SCANNED) break
    scanned += 1
    const identifier = match[0]
    const lower = identifier.toLowerCase()
    add(lower, 1)
    for (const part of BrainLexical.splitIdentifier(identifier)) {
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
    for (const part of BrainLexical.splitIdentifier(symbol.name)) {
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

async function gitCoChange(root: string, known: ReadonlySet<string>, previous: RepoIndex | undefined) {
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

  const log = await git(root, ["log", "--no-merges", "--format=%H", "--name-only", "-n", String(BrainCode.LIMIT.commits)])
  // git reports paths from the repository root, which is not the project root
  // when Vector has a subdirectory of a larger repository open.
  const history = BrainCode.coChange(log, (value) => {
    const candidate = slash(relative(realRoot, join(topLevel, value)))
    return known.has(candidate) ? candidate : undefined
  })
  return { head, coChange: history.pairs, commits: history.commits }
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
  const terms = BrainLexical.queryTerms(query)
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
    const parts = BrainLexical.splitIdentifier(symbol.name).map((part) => part.toLowerCase())
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
