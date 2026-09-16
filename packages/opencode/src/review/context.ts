// What the reviewer gets beyond the diff (section 3.5): call sites of the symbols a change declares, recent history
// and blame of the lines it rewrites, and, in CI, the repository instructions from the base commit. Vector's code
// gathers all of it with git, so the reviewer needs no shell.

import { Effect } from "effect"
import { Git } from "@/git"
import type { DiffFile } from "@opencode-ai/core/review/diff"
import type { HistoryEntry, RelatedCode } from "@opencode-ai/core/review/prompt"
import { changedSymbols } from "@opencode-ai/core/review/symbols"

const MAX_SYMBOLS = 10
const MAX_HITS = 15
const MAX_HIT_CHARS = 200
const MAX_HISTORY_FILES = 10
const MAX_BLAME_RANGES = 20
const MAX_INSTRUCTION_BYTES = 16 * 1024
const INSTRUCTION_FILES = [["AGENTS.md", "CLAUDE.md"], [".vector/RULES.md"]]

// Call sites of up to 10 symbols declared in added lines, 15 hits each, from `git grep` at the head. Ignored paths
// are excluded twice: as pathspecs, which keeps the output small, and by `ignored`, which matches the review's own
// classification exactly.
export const relatedCode = Effect.fn("ReviewContext.relatedCode")(function* (input: {
  directory: string
  head: string
  files: DiffFile[]
  ignore?: string[] // globs to leave out, such as the default ignores and review.json `ignore`
  ignored?: (path: string) => boolean
}) {
  const git = yield* Git.Service
  if (input.head.startsWith("-")) return []
  const excludes = (input.ignore ?? []).map((glob) => `:(exclude,glob)${glob}`)
  const found = yield* Effect.forEach(
    changedSymbols(input.files, MAX_SYMBOLS),
    Effect.fnUntraced(function* (symbol) {
      const result = yield* git.run(
        [
          "grep",
          "-n",
          "-w",
          "-F",
          "-I",
          "--no-color",
          "--full-name",
          "-z",
          "-e",
          symbol.name,
          input.head,
          "--",
          ".",
          ...excludes,
        ],
        { cwd: input.directory, maxOutputBytes: 1024 * 1024 },
      )
      // Exit 1 means no match.
      if (result.exitCode !== 0) return []
      const hits = result
        .text()
        .split("\n")
        .flatMap((line) => {
          const hit = parseGrepLine(line, input.head)
          if (!hit || input.ignored?.(hit.path)) return []
          if (hit.path === symbol.path && hit.line === symbol.line) return []
          return [hit]
        })
        .slice(0, MAX_HITS)
      return hits.length ? [{ symbol: symbol.name, path: symbol.path, hits } satisfies RelatedCode] : []
    }),
    { concurrency: 4 },
  )
  return found.flat()
})

// For the 10 largest changed files: the last 5 commits, and blame at the base for up to 20 ranges this change
// removes or rewrites. In a shallow clone, lines older than the fetched history are labelled "before <boundary>".
export const history = Effect.fn("ReviewContext.history")(function* (input: {
  directory: string
  base: string
  files: DiffFile[]
}) {
  const git = yield* Git.Service
  if (input.base.startsWith("-")) return []
  const cwd = input.directory
  const shallow = (yield* git.run(["rev-parse", "--is-shallow-repository"], { cwd })).text().trim() === "true"
  // A shallow clone's boundary commits look like root commits.
  const boundaries = shallow
    ? new Set((yield* git.run(["rev-list", "--max-parents=0", input.base], { cwd })).text().split("\n").filter(Boolean))
    : new Set<string>()
  const files = input.files
    .filter((file) => file.status !== "added" && !file.binary)
    .toSorted((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
    .slice(0, MAX_HISTORY_FILES)
  const ranges = files
    .flatMap((file) => removedRanges(file).map((range) => ({ file, range })))
    .slice(0, MAX_BLAME_RANGES)

  const entries = yield* Effect.forEach(
    files,
    Effect.fnUntraced(function* (file) {
      const before = file.oldPath ?? file.path
      const log = yield* git.run(
        ["log", "-n", "5", "--no-color", "--date=short", "--format=%h %an %ad %s", input.base, "--", before],
        { cwd },
      )
      const blame = yield* Effect.forEach(
        ranges.filter((entry) => entry.file === file),
        (entry) =>
          git
            .run(
              [
                "blame",
                "--porcelain",
                "--root",
                "--no-textconv",
                "-L",
                `${entry.range[0]},${entry.range[1]}`,
                input.base,
                "--",
                before,
              ],
              { cwd },
            )
            .pipe(Effect.map((result) => (result.exitCode === 0 ? formatBlame(result.text(), boundaries) : []))),
      )
      const text = [
        ...(log.exitCode === 0 && log.text().trim() ? ["Recent commits:", log.text().trim()] : []),
        ...(blame.flat().length
          ? ["Blame at the base for the lines this change removes or rewrites:", ...blame.flat()]
          : []),
      ].join("\n")
      return text ? [{ path: before, text } satisfies HistoryEntry] : []
    }),
    { concurrency: 4 },
  )
  return entries.flat()
})

// AGENTS.md (or CLAUDE.md) and .vector/RULES.md from the base commit, 16 KB each. CI passes a reader for the
// contents API; the default reads the base commit with git.
export const baseInstructions = Effect.fn("ReviewContext.baseInstructions")(function* (input: {
  directory: string
  base: string
  read?: (path: string) => Effect.Effect<string | undefined>
}) {
  const git = yield* Git.Service
  const read =
    input.read ??
    ((file: string) =>
      git
        .run(["cat-file", "blob", `${input.base}:${file}`], { cwd: input.directory })
        .pipe(
          Effect.map((result) => (result.exitCode === 0 && !result.stdout.includes(0) ? result.text() : undefined)),
        ))
  if (!input.read && input.base.startsWith("-")) return undefined
  const sections = yield* Effect.forEach(
    INSTRUCTION_FILES,
    Effect.fnUntraced(function* (names) {
      for (const name of names) {
        const text = (yield* read(name))?.trim()
        if (text) return [`## ${name}\n${capBytes(text, MAX_INSTRUCTION_BYTES)}`]
      }
      return []
    }),
  )
  return sections.flat().join("\n\n") || undefined
})

// Everything above for one review. Instructions come from the base only in CI; locally the engine loads the user's
// instructions as usual.
export const gather = Effect.fn("ReviewContext.gather")(function* (input: {
  directory: string
  base: string
  head: string
  files: DiffFile[]
  ignore?: string[]
  ignored?: (path: string) => boolean
  instructions?: boolean | ((path: string) => Effect.Effect<string | undefined>)
}) {
  const [related, past, instructions] = yield* Effect.all(
    [
      relatedCode(input),
      history(input),
      input.instructions
        ? baseInstructions({
            directory: input.directory,
            base: input.base,
            read: typeof input.instructions === "function" ? input.instructions : undefined,
          })
        : Effect.succeed(undefined),
    ],
    { concurrency: 3 },
  )
  return { related, history: past, ...(instructions ? { instructions } : {}) }
})

// `<rev>:<path>\0<line>\0<text>` with -z; older git writes `<rev>:<path>\0<line>:<text>`.
function parseGrepLine(line: string, rev: string) {
  const [where, second, ...rest] = line.split("\0")
  if (!where?.startsWith(rev + ":") || second === undefined) return undefined
  const path = where.slice(rev.length + 1)
  const match = rest.length ? [second, rest.join("\0")] : /^(\d+):(.*)$/.exec(second)?.slice(1)
  const number = Number(match?.[0])
  if (!path || !Number.isInteger(number) || number < 1) return undefined
  return { path, line: number, text: (match?.[1] ?? "").trim().slice(0, MAX_HIT_CHARS) }
}

// Base line ranges of each run of removed lines.
function removedRanges(file: DiffFile): [number, number][] {
  return file.hunks.flatMap((hunk) =>
    hunk.lines.reduce<[number, number][]>((out, line) => {
      if (line.kind !== "del") return out
      const last = out.at(-1)
      if (last && last[1] === line.oldLine! - 1) last[1] = line.oldLine!
      else out.push([line.oldLine!, line.oldLine!])
      return out
    }, []),
  )
}

// Porcelain blame, grouped into runs of lines from the same commit: "L40-45 a1b2c3d Alice 2026-08-30 Add rotation".
function formatBlame(text: string, boundaries: Set<string>): string[] {
  const commits = new Map<string, { author?: string; time?: number; summary?: string }>()
  const lines: { sha: string; line: number }[] = []
  let current: string | undefined
  for (const raw of text.split("\n")) {
    const header = /^([0-9a-f]{40,64}) \d+ (\d+)/.exec(raw)
    if (header) {
      current = header[1]
      lines.push({ sha: current, line: Number(header[2]) })
      if (!commits.has(current)) commits.set(current, {})
      continue
    }
    const info = current ? commits.get(current) : undefined
    if (!info) continue
    if (raw.startsWith("author ")) info.author = raw.slice(7)
    else if (raw.startsWith("author-time ")) info.time = Number(raw.slice(12))
    else if (raw.startsWith("summary ")) info.summary = raw.slice(8)
  }
  const runs = lines.reduce<{ sha: string; from: number; to: number }[]>((out, entry) => {
    const last = out.at(-1)
    if (last && last.sha === entry.sha && last.to === entry.line - 1) last.to = entry.line
    else out.push({ sha: entry.sha, from: entry.line, to: entry.line })
    return out
  }, [])
  return runs.map((run) => {
    const where = run.from === run.to ? `L${run.from}` : `L${run.from}-${run.to}`
    if (boundaries.has(run.sha)) return `${where} before \`${run.sha.slice(0, 7)}\``
    const info = commits.get(run.sha) ?? {}
    const date = info.time ? new Date(info.time * 1000).toISOString().slice(0, 10) : ""
    return [where, run.sha.slice(0, 7), info.author, date, info.summary].filter(Boolean).join(" ")
  })
}

function capBytes(text: string, limit: number) {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= limit) return text
  return new TextDecoder().decode(bytes.slice(0, limit)).replace(/�$/, "") + "\n…(truncated)"
}

export * as ReviewContext from "./context"
