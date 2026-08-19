import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { GuardrailCheckResult, WorkspaceValidationReport } from "./workspace-guardrails"

// Failure memory is durable, per-repository knowledge: which checks fail here,
// which repair actually worked, which checks flip without anyone editing code.
// It lives in the project's own .vector directory next to team.json and
// BRAIN.md rather than in electron-store because the data is only meaningful
// relative to one working tree: an electron-store blob keyed by absolute path
// silently orphans itself the moment the user moves or renames the project, is
// buried in an app-private file the user cannot read, and cannot travel with a
// clone. A plain JSON file next to the code it describes stays inspectable with
// `cat`, erasable with `rm`, and matches the file-on-disk posture local-memory
// already sets for the user's own memory.

const MEMORY_VERSION = 1
const MAX_RECORDS = 200
const MAX_FILES_PER_RECORD = 40
const MAX_SIGNATURE_LINES = 12
const MAX_SIGNATURE_CHARS = 2_000
const MAX_GUIDANCE_CHARS = 1_200
const MAX_GUIDANCE_RECORDS = 3

export type FailureRepair = {
  at: string
  files: string[]
  description: string
}

export type FailureSignatureRecord = {
  signature: string
  checkId: string
  checkLabel: string
  firstSeen: string
  lastSeen: string
  occurrences: number
  // How often each file was in the workspace change set while this signature
  // was failing. This is what answers "touching A usually breaks B".
  changedFiles: Record<string, number>
  // The outcome and change-set fingerprint at the last observation. Flakiness
  // is a transition between the two outcomes with an identical fingerprint, so
  // both have to survive across runs and across app restarts.
  lastOutcome: "failed" | "passed"
  lastChangeKey: string
  lastChangedFiles: string[]
  flakyPasses: number
  flakyFailures: number
  repair?: FailureRepair
}

export type FailureMemory = {
  version: number
  updatedAt: string
  records: FailureSignatureRecord[]
}

export type ValidationRunInput = {
  report: WorkspaceValidationReport
  changedFiles: string[]
  // The workspace diff at the moment the checks ran. See changeKeyFor.
  diff: string
  // Directories stripped from failure output before fingerprinting, normally
  // the isolated workspace path and the source project path, so the same
  // failure observed from two different working trees collapses to one
  // signature instead of two.
  roots?: string[]
  // What the agent said it changed in the repair pass this run is verifying.
  // Recorded verbatim so the next run can be told what worked, not re-derive it.
  repairDescription?: string
}

const ANSI_PATTERN = /\u001B\[[0-9;]*[A-Za-z]/g

// Lines worth fingerprinting. Runner banners, progress counters and summary
// footers move between runs for reasons that have nothing to do with the
// failure, so the signature is built from the diagnostic lines when there are
// any and only falls back to the whole output when there are none.
const SALIENT_PATTERN =
  /error|fail|cannot|could not|unexpected|expected|missing|not assignable|not found|undefined|panic|exception|traceback|assert|refus|✗|×/i

// Two runs of the same failure never produce byte-identical output: the
// workspace lives somewhere else, line and column numbers drift as the agent
// edits around the error, and every runner stamps its own durations and ids.
// Collapsing exactly those axes — and nothing that carries meaning, such as a
// TS error code or a message body — is what makes a failure identifiable across
// runs. Everything else in this module is built on it.
export function normaliseFailureOutput(output: string, roots: string[] = []) {
  const rooted = roots
    .filter((root) => root.trim().length > 1)
    .sort((a, b) => b.length - a.length)
    .reduce(
      (text, root) => text.split(`${root}/`).join("").split(`${root}\\`).join("").split(root).join(""),
      output.replaceAll("\r\n", "\n").replace(ANSI_PATTERN, ""),
    )
  const lines = rooted
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<time>")
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<time>")
    .replace(/\b\d+(?:[.,]\d+)?\s?(?:ms|µs|us|ns|s|m|h|secs?|seconds?|mins?|minutes?|millis(?:econds)?)\b/g, "<dur>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    // Requiring a digit keeps ordinary English words that happen to be spelled
    // out of a-f, such as "defaced", from being mistaken for a hash.
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi, "<hex>")
    // An absolute path collapses to its basename: the leading directories are
    // the run-specific part, and the roots stripped above already preserved the
    // in-repo path for anything inside the workspace.
    .replace(/(?<![\w.~])(?:[A-Za-z]:)?[\\/](?:[\w.@+~-]+[\\/])+[\w.@+~-]+/g, (match) => match.split(/[\\/]/).pop() ?? "")
    .replace(/\(\d+,\d+\)/g, "(L,C)")
    .replace(/:\d+:\d+/g, ":L:C")
    .replace(/:\d+(?=[\s)\],:]|$)/g, ":L")
    .replace(/\b(line|column|col)\s+\d+/gi, "$1 L")
    .replace(/\b\d{4,}\b/g, "<n>")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
  const salient = lines.filter((line) => SALIENT_PATTERN.test(line))
  return (salient.length ? salient : lines)
    .slice(0, MAX_SIGNATURE_LINES)
    .join("\n")
    .slice(0, MAX_SIGNATURE_CHARS)
}

export function failureSignature(checkId: string, output: string, roots: string[] = []) {
  return createHash("sha256")
    .update(`${checkId}\n${normaliseFailureOutput(output, roots)}`)
    .digest("hex")
    .slice(0, 20)
}

// The file list alone cannot tell a repair from a no-op, because a repair
// almost always edits a file that is already in the diff. Hashing the diff
// itself is what makes "nothing changed" actually mean nothing changed, which
// is the entire basis of flakiness detection.
export function changeKeyFor(changedFiles: string[], diff: string) {
  return createHash("sha256")
    .update(diff.trim() || [...changedFiles].sort().join("\n"))
    .digest("hex")
    .slice(0, 20)
}

export function failureMemoryPath(projectPath: string) {
  return join(projectPath, ".vector", "failure-memory.json")
}

export function isFlakySignature(record: FailureSignatureRecord) {
  return record.flakyPasses + record.flakyFailures > 0
}

export async function readFailureMemory(projectPath: string): Promise<FailureMemory> {
  const raw = await readFile(failureMemoryPath(projectPath), "utf8").catch(() => "")
  const parsed = ((): { updatedAt?: unknown; records?: unknown } | undefined => {
    if (!raw.trim()) return undefined
    try {
      return JSON.parse(raw)
    } catch {
      return undefined
    }
  })()
  if (!Array.isArray(parsed?.records)) return { version: MEMORY_VERSION, updatedAt: "", records: [] }
  return {
    version: MEMORY_VERSION,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    records: parsed.records.flatMap((item) => reviveRecord(item)),
  }
}

// This store is a plain file inside the user's repository, which is the point
// of keeping it there: it can be read, hand edited, half written by an older
// build, or merged in from a clone. Everything downstream indexes straight into
// these arrays and objects, so a record only survives this function once every
// field it declares actually exists. Checking the name alone would let a
// half-written record through and crash the repair loop reading it back.
function reviveRecord(item: unknown): FailureSignatureRecord[] {
  const record = item as Partial<FailureSignatureRecord> | null
  if (typeof record?.signature !== "string" || typeof record.checkId !== "string") return []
  return [
    {
      signature: record.signature,
      checkId: record.checkId,
      checkLabel: typeof record.checkLabel === "string" ? record.checkLabel : record.checkId,
      firstSeen: typeof record.firstSeen === "string" ? record.firstSeen : "",
      lastSeen: typeof record.lastSeen === "string" ? record.lastSeen : "",
      occurrences: Number.isFinite(record.occurrences) ? Number(record.occurrences) : 1,
      changedFiles: Object.fromEntries(
        Object.entries(record.changedFiles ?? {}).filter(([, count]) => Number.isFinite(count)),
      ),
      lastOutcome: record.lastOutcome === "passed" ? "passed" : "failed",
      lastChangeKey: typeof record.lastChangeKey === "string" ? record.lastChangeKey : "",
      lastChangedFiles: Array.isArray(record.lastChangedFiles)
        ? record.lastChangedFiles.filter((file) => typeof file === "string")
        : [],
      flakyPasses: Number.isFinite(record.flakyPasses) ? Number(record.flakyPasses) : 0,
      flakyFailures: Number.isFinite(record.flakyFailures) ? Number(record.flakyFailures) : 0,
      ...(record.repair
        ? {
            repair: {
              at: typeof record.repair.at === "string" ? record.repair.at : "",
              files: Array.isArray(record.repair.files)
                ? record.repair.files.filter((file) => typeof file === "string")
                : [],
              description: typeof record.repair.description === "string" ? record.repair.description : "",
            },
          }
        : {}),
    },
  ]
}

export async function recordValidationRun(projectPath: string, input: ValidationRunInput): Promise<FailureMemory> {
  return serialiseWrites(projectPath, async () => {
    const previous = await readFailureMemory(projectPath)
    const memory = {
      version: MEMORY_VERSION,
      updatedAt: new Date().toISOString(),
      records: evictExcess(applyRun(previous, input)),
    }
    // A repository whose checks have never failed has nothing to remember, so
    // do not leave an empty file in every project the user ever opens.
    if (!memory.records.length && !previous.updatedAt) return memory
    const target = failureMemoryPath(projectPath)
    await mkdir(join(projectPath, ".vector"), { recursive: true })
    // Rename is atomic within a filesystem, so a crash mid-write leaves the
    // previous memory readable instead of a truncated file nothing can parse.
    const staged = `${target}.${process.pid}.tmp`
    await writeFile(staged, `${JSON.stringify(memory, null, 2)}\n`, "utf8")
    await rename(staged, target)
    return memory
  })
}

// Deletes the file rather than writing an empty one, so a user who cleared this
// repository's failure history is left with nothing to recover, exactly as
// clearing local memory behaves.
export async function clearFailureMemory(projectPath: string): Promise<FailureMemory> {
  return serialiseWrites(projectPath, async () => {
    await rm(failureMemoryPath(projectPath), { force: true })
    return readFailureMemory(projectPath)
  })
}

export async function priorFor(projectPath: string, report: WorkspaceValidationReport, roots: string[] = []) {
  return formatPriorGuidance(await readFailureMemory(projectPath), report, roots)
}

// Goes straight into a repair prompt, so it stays a handful of lines: the point
// is to stop the agent repeating a repair that already worked or chasing a
// check that fails on its own, not to hand it the whole history.
export function formatPriorGuidance(
  memory: FailureMemory,
  report: WorkspaceValidationReport,
  roots: string[] = [],
): string {
  const lines = report.checks
    .filter((check) => check.status === "failed")
    .flatMap((check) => {
      const record = memory.records.find(
        (item) => item.signature === failureSignature(check.id, check.output, roots),
      )
      if (!record) return []
      return [record]
    })
    .slice(0, MAX_GUIDANCE_RECORDS)
    .flatMap((record) => {
      const co = coFailingFiles(memory, Object.keys(record.changedFiles)[0] ?? "")
      return [
        `- ${record.checkLabel} has failed this exact way ${record.occurrences} time${record.occurrences === 1 ? "" : "s"} before in this repository (first ${record.firstSeen.slice(0, 10)}, last ${record.lastSeen.slice(0, 10)}).`,
        ...(isFlakySignature(record)
          ? [
              `  It has also flipped outcome ${record.flakyPasses + record.flakyFailures} time${record.flakyPasses + record.flakyFailures === 1 ? "" : "s"} with no file change at all, so treat it as flaky: re-run the check before you edit anything, and do not rewrite working code to chase it.`,
            ]
          : []),
        ...(record.repair
          ? [
              `  A repair that worked before touched ${record.repair.files.slice(0, 5).join(", ") || "no tracked files"}${record.repair.description ? `: ${record.repair.description.replace(/\s+/g, " ").trim().slice(0, 240)}` : "."}`,
            ]
          : []),
        ...(co.length ? [`  When this fails, these files are usually in the change set together: ${co.join(", ")}.`] : []),
      ]
    })
  if (!lines.length) return ""
  return ["Vector's memory of this repository:", ...lines].reduce(
    (text, line) => (text.length + line.length + 1 > MAX_GUIDANCE_CHARS ? text : `${text}${text ? "\n" : ""}${line}`),
    "",
  )
}

// Files that keep showing up in the change set alongside `file` while some
// signature was failing. Counts are accumulated per signature rather than per
// run, so this is a ranking heuristic and not an exact co-occurrence count.
export function coFailingFiles(memory: FailureMemory, file: string, limit = 3) {
  if (!file) return []
  const counts = memory.records
    .filter((record) => record.changedFiles[file])
    .flatMap((record) => Object.entries(record.changedFiles).filter(([other]) => other !== file))
    .reduce<Record<string, number>>((totals, [other, count]) => ({ ...totals, [other]: (totals[other] ?? 0) + count }), {})
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([other]) => other)
}

function applyRun(memory: FailureMemory, input: ValidationRunInput) {
  const context = {
    at: new Date().toISOString(),
    changeKey: changeKeyFor(input.changedFiles, input.diff),
    changedFiles: input.changedFiles,
    roots: input.roots ?? [],
    repairDescription: input.repairDescription ?? "",
  }
  return input.report.checks.reduce((records, check) => {
    if (check.status === "skipped") return records
    if (check.status === "failed") return applyFailure(records, check, context)
    return applyPass(records, check, context)
  }, memory.records)
}

type RunContext = {
  at: string
  changeKey: string
  changedFiles: string[]
  roots: string[]
  repairDescription: string
}

function applyFailure(records: FailureSignatureRecord[], check: GuardrailCheckResult, context: RunContext) {
  const signature = failureSignature(check.id, check.output, context.roots)
  const existing = records.find((item) => item.signature === signature)
  if (!existing)
    return [
      ...records,
      {
        signature,
        checkId: check.id,
        checkLabel: check.label,
        firstSeen: context.at,
        lastSeen: context.at,
        occurrences: 1,
        changedFiles: mergeFileCounts({}, context.changedFiles),
        lastOutcome: "failed" as const,
        lastChangeKey: context.changeKey,
        lastChangedFiles: context.changedFiles.slice(0, MAX_FILES_PER_RECORD),
        flakyPasses: 0,
        flakyFailures: 0,
      },
    ]
  return records.map((item) =>
    item.signature === signature
      ? {
          ...item,
          checkLabel: check.label,
          lastSeen: context.at,
          occurrences: item.occurrences + 1,
          changedFiles: mergeFileCounts(item.changedFiles, context.changedFiles),
          lastOutcome: "failed" as const,
          lastChangeKey: context.changeKey,
          lastChangedFiles: context.changedFiles.slice(0, MAX_FILES_PER_RECORD),
          // Failing again after it passed with nothing edited in between means
          // the outcome does not depend on the code, which is the definition of
          // flaky the repair loop needs.
          flakyFailures:
            item.flakyFailures + (item.lastOutcome === "passed" && item.lastChangeKey === context.changeKey ? 1 : 0),
        }
      : item,
  )
}

function applyPass(records: FailureSignatureRecord[], check: GuardrailCheckResult, context: RunContext) {
  return records.map((item) => {
    // A passing check clears every signature still open under it, because one
    // check run can emit several diagnostics and a repair may resolve all of
    // them at once.
    if (item.checkId !== check.id || item.lastOutcome !== "failed") return item
    if (item.lastChangeKey === context.changeKey)
      return {
        ...item,
        lastOutcome: "passed" as const,
        lastSeen: context.at,
        flakyPasses: item.flakyPasses + 1,
      }
    const touched = context.changedFiles.filter((file) => !item.lastChangedFiles.includes(file))
    return {
      ...item,
      lastOutcome: "passed" as const,
      lastSeen: context.at,
      lastChangeKey: context.changeKey,
      lastChangedFiles: context.changedFiles.slice(0, MAX_FILES_PER_RECORD),
      repair: {
        at: context.at,
        files: (touched.length ? touched : context.changedFiles).slice(0, MAX_FILES_PER_RECORD),
        description: context.repairDescription,
      },
    }
  })
}

function mergeFileCounts(existing: Record<string, number>, files: string[]) {
  return Object.fromEntries(
    Object.entries(
      files.slice(0, 200).reduce<Record<string, number>>(
        (counts, file) => ({ ...counts, [file]: (counts[file] ?? 0) + 1 }),
        { ...existing },
      ),
    )
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_FILES_PER_RECORD),
  )
}

function evictExcess(records: FailureSignatureRecord[]) {
  if (records.length <= MAX_RECORDS) return records
  // A signature with a known repair is the whole reason this store exists, so
  // it outranks any raw occurrence count. Everything else is kept by how often
  // and then how recently the failure was actually seen.
  return [...records]
    .sort(
      (a, b) =>
        Number(Boolean(b.repair)) - Number(Boolean(a.repair)) ||
        b.occurrences - a.occurrences ||
        b.lastSeen.localeCompare(a.lastSeen),
    )
    .slice(0, MAX_RECORDS)
}

// Every parallel workspace for a project writes back to the same file when its
// guardrails finish, and sixteen of them can finish at once. Chaining the
// read-modify-write per project is what stops one run's record from silently
// overwriting another's.
const writeChains = new Map<string, Promise<unknown>>()

function serialiseWrites<T>(projectPath: string, work: () => Promise<T>): Promise<T> {
  const next = (writeChains.get(projectPath) ?? Promise.resolve()).then(work, work)
  writeChains.set(
    projectPath,
    next.catch(() => undefined),
  )
  return next
}
