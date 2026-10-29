import path from "node:path"
import os from "node:os"
import { createHash, randomUUID } from "node:crypto"
import {
  chmod,
  appendFile,
  open,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  statfs,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { Cause, Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { createTwoFilesPatch, diffLines } from "diff"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { KeyedMutex } from "@vectordevai/core/effect/keyed-mutex"
import { Global } from "@vectordevai/core/global"
import { FSUtil } from "@vectordevai/core/fs-util"
import { IsolationCopy } from "@vectordevai/core/isolation/copy"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { FileSystem } from "@vectordevai/core/filesystem"
import { Watcher } from "@vectordevai/core/filesystem/watcher"
import { InstanceRef } from "@/effect/instance-ref"
import { Git } from "@/git"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FileLock } from "@/tool/file-lock"
import { TaskClaims } from "./claims"
import { TaskPlace } from "./place"
import { IsolationBase } from "./isolation-base"
import type { InstanceContext } from "@/project/instance-context"
import type { Task } from "@vectordevai/schema/task"

export class IsolationError extends Schema.TaggedErrorClass<IsolationError>()("TaskIsolation.Error", {
  code: Schema.String,
  message: Schema.String,
  conflicts: Schema.optional(Schema.Array(Schema.String)),
}) {}

const AgentResolution = Schema.Struct({
  name: Schema.String,
  model: Schema.optional(Schema.Unknown),
  permission: Schema.Unknown,
})
const Change = Schema.Struct({
  path: Schema.String,
  status: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  binary: Schema.Boolean,
})
export const Record = Schema.Struct({
  version: Schema.Literal(1),
  projectID: Schema.String,
  taskID: Schema.String,
  parentSessionID: Schema.String,
  parentDirectory: Schema.String,
  homeDirectory: Schema.String,
  directory: Schema.String,
  mode: Schema.Literals(["worktree", "copy"]),
  state: Schema.String,
  title: Schema.String,
  agent: AgentResolution,
  attempt: Schema.Number,
  createdAt: Schema.Number,
  branch: Schema.optional(Schema.String),
  gitDirectory: Schema.optional(Schema.String),
  gitCommonDirectory: Schema.optional(Schema.String),
  seed: Schema.optional(Schema.String),
  unstackedSeed: Schema.optional(Schema.String),
  reviewBase: Schema.optional(Schema.String),
  patchBase: Schema.optional(Schema.String),
  copyBase: Schema.optional(Schema.String),
  copyStacked: Schema.optional(Schema.Boolean),
  stackedIncluded: Schema.optional(Schema.Boolean),
  savedPatch: Schema.optional(Schema.String),
  tip: Schema.optional(Schema.String),
  settledAttempt: Schema.optional(Schema.Number),
  links: Schema.Array(Schema.String),
  skipped: Schema.Array(Schema.String),
  initialSkipped: Schema.optional(Schema.Array(Schema.String)),
  largeBaseline: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ blob: Schema.String, hash: Schema.String })),
  ),
  stacked: Schema.Array(Schema.String),
  merged: Schema.Array(Schema.String),
  files: Schema.Array(Change),
  error: Schema.optional(Schema.String),
  mergeStartedAt: Schema.optional(Schema.Number),
  checkpoint: Schema.optional(Schema.String),
  mergeCompleted: Schema.optional(Schema.Boolean),
  mergeable: Schema.optional(Schema.String),
  mergeKey: Schema.optional(Schema.String),
  deleted: Schema.optional(Schema.Boolean),
})
export type Record = Schema.Schema.Type<typeof Record>
const decode = Schema.decodeUnknownSync(Record)

/** Injectable size thresholds keep boundary tests small; production defaults match the isolation contract. */
export const Limits = Context.Reference("TaskIsolation.Limits", {
  defaultValue: () => ({
    fileBytes: 50 * 1024 * 1024,
    minFreeBytes: 1024 ** 3,
    copyBytes: 1024 ** 3,
    copyFiles: 20_000,
    patchBytes: 256 * 1024,
  }),
})

type Expected = Pick<Agent.Info, "name" | "model" | "permission">
export type CheckInput = { parentSessionID: string; agent: Expected; resumeID?: string }
export type ReserveInput = CheckInput & {
  taskID: string
  title: string
  attempt?: number
  dependsOn?: readonly string[]
}
export type By =
  | { kind: "owner" }
  | {
      kind: "agent"
      sessionID: string
      ask: (input: {
        permission: "edit"
        patterns: string[]
        always: string[]
        metadata: { diff: string }
      }) => Effect.Effect<void, unknown>
      assertWritable: (input: { files: string[] }) => Effect.Effect<void, unknown>
      assertExternalDirectory: (file: string) => Effect.Effect<unknown, unknown>
    }
export type MergeInput = {
  taskID: string
  files?: readonly string[]
  force?: boolean
  includeStacked?: boolean
  by: By
}
type Blob = { mode: string; bytes: Buffer } | undefined
type Checkpoint = {
  files: { path: string; existed: boolean; symlink?: string; mode?: number }[]
  selected: readonly string[]
  phase: "prepared" | "written"
}

const mutex = KeyedMutex.makeUnsafe<string>()
const swept = new Set<string>()
const active = new Map<string, InstanceContext>()
const queued = new Set<string>()
const err = (code: string, message: string, conflicts?: string[]) =>
  new IsolationError({ code, message, ...(conflicts ? { conflicts } : {}) })
const error = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)))
const io = <A>(body: () => Promise<A>) => Effect.tryPromise({ try: body, catch: error })
const missing = (cause: unknown) => ["ENOENT", "ENOTDIR"].includes((cause as NodeJS.ErrnoException)?.code ?? "")
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const nuls = (bytes: Buffer | string) => bytes.toString().split("\0").filter(Boolean)
const safeID = (id: string) => /^[a-zA-Z0-9_-]+$/.test(id)
const relative = (file: string) =>
  !!file &&
  !file.includes("\0") &&
  !path.isAbsolute(file) &&
  !path.win32.isAbsolute(file) &&
  !/^[a-z]:/i.test(file) &&
  !file.split(/[\\/]/).some((part) => part === "." || part === ".." || part.toLowerCase() === ".git" || part === "")
const inside = (root: string, file: string) => {
  const value = path.relative(root, file)
  return value === "" || (!path.isAbsolute(value) && value !== ".." && !value.startsWith(`..${path.sep}`))
}
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  )
const resolution = (agent: Expected) => ({
  name: agent.name,
  ...(agent.model ? { model: agent.model } : {}),
  permission: agent.permission,
})
const paths = (projectID: string, taskID: string) => {
  if (!safeID(projectID) || !safeID(taskID)) throw err("registry", "Invalid isolation registry identifier.")
  const registry = path.join(Global.Path.data, "task-isolation", projectID, taskID)
  return {
    registry,
    file: path.join(registry, "record.json"),
    directory: path.join(Global.Path.data, "task-worktree", projectID, taskID),
    branch: `vector/subagent/${taskID}`,
  }
}

/** Every registry ancestor is a directory, never a link. The final JSON is a private ordinary file. */
async function guarded(file: string, root = Global.Path.data) {
  if (!inside(path.resolve(root), path.resolve(file))) throw err("registry", "Isolation path leaves its data root.")
  for (const name of [
    root,
    ...path
      .relative(root, file)
      .split(path.sep)
      .map((_part, index, parts) => path.join(root, ...parts.slice(0, index + 1))),
  ]) {
    const info = await lstat(name).catch((cause) => {
      if (missing(cause)) return undefined
      throw cause
    })
    if (info?.isSymbolicLink() || (info?.isFile() && info.nlink !== 1))
      throw err("registry", "Isolation data cannot be a symbolic or hard link.")
    if (name !== file && info && !info.isDirectory())
      throw err("registry", "Isolation registry ancestor is not a directory.")
  }
}

async function privateJSON(file: string, value: unknown) {
  await guarded(file)
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await chmod(path.dirname(file), 0o700)
  const temp = `${file}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 })
  await rename(temp, file).catch(async (cause) => {
    await rm(temp, { force: true })
    throw cause
  })
}

async function privateTree(directory: string) {
  await guarded(directory)
  await chmod(directory, 0o700)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      await privateTree(file)
      continue
    }
    await chmod(file, 0o600)
  }
}

async function readRecord(ctx: InstanceContext, taskID: string): Promise<Record> {
  const expected = paths(ctx.project.id, taskID)
  await guarded(expected.file)
  const record = decode(JSON.parse(await readFile(expected.file, "utf8")))
  if (
    record.taskID !== taskID ||
    record.projectID !== ctx.project.id ||
    record.directory !== expected.directory ||
    record.branch !== (record.mode === "worktree" ? expected.branch : undefined) ||
    FileLock.key(record.homeDirectory) !== FileLock.key(ctx.directory) ||
    FileLock.key(record.parentDirectory) !==
      FileLock.key(ctx.worktree === path.parse(ctx.worktree).root ? ctx.directory : ctx.worktree) ||
    !record.files.every((file) => relative(file.path)) ||
    !record.links.every(relative) ||
    (record.initialSkipped !== undefined && !record.initialSkipped.every(relative)) ||
    (record.largeBaseline !== undefined &&
      Object.entries(record.largeBaseline).some(
        ([file, value]) =>
          !relative(file) || !/^[a-f0-9]{40,64}$/.test(value.blob) || !/^[a-f0-9]{64}$/.test(value.hash),
      )) ||
    !record.merged.every(relative) ||
    !record.stacked.every(safeID) ||
    [record.seed, record.tip, record.reviewBase, record.patchBase, record.unstackedSeed].some(
      (ref) => ref !== undefined && !/^[a-f0-9]{40,64}$/.test(ref),
    ) ||
    (record.copyBase !== undefined && (!safeID(record.copyBase) || !record.copyBase.startsWith("base-"))) ||
    (record.savedPatch !== undefined && path.dirname(record.savedPatch) !== path.join(expected.registry, "patches"))
  )
    throw err("registry", "Isolation registry does not match the launching project.")
  return record
}
const save = (record: Record) => io(() => privateJSON(paths(record.projectID, record.taskID).file, record))
function baselinePaths(record: Record) {
  const registry = paths(record.projectID, record.taskID).registry
  return record.copyBase
    ? {
        directory: path.join(registry, record.copyBase, "files"),
        hashes: path.join(registry, record.copyBase, "hashes.json"),
      }
    : { directory: path.join(registry, "baseline"), hashes: path.join(registry, "baseline.json") }
}
const baselineHashes = (record: Record) =>
  io(async () => {
    const file = baselinePaths(record).hashes
    await guarded(file)
    const value = JSON.parse(await readFile(file, "utf8")) as { [key: string]: string }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Object.entries(value).every(([file, hash]) => relative(file) && /^[a-f0-9]{64}$/.test(hash))
    )
      throw err("registry", "Invalid copy baseline hashes.")
    const hashes: typeof value = Object.create(null)
    return Object.assign(hashes, value)
  })

/** Call-time resolution avoids introducing Worktree/InstanceStore bootstrap cycles. Tests can provide real services. */
const worktrees = Effect.fn("TaskIsolation.worktrees")(function* () {
  const { Worktree } = yield* Effect.promise(() => import("@/worktree"))
  const provided = yield* Effect.serviceOption(Worktree.Service)
  if (Option.isSome(provided)) return provided.value
  const { AppRuntime } = yield* Effect.promise(() => import("@/effect/app-runtime"))
  return yield* Effect.promise(() => AppRuntime.runPromise(Worktree.Service))
})
const instances = Effect.fn("TaskIsolation.instances")(function* () {
  const { InstanceStore } = yield* Effect.promise(() => import("@/project/instance-store"))
  const provided = yield* Effect.serviceOption(InstanceStore.Service)
  if (Option.isSome(provided)) return provided.value
  const { AppRuntime } = yield* Effect.promise(() => import("@/effect/app-runtime"))
  return yield* Effect.promise(() => AppRuntime.runPromise(InstanceStore.Service))
})

/** Cancel and join every runner/job sharing this work context BEFORE snapshot, disposal or placement retirement. */
export const quiesce = Effect.fn("TaskIsolation.quiesce")(function* (taskID: string, work: InstanceContext) {
  const [{ BackgroundJob }, { SessionRunState }, { SessionID }] = yield* Effect.promise(() =>
    Promise.all([import("@/background/job"), import("@/session/run-state"), import("@/session/schema")]),
  )
  const jobOption = yield* Effect.serviceOption(BackgroundJob.Service)
  const runOption = yield* Effect.serviceOption(SessionRunState.Service)
  const { AppRuntime } =
    Option.isNone(jobOption) || Option.isNone(runOption)
      ? yield* Effect.promise(() => import("@/effect/app-runtime"))
      : { AppRuntime: undefined }
  const jobs = Option.isSome(jobOption)
    ? jobOption.value
    : yield* Effect.promise(() => AppRuntime!.runPromise(BackgroundJob.Service))
  const runners = Option.isSome(runOption)
    ? runOption.value
    : yield* Effect.promise(() => AppRuntime!.runPromise(SessionRunState.Service))
  const descendants = TaskPlace.places().filter(
    (entry) => entry.sessionID !== taskID && FileLock.key(entry.work.directory) === FileLock.key(work.directory),
  )
  yield* Effect.forEach(descendants, (entry) => runners.cancel(SessionID.make(entry.sessionID)), {
    concurrency: "unbounded",
    discard: true,
  })
  const running = yield* jobs.list().pipe(Effect.provideService(InstanceRef, work))
  yield* Effect.forEach(
    running.filter((job) => job.id !== taskID),
    (job) => jobs.cancel(job.id).pipe(Effect.provideService(InstanceRef, work)),
    { concurrency: "unbounded", discard: true },
  )
})

export const make = Effect.gen(function* () {
  const git = yield* Git.Service
  const config = yield* Config.Service
  const agents = yield* Agent.Service
  const run = (cwd: string, args: string[], options: Omit<Git.Options, "cwd"> = {}) =>
    git.run(["-c", `core.hooksPath=${os.devNull}`, ...args], {
      ...options,
      cwd,
      env: { ...options.env, GIT_LFS_SKIP_SMUDGE: "1", LC_ALL: "C" },
    })
  const command = Effect.fn("TaskIsolation.git")(function* (
    cwd: string,
    args: string[],
    options: Omit<Git.Options, "cwd"> = {},
  ) {
    const out = yield* run(cwd, args, options)
    if (out.exitCode !== 0 || out.truncated)
      return yield* err(
        "git",
        out.stderr.toString("utf8") || "Isolation Git command failed or exceeded its output bound.",
      )
    return out.stdout
  })
  const text = (cwd: string, args: string[], options: Omit<Git.Options, "cwd"> = {}) =>
    command(cwd, args, options).pipe(Effect.map((out) => out.toString("utf8").trim()))
  const home = Effect.gen(function* () {
    const ctx = yield* TaskPlace.atHome()(InstanceRef)
    if (!ctx) return yield* err("context", "Task isolation requires a launching instance.")
    return ctx
  })
  // A record is always looked up against the active home, never against fields in session metadata.
  const get = Effect.fn("TaskIsolation.get")(function* (taskID: string) {
    const ctx = yield* home
    return yield* io(() => readRecord(ctx, taskID))
  })
  const optional = (taskID: string) =>
    get(taskID).pipe(Effect.catch((cause) => (missing(cause) ? Effect.succeed(undefined) : Effect.fail(cause))))
  const records = Effect.fn("TaskIsolation.records")(function* () {
    const ctx = yield* home
    const root = path.join(Global.Path.data, "task-isolation", ctx.project.id)
    yield* io(() => guarded(root))
    const entries = yield* io(() =>
      readdir(root).catch((cause) => {
        if (missing(cause)) return []
        throw cause
      }),
    )
    return yield* Effect.forEach(entries.filter(safeID), (id) => get(id).pipe(Effect.option)).pipe(
      Effect.map((items) => items.filter(Option.isSome).map((item) => item.value)),
    )
  })
  const lock = <A, E, R>(taskID: string, effect: Effect.Effect<A, E, R>) =>
    home.pipe(Effect.flatMap((ctx) => mutex.withLock(`${ctx.project.id}/${taskID}`)(effect)))
  const verify = Effect.fn("TaskIsolation.verify")(function* (record: Record, recoverBinding = false) {
    const current = yield* get(record.taskID)
    if (current.mode === "copy") {
      yield* io(() => guarded(current.directory))
      if ((yield* io(() => realpath(current.directory))) !== current.directory)
        return yield* err("registry", "Copy isolation directory changed identity.")
      return current
    }
    const listing = nuls(yield* command(current.parentDirectory, ["worktree", "list", "--porcelain", "-z"]))
    const entries: { directory?: string; branch?: string }[] = []
    for (const line of listing) {
      if (line.startsWith("worktree ")) entries.push({ directory: line.slice(9) })
      if (line.startsWith("branch ") && entries.length) entries[entries.length - 1]!.branch = line.slice(7)
    }
    const entry = entries.find(
      (item) => item.directory && FileLock.key(item.directory) === FileLock.key(current.directory),
    )
    if (!entry || entry.branch !== `refs/heads/${current.branch}`)
      return yield* err("registry", "Registered task worktree or reserved branch no longer matches Git.")
    yield* io(() => guarded(current.directory))
    const gitDirectory = path.resolve(current.directory, yield* text(current.directory, ["rev-parse", "--git-dir"]))
    const common = path.resolve(current.directory, yield* text(current.directory, ["rev-parse", "--git-common-dir"]))
    const branch = yield* text(current.directory, ["symbolic-ref", "--short", "HEAD"])
    const parentCommon = path.resolve(
      current.parentDirectory,
      yield* text(current.parentDirectory, ["rev-parse", "--git-common-dir"]),
    )
    const top = path.resolve(current.directory, yield* text(current.directory, ["rev-parse", "--show-toplevel"]))
    const index = path.resolve(current.directory, yield* text(current.directory, ["rev-parse", "--git-path", "index"]))
    yield* io(() => guarded(path.join(current.directory, ".git")))
    yield* io(() => guarded(gitDirectory, parentCommon))
    yield* io(() => guarded(index, gitDirectory))
    if (
      FileLock.key(top) !== FileLock.key(current.directory) ||
      FileLock.key(index) !== FileLock.key(path.join(gitDirectory, "index"))
    )
      return yield* err("registry", "The task checkout or index was redirected outside its registered Git metadata.")
    if (FileLock.key(common) !== FileLock.key(parentCommon) || branch !== current.branch)
      return yield* err(
        "registry",
        "The task checkout is no longer attached to its parent's Git repository and reserved branch.",
      )
    if (
      (!current.gitDirectory || !current.gitCommonDirectory) &&
      recoverBinding &&
      current.seed &&
      ["preparing", "running", "failed"].includes(current.state)
    ) {
      // Creation may have completed before its metadata binding reached disk. Recover only a real linked worktree
      // owned by this common-dir, with Git's own backpointer to this exact reserved checkout; a redirected .git fails.
      yield* io(() => guarded(path.join(current.directory, ".git")))
      yield* io(() => guarded(gitDirectory, parentCommon))
      const canonical = yield* io(() => realpath(gitDirectory))
      const root = yield* io(() => realpath(path.join(parentCommon, "worktrees")))
      const backpointer = yield* io(() => readFile(path.join(gitDirectory, "gitdir"), "utf8"))
      if (
        FileLock.key(path.dirname(canonical)) !== FileLock.key(root) ||
        FileLock.key(backpointer.trim()) !== FileLock.key(path.join(current.directory, ".git"))
      )
        return yield* err("registry", "Cannot recover a task Git binding from another checkout's metadata.")
      const recovered = { ...current, gitDirectory, gitCommonDirectory: common }
      yield* save(recovered)
      return recovered
    }
    if (
      !current.gitDirectory ||
      !current.gitCommonDirectory ||
      FileLock.key(gitDirectory) !== FileLock.key(current.gitDirectory) ||
      FileLock.key(common) !== FileLock.key(current.gitCommonDirectory) ||
      branch !== current.branch
    )
      return yield* err("registry", "The task checkout's Git metadata changed identity.")
    return current
  })
  const identity = Effect.fn("TaskIsolation.identity")(function* (cwd: string) {
    const name = yield* run(cwd, ["config", "user.name"])
    const email = yield* run(cwd, ["config", "user.email"])
    return {
      ...(name.exitCode !== 0 || !name.text().trim()
        ? { GIT_AUTHOR_NAME: "Vector", GIT_COMMITTER_NAME: "Vector" }
        : {}),
      ...(email.exitCode !== 0 || !email.text().trim()
        ? { GIT_AUTHOR_EMAIL: "bot@vectordev.ai", GIT_COMMITTER_EMAIL: "bot@vectordev.ai" }
        : {}),
    }
  })
  const clearIndexFlags = Effect.fn("TaskIsolation.clearIndexFlags")(function* (cwd: string, index: string) {
    const files = yield* command(cwd, ["ls-files", "-z", "--cached"], { env: { GIT_INDEX_FILE: index } })
    if (!files.length) return
    for (const flag of ["--no-assume-unchanged", "--no-skip-worktree"])
      yield* command(cwd, ["update-index", flag, "-z", "--stdin"], {
        env: { GIT_INDEX_FILE: index },
        stdin: Stream.make(files),
      })
  })
  const blobAt = Effect.fn("TaskIsolation.blobAt")(function* (record: Record, file: string) {
    const base = record.reviewBase ?? record.seed
    if (!base) return undefined
    const entry = yield* text(record.directory, ["--literal-pathspecs", "ls-tree", "-z", base, "--", file])
    const blob = entry.slice(0, entry.indexOf("\t")).split(" ")[2]
    return blob && /^[a-f0-9]{40,64}$/.test(blob) ? blob : undefined
  })
  const captureLargeBaseline = Effect.fn("TaskIsolation.captureLargeBaseline")(function* (record: Record) {
    const limits = yield* Limits
    const baseline: { [file: string]: { blob: string; hash: string } } = Object.create(null)
    const files = nuls(yield* command(record.directory, ["ls-files", "-z", "--cached"]))
    for (const file of files) {
      if (!relative(file)) return yield* err("path", "Git returned an unsafe baseline path.")
      const full = path.join(record.directory, file)
      const info = yield* io(() => lstat(full))
      if (!info.isFile() || info.size <= limits.fileBytes) continue
      if (!FSUtil.writableInside(record.directory, full))
        return yield* err("path", "An oversized baseline has an unsafe ancestor.")
      const blob = yield* blobAt(record, file)
      if (!blob) return yield* err("git", "An oversized baseline has no saved Git identity.")
      baseline[file] = { blob, hash: yield* io(() => IsolationCopy.hashFile(full)) }
    }
    return baseline
  })
  const unsupported = Effect.fn("TaskIsolation.unsupported")(function* (record: Record) {
    const limits = yield* Limits
    const files =
      record.mode === "copy"
        ? yield* io(() =>
            IsolationCopy.listProjectFiles(record.directory, record.directory, [], Number.MAX_SAFE_INTEGER),
          )
        : nuls(yield* command(record.directory, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))
    const output = new Set<string>()
    for (const file of new Set(files)) {
      if (!relative(file)) return yield* err("path", "An unsupported output has an unsafe path.")
      if (record.links.some((link) => file === link || file.startsWith(`${link}/`))) continue
      const current = yield* io(() =>
        lstat(path.join(record.directory, file)).catch((cause) => {
          if (missing(cause)) return undefined
          throw cause
        }),
      )
      if (!current?.isFile() || current.size <= limits.fileBytes) continue
      if (record.mode === "worktree") {
        const blob = yield* blobAt(record, file)
        if (!blob || !FSUtil.writableInside(record.directory, path.join(record.directory, file))) {
          output.add(file)
          continue
        }
        const baseline = record.largeBaseline?.[file]
        if (baseline?.blob === blob) {
          if ((yield* io(() => IsolationCopy.hashFile(path.join(record.directory, file)))) !== baseline.hash)
            output.add(file)
        } else if ((yield* text(record.directory, ["hash-object", "--no-filters", "--", file])) !== blob)
          output.add(file)
        continue
      }
      const baseline = path.join(baselinePaths(record).directory, file)
      const before = yield* io(() =>
        lstat(baseline).catch((cause) => {
          if (missing(cause)) return undefined
          throw cause
        }),
      )
      if (
        !before?.isFile() ||
        before.size !== current.size ||
        !FSUtil.writableInside(record.directory, path.join(record.directory, file)) ||
        !FSUtil.writableInside(baselinePaths(record).directory, baseline)
      ) {
        output.add(file)
        continue
      }
      if (
        (yield* io(() => IsolationCopy.hashFile(path.join(record.directory, file)))) !==
        (yield* io(() => IsolationCopy.hashFile(baseline)))
      )
        output.add(file)
    }
    if (record.mode === "copy") {
      const original = path.join(paths(record.projectID, record.taskID).registry, "baseline")
      const beforeLinks = yield* io(() => IsolationCopy.projectLinks(original))
      const currentLinks = yield* io(() => IsolationCopy.projectLinks(record.directory))
      for (const file of new Set([...Object.keys(beforeLinks), ...Object.keys(currentLinks)]))
        if (beforeLinks[file] !== currentLinks[file]) output.add(file)
      const root = baselinePaths(record).directory
      const files = yield* io(() => IsolationCopy.listProjectFiles(root, root, [], Number.MAX_SAFE_INTEGER))
      for (const file of files) {
        const before = yield* io(() => lstat(path.join(root, file)))
        if (before.size <= limits.fileBytes) continue
        const current = yield* io(() =>
          lstat(path.join(record.directory, file)).catch((cause) => {
            if (missing(cause)) return undefined
            throw cause
          }),
        )
        // Oversized baseline deletions and size reductions are also uncaptured changes.
        if (!current?.isFile() || current.size <= limits.fileBytes) output.add(file)
      }
      const baseline = yield* baselineHashes(record)
      const captured = yield* io(() => IsolationCopy.hashProject(record.directory, limits.fileBytes))
      for (const file of Object.keys(baseline).filter((file) => captured[file] === undefined)) {
        const present = yield* io(() =>
          lstat(path.join(record.directory, file)).catch((cause) => {
            if (missing(cause)) return undefined
            throw cause
          }),
        )
        if (present && !present.isDirectory()) output.add(file)
      }
    }
    return [...output].sort()
  })
  const retained = (record: Record, files: readonly string[], attempt = record.attempt) => ({
    ...record,
    state: "failed",
    settledAttempt: attempt,
    skipped: [...new Set([...(record.initialSkipped ?? []), ...files])],
    error: `${files.length} nonignored output${files.length === 1 ? " exceeds" : "s exceed"} the capture limit or cannot be captured. The checkout and its bytes have been retained; resume and reduce or move these outputs before merging or discarding.`,
  })
  const assertCaptured = Effect.fn("TaskIsolation.assertCaptured")(function* (record: Record) {
    yield* verify(record)
    const omitted = yield* unsupported(record)
    if (omitted.length) {
      const failed = retained(record, omitted)
      yield* save(failed)
      return yield* err("unsupported", failed.error)
    }
    if (!record.tip) return yield* err("unsaved", "The checkout has no saved snapshot and has been retained.")
    if (record.mode === "copy") {
      const limits = yield* Limits
      if (hash(stable(yield* io(() => IsolationCopy.hashProject(record.directory, limits.fileBytes)))) !== record.tip)
        return yield* err("unsaved", "The copy changed after it was saved; it has been retained.")
      return
    }
    const index = path.join(paths(record.projectID, record.taskID).registry, `inspect-index-${randomUUID()}`)
    const status = yield* Effect.acquireUseRelease(
      Effect.gen(function* () {
        const source = path.resolve(
          record.directory,
          yield* text(record.directory, ["rev-parse", "--git-path", "index"]),
        )
        yield* io(() => copyFile(source, index))
        return index
      }),
      (index) =>
        Effect.gen(function* () {
          yield* clearIndexFlags(record.directory, index)
          return nuls(
            yield* command(
              record.directory,
              ["status", "--porcelain=v1", "--no-renames", "-z", "--untracked-files=all"],
              { env: { GIT_INDEX_FILE: index } },
            ),
          )
        }),
      (index) => io(() => rm(index, { force: true })).pipe(Effect.orDie),
    )
    if (
      (yield* text(record.directory, ["rev-parse", "HEAD"])) !== record.tip ||
      status.some(
        (line) => !record.links.some((file) => line.slice(3) === file || line.slice(3).startsWith(`${file}/`)),
      )
    )
      return yield* err("unsaved", "The checkout changed after it was saved; it has been retained.")
  })
  const protect = Effect.fn("TaskIsolation.protect")(function* (record: Record) {
    yield* verify(record)
    const gitDirectory =
      record.mode === "worktree"
        ? path.resolve(record.directory, yield* text(record.directory, ["rev-parse", "--git-dir"]))
        : undefined
    TaskClaims.protect({
      taskID: record.taskID,
      directories: [paths(record.projectID, record.taskID).registry, record.directory],
      parentDirectory: record.parentDirectory,
      workDirectory: record.directory,
      branch: record.branch,
      gitDirectory,
      privateDirectories: [paths(record.projectID, record.taskID).registry],
      immutableFiles: record.mode === "worktree" ? [path.join(record.directory, ".git")] : [],
    })
  })

  const check = Effect.fn("TaskIsolation.check")(function* (input: CheckInput) {
    const limits = yield* Limits
    const ctx = yield* home
    if (/^(explore|review|judge|security|research)/i.test(input.agent.name))
      return yield* err("readonly", "Read-only agents cannot run in task isolation.")
    for (
      let id: string | undefined = input.parentSessionID, seen = new Set<string>();
      id && !seen.has(id);
      id = TaskPlace.parentOf(id)
    ) {
      seen.add(id)
      const place = TaskPlace.get(id)
      if (place && FileLock.key(place.work.directory) !== FileLock.key(place.home.directory))
        return yield* err("nested", "Nested task isolation is not supported.")
      if (yield* optional(id)) return yield* err("nested", "An isolated task cannot launch nested isolation.")
    }
    const existing = yield* records()
    const max = (yield* config.get()).sizing?.subagents?.isolation?.max_kept ?? 20
    if (existing.filter((record) => record.state === "changed").length >= max)
      return yield* err("kept", "Review, merge or discard existing isolated tasks before starting another.")
    if (input.resumeID) {
      const resumed = yield* get(input.resumeID)
      if (resumed.agent.name !== input.agent.name || resumed.parentSessionID !== input.parentSessionID)
        return yield* err("resume", "The resumed task's isolation does not match this launch.")
    }
    const cwd = ctx.worktree === path.parse(ctx.worktree).root ? ctx.directory : ctx.worktree
    const repository = yield* run(cwd, ["rev-parse", "--is-inside-work-tree"])
    const head = repository.exitCode === 0 ? yield* run(cwd, ["rev-parse", "--verify", "HEAD"]) : undefined
    const mode = head?.exitCode === 0 ? ("worktree" as const) : ("copy" as const)
    const sparse = repository.exitCode === 0 ? yield* run(cwd, ["config", "--bool", "core.sparseCheckout"]) : undefined
    if (sparse?.text().trim() === "true")
      return yield* err("sparse", "Task isolation does not support sparse checkouts.")
    const size =
      mode === "worktree"
        ? (yield* text(cwd, ["ls-tree", "-r", "-l", "HEAD"]))
            .split("\n")
            .reduce((total, line) => total + (Number(line.split(/\s+/)[3]) || 0), 0)
        : 0
    const disk = yield* io(() => statfs(Global.Path.data))
    if (disk.bavail * disk.bsize < Math.max(limits.minFreeBytes, size * 1.5))
      return yield* err("disk", "There is not enough free disk space for task isolation.")
    if (mode === "copy") {
      const total = yield* io(() => IsolationCopy.measureProject(cwd))
      if (total.files > limits.copyFiles)
        return yield* err("copy_limit", "The project exceeds the isolation copy file limit.")
      if (total.bytes > limits.copyBytes)
        return yield* err("copy_limit", "The project exceeds the isolation copy byte limit.")
    }
    return { mode, directory: cwd }
  })

  const reserve = Effect.fn("TaskIsolation.reserve")(function* (input: ReserveInput) {
    const ctx = yield* home
    const admitted = yield* check(input)
    const location = paths(ctx.project.id, input.taskID)
    return yield* lock(
      input.taskID,
      Effect.gen(function* () {
        if (
          yield* io(() =>
            lstat(location.file)
              .then(() => true)
              .catch((cause) => {
                if (missing(cause)) return false
                throw cause
              }),
          )
        )
          return yield* err("exists", "Task isolation is already reserved; resume it explicitly.")
        const record: Record = {
          version: 1,
          projectID: ctx.project.id,
          taskID: input.taskID,
          parentSessionID: input.parentSessionID,
          parentDirectory: admitted.directory,
          homeDirectory: ctx.directory,
          directory: location.directory,
          mode: admitted.mode,
          state: "preparing",
          title: input.title,
          agent: resolution(input.agent),
          attempt: input.attempt ?? 1,
          createdAt: Date.now(),
          ...(admitted.mode === "worktree" ? { branch: location.branch } : {}),
          links: [],
          skipped: [],
          initialSkipped: [],
          stacked: [...(input.dependsOn ?? [])],
          merged: [],
          files: [],
        }
        yield* save(record)
        TaskClaims.protect({
          taskID: record.taskID,
          directories: [location.registry, record.directory],
          parentDirectory: record.parentDirectory,
          workDirectory: record.directory,
          branch: record.branch,
          privateDirectories: [location.registry],
          immutableFiles: record.mode === "worktree" ? [path.join(record.directory, ".git")] : [],
        })
        return record
      }),
    )
  })

  /** Parent staging uses a private index; settlement owns the task's index. Paths remain NUL literal pathspecs. */
  const stage = Effect.fn("TaskIsolation.stage")(function* (
    record: Record,
    cwd: string,
    index: string,
    initial: boolean,
  ) {
    const limits = yield* Limits
    const sparse = new Set(
      nuls(yield* command(cwd, ["ls-files", "-v", "-z"], { env: { GIT_INDEX_FILE: index } }))
        .filter((entry) => entry[0]?.toLowerCase() === "s")
        .map((entry) => entry.slice(2)),
    )
    yield* clearIndexFlags(cwd, index)
    const listed = nuls(yield* command(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))
    const tracked = initial ? new Set(nuls(yield* command(cwd, ["ls-files", "-z", "--cached"]))) : undefined
    const eligible: string[] = [],
      skipped: string[] = []
    for (const file of [...new Set(listed)]) {
      if (!relative(file)) return yield* err("path", "Git returned an unsafe isolation path.")
      if (record.links.some((link) => file === link || file.startsWith(`${link}/`))) continue
      const info = yield* io(() =>
        lstat(path.join(cwd, file)).catch((cause) => {
          if (missing(cause)) return undefined
          throw cause
        }),
      )
      // Missing sparse entries are not authority to manufacture a deletion in the captured tree.
      if (!info && sparse.has(file)) continue
      if (info && info.size > limits.fileBytes && (!initial || !tracked?.has(file))) {
        skipped.push(file)
        continue
      }
      eligible.push(file)
    }
    if (eligible.length)
      yield* command(cwd, ["--literal-pathspecs", "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        env: { GIT_INDEX_FILE: index },
        stdin: Stream.make(Buffer.from(eligible.join("\0") + "\0")),
      })
    return skipped
  })

  const seed = Effect.fn("TaskIsolation.seed")(function* (record: Record) {
    const registry = paths(record.projectID, record.taskID).registry
    const index = path.join(registry, `index-${randomUUID()}`)
    return yield* Effect.acquireUseRelease(
      Effect.gen(function* () {
        const source = yield* text(record.parentDirectory, ["rev-parse", "--git-path", "index"])
        yield* io(() =>
          copyFile(path.resolve(record.parentDirectory, source), index).catch((cause) => {
            if (!missing(cause)) throw cause
          }),
        )
        return index
      }),
      (index) =>
        Effect.gen(function* () {
          const skipped = yield* stage(record, record.parentDirectory, index, true)
          const parentTree = yield* text(record.parentDirectory, ["rev-parse", "HEAD^{tree}"])
          const head = yield* text(record.parentDirectory, ["rev-parse", "HEAD"])
          const beforeStack = yield* text(record.parentDirectory, ["write-tree"], { env: { GIT_INDEX_FILE: index } })
          const unstackedSeed =
            beforeStack === parentTree
              ? head
              : yield* text(
                  record.parentDirectory,
                  [
                    "-c",
                    "commit.gpgsign=false",
                    "commit-tree",
                    beforeStack,
                    "-p",
                    head,
                    "-m",
                    `Vector: your uncommitted changes when ${record.title} started`,
                  ],
                  { env: yield* identity(record.parentDirectory) },
                )
          for (const id of record.stacked) {
            const dependency = yield* get(id)
            if (dependency.state === "merged") continue
            if (dependency.state !== "changed" || !dependency.seed || !dependency.tip)
              return yield* err("dependency", "An isolated dependency has no saved changes to stack.")
            const patch = yield* command(record.parentDirectory, [
              "diff",
              "--binary",
              dependency.reviewBase ?? dependency.seed,
              dependency.tip,
            ])
            const original = yield* io(() => readFile(index))
            const applied = yield* run(record.parentDirectory, ["apply", "--cached", "--3way", "--binary", "-"], {
              env: { GIT_INDEX_FILE: index },
              stdin: Stream.make(patch),
            })
            if (applied.exitCode !== 0 || /with conflicts\.$/m.test(applied.stderr.toString())) {
              yield* io(() => writeFile(index, original))
              yield* command(record.parentDirectory, ["apply", "--cached", "--binary", "-"], {
                env: { GIT_INDEX_FILE: index },
                stdin: Stream.make(patch),
              })
            }
          }
          const tree = yield* text(record.parentDirectory, ["write-tree"], { env: { GIT_INDEX_FILE: index } })
          const commit =
            tree === parentTree
              ? head
              : yield* text(
                  record.parentDirectory,
                  [
                    "-c",
                    "commit.gpgsign=false",
                    "commit-tree",
                    tree,
                    "-p",
                    head,
                    "-m",
                    `Vector: your uncommitted changes when ${record.title} started`,
                  ],
                  { env: yield* identity(record.parentDirectory) },
                )
          return { seed: commit, skipped, initialSkipped: skipped, ...(record.stacked.length ? { unstackedSeed } : {}) }
        }),
      (index) => io(() => rm(index, { force: true })).pipe(Effect.orDie),
    )
  })

  const start = Effect.fn("TaskIsolation.start")(function* (taskID: string) {
    const limits = yield* Limits
    return yield* lock(
      taskID,
      Effect.gen(function* () {
        const ctx = yield* home
        const record = yield* get(taskID)
        if (record.state !== "preparing") return yield* err("state", "Isolation is not waiting to start.")
        return yield* Effect.gen(function* () {
          const service = yield* worktrees()
          const settings = (yield* config.get()).sizing?.subagents?.isolation
          const created = yield* FileLock.forTree(record.parentDirectory)(
            Effect.gen(function* () {
              if (record.mode === "copy") {
                if (
                  yield* io(() =>
                    lstat(record.directory)
                      .then(() => true)
                      .catch((cause) => {
                        if (missing(cause)) return false
                        throw cause
                      }),
                  )
                )
                  return yield* err("exists", "The reserved copy directory already exists; it has not been changed.")
                const copied = yield* io(() =>
                  IsolationCopy.copyProject(record.parentDirectory, record.directory, {
                    maxFiles: limits.copyFiles,
                    maxBytes: limits.copyBytes,
                  }),
                )
                const hashes = yield* io(() => IsolationCopy.hashProject(record.directory, limits.fileBytes))
                yield* io(() =>
                  privateJSON(path.join(paths(record.projectID, taskID).registry, "baseline.json"), hashes),
                )
                yield* io(() =>
                  IsolationCopy.copyProject(
                    record.directory,
                    path.join(paths(record.projectID, taskID).registry, "baseline"),
                    { maxFiles: limits.copyFiles, maxBytes: limits.copyBytes },
                  ),
                )
                yield* io(() => privateTree(path.join(paths(record.projectID, taskID).registry, "baseline")))
                return yield* stackCopy({
                  ...record,
                  state: "preparing",
                  skipped: copied.skipped,
                  initialSkipped: copied.skipped,
                })
              }
              const seeded = yield* seed(record)
              const next = { ...record, ...seeded, state: "preparing" }
              yield* save(next)
              yield* service
                .createForTask(
                  { name: taskID, directory: record.directory, branch: record.branch },
                  { from: seeded.seed, env: { GIT_LFS_SKIP_SMUDGE: "1" } },
                )
                .pipe(Effect.provideService(InstanceRef, ctx))
              const bound = {
                ...next,
                gitDirectory: path.resolve(record.directory, yield* text(record.directory, ["rev-parse", "--git-dir"])),
                gitCommonDirectory: path.resolve(
                  record.directory,
                  yield* text(record.directory, ["rev-parse", "--git-common-dir"]),
                ),
              }
              yield* save(bound)
              return bound
            }),
          )
          yield* protect(created)
          yield* config.inheritTrust(created.directory)
          const links: string[] = []
          for (const link of settings?.link ?? []) {
            if (!relative(link) || created.mode !== "worktree")
              return yield* err("link", "Only relative ignored directory links can be used in a Git isolation.")
            const target = yield* io(() => realpath(path.join(created.parentDirectory, link)))
            const info = yield* io(() => lstat(target))
            if (
              !inside(yield* io(() => realpath(created.parentDirectory)), target) ||
              !info.isDirectory() ||
              (yield* run(created.parentDirectory, ["check-ignore", "--quiet", "--", link])).exitCode !== 0
            )
              return yield* err("link", "Isolation links must be ignored directories inside the launching checkout.")
            const to = path.join(created.directory, link)
            if (!FSUtil.writableInside(created.directory, to))
              return yield* err("link", "Isolation link destination is unsafe.")
            yield* io(async () => {
              await mkdir(path.dirname(to), { recursive: true })
              await symlink(target, to, process.platform === "win32" ? "junction" : "dir")
            })
            links.push(link)
          }
          const linked = {
            ...created,
            links,
            ...(created.mode === "worktree" ? { largeBaseline: yield* captureLargeBaseline(created) } : {}),
          }
          yield* save(linked)
          const loaded = yield* loadWork(linked, ctx)
          const work = loaded.work
          const resolved = yield* agents.get(linked.agent.name).pipe(Effect.provideService(InstanceRef, work))
          if (!resolved || stable(resolution(resolved)) !== stable(linked.agent)) {
            return yield* err("agent", "Agent configuration differs in the isolated instance; no model was started.")
          }
          const ready = { ...linked, state: "running" }
          yield* save(ready)
          TaskPlace.set(taskID, { work, home: ctx })
          loaded.transferred = true
          return {
            record: ready,
            work,
            brief: `You work in an isolated copy of the repository at ${linked.directory}${linked.branch ? ` (git worktree on branch ${linked.branch})` : ""}, made from the parent's files when you started, including their uncommitted changes${linked.stacked.length ? `, plus the changes of ${linked.stacked.join(", ")}` : ""}. Paths under ${linked.parentDirectory} in this conversation are under ${linked.directory} for you. Edit and run checks here; nothing reaches the parent's files until the parent merges your work. You may commit on your branch; do not switch branches, stash or push. Ignored files such as node_modules are not here${links.length ? `; linked: ${links.join(", ")}` : ""}${linked.skipped.length ? `; left out: ${linked.skipped.join(", ")}` : ""}. List the files you changed in your report.`,
          }
        }).pipe(
          Effect.scoped,
          Effect.catchCause((cause) =>
            get(taskID).pipe(
              Effect.flatMap((record) => {
                const failed = { ...record, state: "failed", error: Cause.pretty(cause) }
                return save(failed).pipe(Effect.ensuring(retire(failed).pipe(Effect.orDie)))
              }),
              Effect.uninterruptible,
              Effect.andThen(Effect.failCause(cause)),
            ),
          ),
        )
      }),
    )
  })

  const retire = Effect.fn("TaskIsolation.retire")(function* (record: Record) {
    const work = active.get(record.taskID) ?? TaskPlace.get(record.taskID)?.work
    if (work && FileLock.key(work.directory) === FileLock.key(record.directory)) {
      yield* quiesce(record.taskID, work)
      const store = yield* instances()
      yield* store.dispose(work)
    }
    active.delete(record.taskID)
    TaskPlace.dropWork(record.taskID)
  })
  const loadWork = Effect.fn("TaskIsolation.loadWork")(function* (record: Record, ctx: InstanceContext) {
    const store = yield* instances()
    return yield* Effect.acquireRelease(
      store.load({ directory: record.directory, worktree: record.directory, project: ctx.project }).pipe(
        Effect.map((work) => {
          active.set(record.taskID, work)
          return { work, transferred: false }
        }),
      ),
      (entry) => (entry.transferred ? Effect.void : retire(record).pipe(Effect.orDie)),
    )
  })
  const unlinkLinks = (record: Record) =>
    io(async () => {
      for (const link of record.links) {
        const file = path.join(record.directory, link)
        await guarded(path.dirname(file), record.directory)
        const info = await lstat(file).catch((cause) => {
          if (missing(cause)) return undefined
          throw cause
        })
        if (info && !info.isSymbolicLink())
          throw err("link", "An isolation link was replaced; refusing recursive removal.")
        if (info) await unlink(file)
      }
    })
  const remove = Effect.fn("TaskIsolation.remove")(function* (record: Record) {
    const valid = yield* verify(record)
    yield* assertCaptured(valid)
    yield* unlinkLinks(valid)
    if (valid.mode === "worktree") {
      const service = yield* worktrees()
      const ctx = yield* home
      yield* service
        .removeForTask({ name: valid.taskID, directory: valid.directory, branch: valid.branch! })
        .pipe(Effect.provideService(InstanceRef, ctx))
    } else yield* io(() => rm(valid.directory, { recursive: true, force: true }))
    yield* io(() => WorkspaceTrust.forget(Global.Path.state, valid.directory))
    TaskClaims.unprotect(valid.taskID)
  })
  const stats = Effect.fn("TaskIsolation.stats")(function* (record: Record) {
    const limits = yield* Limits
    if (record.mode === "copy") {
      const baseline = yield* baselineHashes(record)
      const current = yield* io(() => IsolationCopy.hashProject(record.directory, limits.fileBytes))
      const differences = yield* Effect.forEach(
        [...new Set([...Object.keys(baseline), ...Object.keys(current)])]
          .filter((file) => baseline[file] !== current[file])
          .sort(),
        (file) =>
          Effect.gen(function* () {
            if (baseline[file] && current[file] === undefined) {
              const present = yield* io(() =>
                lstat(path.join(record.directory, file)).catch((cause) => {
                  if (missing(cause)) return undefined
                  throw cause
                }),
              )
              // An omitted existing file is unsupported, not a deletion. Settlement retains it before capture.
              if (present && !present.isDirectory()) return undefined
            }
            const before = baseline[file]
              ? yield* io(() => readFile(path.join(baselinePaths(record).directory, file)))
              : Buffer.alloc(0)
            const after = current[file] ? yield* io(() => readFile(path.join(record.directory, file))) : Buffer.alloc(0)
            const binary = before.includes(0) || after.includes(0)
            const delta = binary ? [] : diffLines(before.toString(), after.toString())
            return {
              path: file,
              status: !current[file] ? "deleted" : !baseline[file] ? "added" : "modified",
              additions: delta.reduce((sum, item) => sum + (item.added ? (item.count ?? 0) : 0), 0),
              deletions: delta.reduce((sum, item) => sum + (item.removed ? (item.count ?? 0) : 0), 0),
              binary,
            }
          }),
      )
      return differences.filter((file) => file !== undefined)
    }
    if (!record.seed || !record.tip) return []
    const names = nuls(
      yield* command(record.parentDirectory, [
        "diff",
        "--name-status",
        "--no-renames",
        "-z",
        record.reviewBase ?? record.seed,
        record.tip,
      ]),
    )
    const numbers = nuls(
      yield* command(record.parentDirectory, [
        "diff",
        "--numstat",
        "--no-renames",
        "-z",
        record.reviewBase ?? record.seed,
        record.tip,
      ]),
    )
    return numbers.map((line, index) => {
      const [add, del, ...file] = line.split("\t")
      return {
        path: file.join("\t"),
        status: names[index * 2] === "A" ? "added" : names[index * 2] === "D" ? "deleted" : "modified",
        additions: Number(add) || 0,
        deletions: Number(del) || 0,
        binary: add === "-" || del === "-",
      }
    })
  })
  const settle = Effect.fn("TaskIsolation.settle")(function* (input: {
    taskID: string
    attempt: number
    recover?: boolean
  }) {
    const limits = yield* Limits
    return yield* lock(
      input.taskID,
      Effect.gen(function* () {
        const record = yield* get(input.taskID)
        if (record.settledAttempt === input.attempt && !(input.recover && record.state === "failed")) return record
        if (record.attempt !== input.attempt) return record
        yield* verify(record)
        yield* save({ ...record, state: "settling" })
        const placed = active.get(record.taskID) ?? TaskPlace.get(record.taskID)?.work
        const work = placed && FileLock.key(placed.directory) === FileLock.key(record.directory) ? placed : undefined
        // The running parent's own finalizer calls settle; only descendants are stopped here.
        if (work) yield* quiesce(record.taskID, work)
        const omitted = yield* unsupported(record)
        if (omitted.length) {
          const failed = retained(record, omitted, input.attempt)
          yield* save(failed)
          yield* retire(failed)
          return failed
        }
        const saved =
          record.mode === "copy"
            ? {
                ...record,
                files: yield* stats(record),
                skipped: record.initialSkipped ?? [],
                tip: hash(stable(yield* io(() => IsolationCopy.hashProject(record.directory, limits.fileBytes)))),
              }
            : yield* Effect.gen(function* () {
                const index = path.resolve(
                  record.directory,
                  yield* text(record.directory, ["rev-parse", "--git-path", "index"]),
                )
                const skipped = yield* stage(record, record.directory, index, false)
                const excluded = [...skipped, ...record.links]
                if (excluded.length)
                  yield* command(
                    record.directory,
                    [
                      "--literal-pathspecs",
                      "reset",
                      "--quiet",
                      record.reviewBase ?? record.seed!,
                      "--pathspec-from-file=-",
                      "--pathspec-file-nul",
                    ],
                    { stdin: Stream.make(Buffer.from(excluded.join("\0") + "\0")) },
                  )
                const dirty = yield* text(record.directory, ["diff", "--cached", "--name-only"])
                if (dirty)
                  yield* command(
                    record.directory,
                    [
                      "-c",
                      `core.hooksPath=${os.devNull}`,
                      "-c",
                      "commit.gpgsign=false",
                      "commit",
                      "-m",
                      `Vector subagent: ${record.title}`,
                    ],
                    { env: yield* identity(record.directory) },
                  )
                const tip = yield* text(record.directory, ["rev-parse", "HEAD"])
                const next = { ...record, tip, skipped: [...new Set([...(record.initialSkipped ?? []), ...skipped])] }
                return { ...next, files: yield* stats(next) }
              })
        const diverged =
          saved.mode === "worktree" &&
          saved.seed &&
          saved.tip &&
          (yield* run(saved.parentDirectory, ["merge-base", "--is-ancestor", saved.seed, saved.tip])).exitCode !== 0
        const final = {
          ...saved,
          state: diverged ? "diverged" : saved.files.length ? "changed" : "unchanged",
          settledAttempt: input.attempt,
          error: undefined,
        }
        yield* save(final)
        yield* retire(final)
        if (final.state === "unchanged") yield* FileLock.forTree(final.parentDirectory)(remove(final))
        return final
      }).pipe(
        Effect.catchCause((cause) =>
          get(input.taskID).pipe(
            Effect.flatMap((record) => {
              const failed = { ...record, state: "failed", error: String(cause), settledAttempt: input.attempt }
              return save(failed).pipe(Effect.andThen(retire(failed)), Effect.as(failed))
            }),
          ),
        ),
      ),
    )
  })

  const patch = Effect.fn("TaskIsolation.patch")(function* (record: Record, selected?: readonly string[]) {
    const limits = yield* Limits
    if (["merged", "discarded"].includes(record.state) && record.savedPatch)
      return yield* io(async () => {
        await guarded(record.savedPatch!)
        const handle = await open(record.savedPatch!, "r")
        return (async () => {
          const bytes = Buffer.alloc(limits.patchBytes)
          const read = await handle.read(bytes)
          const size = (await handle.stat()).size
          const encoded = Buffer.from(bytes.subarray(0, read.bytesRead).toString("utf8"))
          return {
            patch: new TextDecoder().decode(encoded.subarray(0, limits.patchBytes), { stream: true }),
            truncated: size > read.bytesRead || encoded.length > limits.patchBytes,
          }
        })().finally(() => handle.close())
      })
    if (record.mode === "copy") {
      const parts: string[] = []
      for (const file of record.files.filter((file) => !selected || selected.includes(file.path))) {
        const before =
          file.status === "added"
            ? Buffer.alloc(0)
            : yield* io(() => readFile(path.join(baselinePaths(record).directory, file.path)))
        const after =
          file.status === "deleted"
            ? Buffer.alloc(0)
            : yield* io(() => readFile(path.join(record.directory, file.path)))
        parts.push(
          file.binary
            ? `Binary file ${file.path} changed\n`
            : createTwoFilesPatch(`a/${file.path}`, `b/${file.path}`, before.toString(), after.toString()),
        )
        if (Buffer.byteLength(parts.join("")) > limits.patchBytes) break
      }
      const encoded = Buffer.from(parts.join(""))
      return {
        patch: new TextDecoder().decode(encoded.subarray(0, limits.patchBytes), { stream: true }),
        truncated: encoded.length > limits.patchBytes,
      }
    }
    if (!record.seed || !record.tip) return { patch: "", truncated: false }
    const result = yield* run(
      record.parentDirectory,
      [
        "--literal-pathspecs",
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        record.reviewBase ?? record.seed,
        record.tip,
        "--",
        ...(selected ?? []),
      ],
      { maxOutputBytes: limits.patchBytes },
    )
    if (result.exitCode !== 0) return yield* err("git", result.stderr.toString())
    const encoded = Buffer.from(result.stdout.toString("utf8"))
    return {
      patch: new TextDecoder().decode(encoded.subarray(0, limits.patchBytes), { stream: true }),
      truncated: result.truncated || encoded.length > limits.patchBytes,
    }
  })
  const changes = Effect.fn("TaskIsolation.changes")(function* (input: {
    taskID: string
    diff?: boolean
    control?: boolean
    review?: boolean
  }) {
    return yield* lock(
      input.taskID,
      Effect.gen(function* () {
        const record = yield* get(input.taskID)
        const remaining = record.files.filter((file) => !record.merged.includes(file.path))
        if (!input.diff && !input.review)
          return {
            record,
            files: remaining,
            patch: undefined,
            truncated: false,
            mergeable: record.mergeable ?? "unknown",
          }
        if (input.diff && !input.control)
          return yield* err("forbidden", "Only the owner or a task controller may inspect an isolation patch.")
        const data = input.diff ? yield* patch(record) : undefined
        const limits = yield* Limits
        const status =
          record.mode === "copy"
            ? hash(stable(yield* io(() => IsolationCopy.hashProject(record.parentDirectory, limits.fileBytes))))
            : yield* parentTree(record)
        const head = record.mode === "copy" ? "copy" : yield* text(record.parentDirectory, ["rev-parse", "HEAD"])
        const key = stable([record.tip, record.reviewBase, record.copyBase, head, status, record.merged])
        const assessed =
          record.state === "changed" && record.mergeKey !== key
            ? yield* prepare(
                record,
                remaining.map((file) => file.path),
                [],
                record.mode === "worktree" ? status : undefined,
              )
            : undefined
        const next = {
          ...record,
          mergeKey: key,
          mergeable:
            record.state !== "changed"
              ? "blocked"
              : record.mergeKey === key
                ? (record.mergeable ?? "unknown")
                : assessed?.conflicts.length
                  ? "conflict"
                  : "clean",
        }
        yield* save(next)
        return {
          record: next,
          files: remaining,
          ...(data ? { patch: data.patch } : {}),
          truncated: data?.truncated ?? false,
          mergeable: next.mergeable,
        }
      }),
    )
  })

  const blob = Effect.fn("TaskIsolation.blob")(function* (record: Record, tree: string, file: string, filters = false) {
    const listing = nuls(
      yield* command(record.parentDirectory, ["--literal-pathspecs", "ls-tree", "-z", tree, "--", file]),
    )
    const line = listing.find((line) => line.slice(line.indexOf("\t") + 1) === file)
    if (!line) return undefined
    const [mode, type, object] = line.slice(0, line.indexOf("\t")).split(" ")
    if (type !== "blob" || !object || !["100644", "100755", "120000"].includes(mode!))
      return yield* err("path", "Isolation merge does not support submodules or special files.")
    return {
      mode: mode!,
      bytes: yield* command(
        record.parentDirectory,
        filters && mode !== "120000"
          ? ["cat-file", "--filters", `--path=${file}`, `${tree}:${file}`]
          : ["cat-file", "blob", object],
      ),
    }
  })

  /** Write the parent's working files into a temporary index/tree, preserving the real index byte for byte. */
  const parentTree = Effect.fn("TaskIsolation.parentTree")(function* (record: Record, omit: readonly string[] = []) {
    const temp = path.join(paths(record.projectID, record.taskID).registry, `merge-index-${randomUUID()}`)
    return yield* Effect.acquireUseRelease(
      Effect.succeed(temp),
      (index) =>
        Effect.gen(function* () {
          yield* command(record.parentDirectory, ["read-tree", "HEAD"], { env: { GIT_INDEX_FILE: index } })
          yield* stage({ ...record, links: [] }, record.parentDirectory, index, true)
          if (omit.length)
            yield* command(record.parentDirectory, ["update-index", "--force-remove", "-z", "--stdin"], {
              env: { GIT_INDEX_FILE: index },
              stdin: Stream.make(Buffer.from(omit.join("\0") + "\0")),
            })
          return yield* text(record.parentDirectory, ["write-tree"], { env: { GIT_INDEX_FILE: index } })
        }),
      (index) => io(() => rm(index, { force: true })).pipe(Effect.orDie),
    )
  })
  const prepare = Effect.fn("TaskIsolation.prepare")(function* (
    record: Record,
    selected: readonly string[],
    omit: readonly string[] = [],
    currentTree?: string,
  ) {
    const limits = yield* Limits
    if (record.mode === "copy") {
      const omitted = yield* unsupported(record)
      if (omitted.length) return yield* err("unsupported", retained(record, omitted).error)
      const baseline = yield* baselineHashes(record)
      const parent = yield* io(() => IsolationCopy.hashProject(record.parentDirectory, limits.fileBytes))
      const child = yield* io(() => IsolationCopy.hashProject(record.directory, limits.fileBytes))
      if (record.tip && hash(stable(child)) !== record.tip)
        return yield* err(
          "unsaved",
          "The saved copy changed after settlement; resume it before merging or stacking it.",
        )
      const conflicts = selected.filter(
        (file) => !omit.includes(file) && parent[file] !== baseline[file] && parent[file] !== child[file],
      )
      const blobs = new Map<string, Blob>()
      for (const file of selected) {
        if (!child[file]) {
          blobs.set(file, undefined)
          continue
        }
        if (!FSUtil.writableInside(record.directory, path.join(record.directory, file)))
          return yield* err("path", "Copy merge source is no longer an ordinary project file.")
        const bytes = yield* io(() => readFile(path.join(record.directory, file)))
        if (hash(bytes) !== child[file]) return yield* err("changed", "Copy merge source changed during review.")
        const mode = yield* io(() => lstat(path.join(record.directory, file)))
        blobs.set(file, { mode: mode.mode & 0o111 ? "100755" : "100644", bytes })
      }
      return { conflicts, blobs }
    }
    if (!record.seed || !record.tip) return yield* err("state", "The isolation has no saved Git result.")
    const base = record.reviewBase ?? record.seed
    const current = currentTree ?? (yield* parentTree(record, omit))
    const identityEnv = yield* identity(record.parentDirectory)
    const parentCommit = yield* text(
      record.parentDirectory,
      ["-c", "commit.gpgsign=false", "commit-tree", current, "-p", base, "-m", "Vector isolation merge preview"],
      { env: identityEnv },
    )
    const selectedIndex = path.join(paths(record.projectID, record.taskID).registry, `selection-index-${randomUUID()}`)
    const selectedTip = yield* Effect.acquireUseRelease(
      Effect.succeed(selectedIndex),
      (index) =>
        Effect.gen(function* () {
          yield* command(record.parentDirectory, ["read-tree", base], { env: { GIT_INDEX_FILE: index } })
          const delta = yield* command(record.parentDirectory, [
            "--literal-pathspecs",
            "diff",
            "--binary",
            base,
            record.tip!,
            "--",
            ...selected,
          ])
          if (delta.length)
            yield* command(record.parentDirectory, ["apply", "--cached", "--binary", "-"], {
              env: { GIT_INDEX_FILE: index },
              stdin: Stream.make(delta),
            })
          const tree = yield* text(record.parentDirectory, ["write-tree"], { env: { GIT_INDEX_FILE: index } })
          return yield* text(
            record.parentDirectory,
            ["-c", "commit.gpgsign=false", "commit-tree", tree, "-p", base, "-m", "Vector selected isolation changes"],
            { env: identityEnv },
          )
        }),
      (index) => io(() => rm(index, { force: true })).pipe(Effect.orDie),
    )
    const merged = yield* run(record.parentDirectory, [
      "merge-tree",
      "--write-tree",
      "--messages",
      "-z",
      parentCommit,
      selectedTip,
    ])
    if (merged.exitCode !== 0 && /unknown option|usage: git merge-tree/i.test(merged.stderr.toString())) {
      const index = path.join(paths(record.projectID, record.taskID).registry, `fallback-index-${randomUUID()}`)
      return yield* Effect.acquireUseRelease(
        Effect.succeed(index),
        (index) =>
          Effect.gen(function* () {
            yield* command(record.parentDirectory, ["read-tree", current], { env: { GIT_INDEX_FILE: index } })
            const delta = yield* command(record.parentDirectory, ["diff", "--binary", base, selectedTip])
            const checked = yield* run(
              record.parentDirectory,
              ["apply", "--cached", "--3way", "--check", "--binary", "-"],
              { env: { GIT_INDEX_FILE: index }, stdin: Stream.make(delta) },
            )
            if (checked.exitCode !== 0 || /^Applied patch to '.*' with conflicts\.$/m.test(checked.stderr.toString()))
              return { conflicts: [...selected], blobs: new Map<string, Blob>() }
            // --check is allowed to update this disposable index; reset it before computing the actual resolved tree.
            yield* command(record.parentDirectory, ["read-tree", current], { env: { GIT_INDEX_FILE: index } })
            const applied = yield* run(record.parentDirectory, ["apply", "--cached", "--3way", "--binary", "-"], {
              env: { GIT_INDEX_FILE: index },
              stdin: Stream.make(delta),
            })
            if (applied.exitCode !== 0 || /^Applied patch to '.*' with conflicts\.$/m.test(applied.stderr.toString()))
              return { conflicts: [...selected], blobs: new Map<string, Blob>() }
            const tree = yield* text(record.parentDirectory, ["write-tree"], { env: { GIT_INDEX_FILE: index } })
            const blobs = new Map<string, Blob>()
            for (const file of selected) blobs.set(file, yield* blob(record, tree, file, true))
            return { conflicts: [] as string[], blobs }
          }),
        (index) => io(() => rm(index, { force: true })).pipe(Effect.orDie),
      )
    }
    if (merged.exitCode !== 0) {
      const output = nuls(merged.stdout)
      const conflicts = output
        .filter((line) => /^\d{6} [0-9a-f]+ [123]\t/.test(line))
        .map((line) => line.slice(line.indexOf("\t") + 1))
      return { conflicts: [...new Set(conflicts.length ? conflicts : selected)], blobs: new Map<string, Blob>() }
    }
    const tree = nuls(merged.stdout)[0]?.trim()
    if (!tree || !/^[a-f0-9]{40,64}$/.test(tree))
      return yield* err("git_version", "Isolation merge requires Git 2.38 or newer.")
    const blobs = new Map<string, Blob>()
    for (const file of selected) blobs.set(file, yield* blob(record, tree, file, true))
    return { conflicts: [] as string[], blobs }
  })

  const stackCopy = Effect.fn("TaskIsolation.stackCopy")(function* (record: Record) {
    if (!record.stacked.length) return record
    const selected = new Set<string>()
    for (const id of record.stacked) {
      const dependency = yield* get(id)
      if (dependency.state === "merged") continue
      if (dependency.mode !== "copy" || dependency.state !== "changed")
        return yield* err("dependency", "A copy dependency has no saved changes to stack.")
      const files = dependency.files.filter((file) => !dependency.merged.includes(file.path)).map((file) => file.path)
      const result = yield* prepare({ ...dependency, parentDirectory: record.directory }, files)
      if (result.conflicts.length)
        return yield* err(
          "dependency",
          "The copied dependency conflicts with this task's starting files.",
          result.conflicts,
        )
      for (const file of files)
        if (!FSUtil.writableInside(record.directory, path.join(record.directory, file)))
          return yield* err("path", "A stacked copy target is unsafe.")
      for (const [file, blob] of result.blobs) {
        const target = path.join(record.directory, file)
        yield* io(async () => {
          if (!FSUtil.writableInside(record.directory, target))
            throw err("path", "A stacked copy target changed identity.")
          if (!blob) {
            await rm(target, { force: true })
            return
          }
          await mkdir(path.dirname(target), { recursive: true })
          await writeFile(target, blob.bytes, { mode: blob.mode === "100755" ? 0o755 : 0o644 })
        })
        selected.add(file)
      }
    }
    const registry = paths(record.projectID, record.taskID).registry
    const limits = yield* Limits
    const advanced = selected.size
      ? yield* io(() =>
          IsolationBase.advanceCopy(
            { registry, directory: record.directory, baselineDirectory: path.join(registry, "baseline") },
            [...selected],
            limits.fileBytes,
          ),
        )
      : undefined
    return { ...record, copyStacked: true, ...(advanced ? { copyBase: advanced.name } : {}) }
  })

  const checkpoint = Effect.fn("TaskIsolation.checkpoint")(function* (record: Record, selected: readonly string[]) {
    const directory = path.join(
      paths(record.projectID, record.taskID).registry,
      "checkpoints",
      `${Date.now()}-${randomUUID()}`,
    )
    const files: Checkpoint["files"] = []
    for (const file of selected) {
      const source = path.join(record.parentDirectory, file)
      const info = yield* io(() =>
        lstat(source).catch((cause) => {
          if (missing(cause)) return undefined
          throw cause
        }),
      )
      files.push({
        path: file,
        existed: !!info,
        ...(info
          ? { mode: info.mode, ...(info.isSymbolicLink() ? { symlink: yield* io(() => readlink(source)) } : {}) }
          : {}),
      })
      if (info)
        yield* io(() =>
          IsolationCopy.backupBeforeOverwrite(path.join(directory, "checkpoint.json"), record.parentDirectory, file),
        )
    }
    yield* io(() =>
      privateJSON(path.join(directory, "manifest.json"), { files, selected, phase: "prepared" } satisfies Checkpoint),
    )
    yield* io(() => privateTree(directory))
    const next = { ...record, checkpoint: directory, mergeStartedAt: Date.now(), mergeCompleted: false }
    yield* save(next)
    return next
  })
  const rollback = Effect.fn("TaskIsolation.rollback")(function* (record: Record) {
    if (
      !record.checkpoint ||
      !inside(path.join(paths(record.projectID, record.taskID).registry, "checkpoints"), record.checkpoint)
    )
      return yield* err("checkpoint", "Isolation checkpoint is not in its registry.")
    yield* io(() => guarded(path.join(record.checkpoint!, "manifest.json")))
    const manifest = yield* io(() =>
      readFile(path.join(record.checkpoint!, "manifest.json"), "utf8").then((value) => JSON.parse(value) as Checkpoint),
    )
    if (!manifest.files.every((file) => relative(file.path)))
      return yield* err("checkpoint", "Isolation checkpoint contains an unsafe path.")
    for (const file of manifest.files) {
      const target = path.join(record.parentDirectory, file.path)
      const info = yield* io(() =>
        lstat(target).catch((cause) => {
          if (missing(cause)) return undefined
          throw cause
        }),
      )
      if (
        !FSUtil.writableInside(record.parentDirectory, target) &&
        !(
          info?.isSymbolicLink() &&
          FSUtil.writableInside(
            record.parentDirectory,
            path.join(path.dirname(target), `.vector-restore-${randomUUID()}`),
          )
        )
      )
        return yield* err("path", "Cannot restore a checkpoint through an unsafe target.")
      if (info?.isSymbolicLink()) yield* io(() => unlink(target))
      if (!file.existed) {
        yield* io(() => rm(target, { force: true }))
        continue
      }
      yield* io(async () => {
        await mkdir(path.dirname(target), { recursive: true })
        if (file.symlink !== undefined) {
          await rm(target, { force: true })
          await symlink(file.symlink, target)
        } else {
          await copyFile(path.join(record.checkpoint!, "overwritten", file.path), target)
          if (file.mode !== undefined) await chmod(target, file.mode)
        }
      })
    }
    yield* save({ ...record, state: "changed", mergeStartedAt: undefined, mergeCompleted: undefined })
  })
  const savePatch = Effect.fn("TaskIsolation.savePatch")(function* (record: Record, kind: string) {
    const file = path.join(
      paths(record.projectID, record.taskID).registry,
      "patches",
      `${kind}-${Date.now()}-${randomUUID()}.patch`,
    )
    if (record.mode === "copy") {
      const limits = yield* Limits
      if (
        record.tip &&
        hash(stable(yield* io(() => IsolationCopy.hashProject(record.directory, limits.fileBytes)))) !== record.tip
      )
        return yield* err("unsaved", "The saved copy changed after settlement; its checkout has been retained.")
      yield* io(async () => {
        await guarded(file)
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
        await writeFile(file, JSON.stringify({ format: "vector-isolation-copy-v1", files: record.files }) + "\n", {
          flag: "wx",
          mode: 0o600,
        })
      })
      for (const entry of record.files) {
        const target = path.join(record.directory, entry.path)
        if (entry.status !== "deleted" && !FSUtil.writableInside(record.directory, target))
          return yield* err("path", "Cannot save a copy patch through an unsafe source.")
        const bytes = entry.status === "deleted" ? undefined : yield* io(() => readFile(target))
        yield* io(() =>
          appendFile(
            file,
            JSON.stringify({
              path: entry.path,
              status: entry.status,
              ...(bytes ? { content: bytes.toString("base64") } : {}),
            }) + "\n",
          ),
        )
      }
      return file
    }
    const data =
      record.mode === "worktree" && record.seed && record.tip
        ? yield* command(record.parentDirectory, ["diff", "--binary", record.patchBase ?? record.seed, record.tip])
        : Buffer.from(JSON.stringify(record.files))
    yield* io(async () => {
      await guarded(file)
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      await writeFile(file, data, { flag: "wx", mode: 0o600 })
    })
    return file
  })

  const merge = Effect.fn("TaskIsolation.merge")(function* (input: MergeInput) {
    return yield* lock(
      input.taskID,
      Effect.gen(function* () {
        const original = yield* get(input.taskID)
        if (["preparing", "running", "settling"].includes(original.state) || active.has(input.taskID))
          return yield* err("running", "The isolated task is still running or saving its changes.")
        if (original.state !== "changed") return yield* err("state", "Only a changed isolated task can be merged.")
        yield* assertCaptured(original)
        if (input.by.kind !== "owner" && (input.force || input.includeStacked))
          return yield* err("forbidden", "Only the owner can force a collision or include stacked changes.")
        if (input.by.kind === "agent" && input.by.sessionID !== original.parentSessionID)
          return yield* err("forbidden", "An agent may merge only its direct children.")
        const unmerged = yield* Effect.forEach(original.stacked, (id) =>
          get(id).pipe(Effect.map((record) => record.state !== "merged")),
        )
        if (unmerged.some(Boolean) && !input.includeStacked)
          return yield* err("stacked", "Merge the task's stacked dependencies first.")
        const included = yield* Effect.gen(function* () {
          if (!unmerged.some(Boolean) || !input.includeStacked) return original
          if (original.stackedIncluded) return original
          const registry = paths(original.projectID, original.taskID).registry
          if (original.mode === "copy") {
            if (!original.copyStacked) return yield* err("stacked", "This copy has no saved pre-stack baseline.")
            const limits = yield* Limits
            const copyBase = original.merged.length
              ? (yield* io(() =>
                  IsolationBase.advanceCopy(
                    { registry, directory: original.directory, baselineDirectory: path.join(registry, "baseline") },
                    original.merged,
                    limits.fileBytes,
                  ),
                )).name
              : undefined
            return { ...original, copyBase, stackedIncluded: true }
          }
          if (!original.unstackedSeed || !original.tip)
            return yield* err("stacked", "This result has no saved pre-stack Git baseline.")
          return {
            ...original,
            stackedIncluded: true,
            patchBase: original.unstackedSeed,
            reviewBase: yield* IsolationBase.advanceGit(
              { parentDirectory: original.parentDirectory, registry, seed: original.unstackedSeed, tip: original.tip },
              original.merged,
              command,
            ),
          }
        })
        const record = included === original ? original : { ...included, files: yield* stats(included) }
        if (
          TaskClaims.protectedTrees().some(
            (entry) =>
              entry.taskID !== (input.by.kind === "agent" ? input.by.sessionID : undefined) &&
              entry.workDirectory &&
              FileLock.key(entry.workDirectory) === FileLock.key(record.parentDirectory),
          )
        )
          return yield* err("running", "The merge target belongs to another running isolated task.")
        const remaining = record.files.filter((file) => !record.merged.includes(file.path)).map((file) => file.path)
        const selected = [...new Set(input.files ?? remaining)]
        if (!selected.length || selected.some((file) => !remaining.includes(file) || !relative(file)))
          return yield* err("files", "The merge selection contains an unknown or previously merged path.")
        const targets = selected.map((file) => path.join(record.parentDirectory, file))
        for (const target of targets) {
          if (!FSUtil.writableInside(record.parentDirectory, target))
            return yield* err("path", "The merge target is a symlink, hard link or leaves the project.")
          if (input.by.kind === "agent") yield* input.by.assertExternalDirectory(target)
        }
        if (input.by.kind === "agent") {
          yield* input.by.assertWritable({ files: targets })
          yield* input.by.ask({
            permission: "edit",
            patterns: selected,
            always: ["*"],
            metadata: { diff: (yield* patch(record, selected)).patch },
          })
        }
        return yield* FileLock.forTree(record.parentDirectory)(
          FileLock.withFiles(targets)(
            Effect.gen(function* () {
              for (const target of targets)
                if (!FSUtil.writableInside(record.parentDirectory, target))
                  return yield* err("path", "The merge target changed after approval.")
              if (input.by.kind === "agent") yield* input.by.assertWritable({ files: targets })
              // A new child path colliding with an untracked parent path needs explicit owner force, even when a 3-way merge is possible.
              const collisions: string[] = []
              for (const file of selected.filter(
                (name) => record.files.find((item) => item.path === name)?.status === "added",
              )) {
                const existing = yield* io(() =>
                  readFile(path.join(record.parentDirectory, file)).catch((cause) => {
                    if (missing(cause)) return undefined
                    throw cause
                  }),
                )
                const tracked =
                  record.mode === "worktree" &&
                  (yield* run(record.parentDirectory, [
                    "--literal-pathspecs",
                    "ls-files",
                    "--error-unmatch",
                    "--",
                    file,
                  ])).exitCode === 0
                const child =
                  record.mode === "worktree" && record.tip
                    ? yield* blob(record, record.tip, file)
                    : { mode: "100644", bytes: yield* io(() => readFile(path.join(record.directory, file))) }
                if (existing && !tracked && !existing.equals(child?.bytes ?? Buffer.alloc(0))) {
                  collisions.push(file)
                }
              }
              if (collisions.length && !input.force)
                return yield* err("conflict", "An untracked parent file would be overwritten.", collisions)
              const resolved = yield* prepare(record, selected, input.force ? collisions : [])
              if (resolved.conflicts.length)
                return yield* err("conflict", "Isolation changes conflict with the parent's current files.", [
                  ...new Set(resolved.conflicts),
                ])
              for (const [file, value] of resolved.blobs) {
                if (value?.mode === "120000") {
                  const to = path.resolve(path.dirname(path.join(record.parentDirectory, file)), value.bytes.toString())
                  if (!inside(record.parentDirectory, FSUtil.realpath(to)))
                    return yield* err("path", "An added symbolic link would leave the repository.")
                }
              }
              const pending = yield* checkpoint(record, selected)
              yield* Effect.gen(function* () {
                for (const [file, value] of resolved.blobs) {
                  const target = path.join(record.parentDirectory, file)
                  if (!FSUtil.writableInside(record.parentDirectory, target))
                    return yield* err("path", "A merge target became unsafe before writing.")
                  yield* io(async () => {
                    if (!value) {
                      await rm(target, { force: true })
                      return
                    }
                    await mkdir(path.dirname(target), { recursive: true })
                    if (value.mode === "120000") {
                      await rm(target, { force: true })
                      await symlink(value.bytes.toString(), target)
                      return
                    }
                    const temp = path.join(path.dirname(target), `.vector-merge-${randomUUID()}`)
                    await writeFile(temp, value.bytes, { mode: value.mode === "100755" ? 0o755 : 0o644, flag: "wx" })
                    await rename(temp, target).catch(async (cause) => {
                      await rm(temp, { force: true })
                      throw cause
                    })
                  })
                }
              }).pipe(Effect.onError(() => rollback(pending).pipe(Effect.orDie)))
              const merged = [...new Set([...record.merged, ...selected])]
              const complete = record.files.every((file) => merged.includes(file.path))
              const limits = yield* Limits
              const advanced = complete
                ? {}
                : record.mode === "worktree"
                  ? {
                      reviewBase: yield* IsolationBase.advanceGit(
                        {
                          parentDirectory: record.parentDirectory,
                          registry: paths(record.projectID, record.taskID).registry,
                          seed: record.seed!,
                          tip: record.tip!,
                          reviewBase: record.reviewBase,
                        },
                        selected,
                        command,
                      ),
                    }
                  : {
                      copyBase: (yield* io(() =>
                        IsolationBase.advanceCopy(
                          {
                            registry: paths(record.projectID, record.taskID).registry,
                            directory: record.directory,
                            baselineDirectory: baselinePaths(record).directory,
                          },
                          selected,
                          limits.fileBytes,
                        ),
                      )).name,
                    }
              const next = {
                ...pending,
                ...advanced,
                merged,
                mergeCompleted: true,
                state: complete ? "merged" : "changed",
              }
              yield* save(next)
              const events = yield* Effect.serviceOption(EventV2Bridge.Service)
              const ctx = yield* home
              if (Option.isSome(events))
                for (const target of targets) {
                  yield* events.value
                    .publish(FileSystem.Event.Edited, {
                      file: target,
                      sessionID: record.parentSessionID,
                      agent: record.agent.name,
                    })
                    .pipe(Effect.provideService(InstanceRef, ctx))
                  yield* events.value
                    .publish(Watcher.Event.Updated, { file: target, event: "change" })
                    .pipe(Effect.provideService(InstanceRef, ctx))
                }
              if (next.state === "merged") {
                const archived = { ...next, savedPatch: yield* savePatch(next, "merged") }
                yield* save(archived)
                yield* remove(archived)
                return {
                  record: archived,
                  merged: selected,
                  remaining: remaining.filter((file) => !selected.includes(file)),
                  conflicts: [],
                  checkpoint: next.checkpoint,
                }
              }
              return {
                record: next,
                merged: selected,
                remaining: remaining.filter((file) => !selected.includes(file)),
                conflicts: [],
                checkpoint: next.checkpoint,
              }
            }),
          ),
        )
      }),
    )
  })

  const discard = Effect.fn("TaskIsolation.discard")(function* (input: { taskID: string; by: By }) {
    return yield* lock(
      input.taskID,
      Effect.gen(function* () {
        const record = yield* get(input.taskID)
        if (input.by.kind === "agent" && input.by.sessionID !== record.parentSessionID)
          return yield* err("forbidden", "An agent may discard only its direct children.")
        if (["running", "settling"].includes(record.state) || active.has(record.taskID))
          return yield* err("running", "Stop and save the isolated task before discarding it.")
        if (["merged", "discarded", "unchanged"].includes(record.state)) return { record, saved: undefined }
        if (!["changed", "diverged"].includes(record.state) || !record.tip)
          return yield* err(
            "unsaved",
            "Partial changes have not been saved successfully. The checkout is retained; resume or recover it before discarding.",
          )
        return yield* FileLock.forTree(record.parentDirectory)(
          Effect.gen(function* () {
            yield* verify(record)
            yield* assertCaptured(record)
            const saved = yield* savePatch(record, "discarded")
            const pending = { ...record, state: "discarding", savedPatch: saved }
            yield* save(pending)
            yield* remove(pending)
            const next = { ...pending, state: "discarded" }
            yield* save(next)
            return { record: next, saved }
          }),
        )
      }),
    )
  })
  const resume = Effect.fn("TaskIsolation.resume")(function* (input: {
    taskID: string
    attempt: number
    agent: Expected
  }) {
    const next = yield* lock(
      input.taskID,
      Effect.gen(function* () {
        const record = yield* get(input.taskID)
        if (active.has(input.taskID)) return yield* err("running", "This isolated task is already running.")
        yield* check({ parentSessionID: record.parentSessionID, agent: input.agent, resumeID: input.taskID })
        if (stable(record.agent) !== stable(resolution(input.agent)))
          return yield* err("agent", "Agent configuration changed since this isolation was created.")
        const exists = yield* io(() =>
          lstat(record.directory)
            .then(() => true)
            .catch((cause) => {
              if (missing(cause)) return false
              throw cause
            }),
        )
        const ctx = yield* home
        if (exists) {
          const recovered = yield* verify(record, true)
          yield* protect(recovered)
          const loaded = yield* loadWork(recovered, ctx)
          const work = loaded.work
          return yield* Effect.gen(function* () {
            const resolved = yield* agents.get(record.agent.name).pipe(Effect.provideService(InstanceRef, work))
            if (!resolved || stable(resolution(resolved)) !== stable(record.agent))
              return yield* err("agent", "Agent configuration differs in the isolated instance.")
            TaskPlace.set(record.taskID, { work, home: ctx })
            const running = {
              ...recovered,
              attempt: input.attempt,
              settledAttempt: undefined,
              state: "running",
              files: yield* stats(recovered),
              merged: [],
              mergeStartedAt: undefined,
              mergeCompleted: undefined,
              mergeKey: undefined,
              mergeable: undefined,
              error: undefined,
            }
            yield* save(running)
            loaded.transferred = true
            return { existing: true as const, record: running, work }
          }).pipe(Effect.onError(() => retire(record).pipe(Effect.orDie)))
        }
        if (record.mode === "worktree") {
          // A missing worktree is not authority to prune arbitrary registrations; only this exact registry branch may be deleted.
          const listed = yield* text(record.parentDirectory, ["worktree", "list", "--porcelain"])
          if (listed.includes(`branch refs/heads/${record.branch}`))
            yield* FileLock.forTree(record.parentDirectory)(remove(record))
          const present = yield* run(record.parentDirectory, ["show-ref", "--verify", `refs/heads/${record.branch}`])
          if (present.exitCode === 0)
            return yield* err(
              "registry",
              "The reserved branch exists without its registered checkout; refusing to delete it.",
            )
        }
        const preparing = {
          ...record,
          attempt: input.attempt,
          settledAttempt: undefined,
          state: "preparing",
          merged: [],
          files: [],
          links: [],
          skipped: [],
          initialSkipped: [],
          largeBaseline: undefined,
          tip: undefined,
          seed: undefined,
          reviewBase: undefined,
          patchBase: undefined,
          unstackedSeed: undefined,
          copyBase: undefined,
          copyStacked: undefined,
          stackedIncluded: undefined,
        }
        yield* save(preparing)
        return { existing: false as const }
      }).pipe(Effect.scoped),
    )
    return next.existing ? next : yield* start(input.taskID)
  })
  const reconcile = Effect.fn("TaskIsolation.reconcile")(function* (taskID: string) {
    const initial = yield* get(taskID)
    const present = yield* io(() =>
      lstat(initial.directory)
        .then(() => true)
        .catch((cause) => {
          if (missing(cause)) return false
          throw cause
        }),
    )
    if (!present && initial.state === "preparing" && !initial.seed) {
      if (
        initial.mode === "worktree" &&
        (yield* run(initial.parentDirectory, ["show-ref", "--verify", `refs/heads/${initial.branch}`])).exitCode === 0
      )
        return yield* err("registry", "A reserved branch exists without a completed preparation; it has been retained.")
      const empty = { ...initial, state: "unchanged", settledAttempt: initial.attempt }
      yield* save(empty)
      TaskClaims.unprotect(taskID)
      return empty
    }
    const original =
      initial.mode === "worktree" && (!initial.gitDirectory || !initial.gitCommonDirectory)
        ? yield* verify(initial, true)
        : initial
    if (["preparing", "running", "settling", "failed"].includes(original.state) && !active.has(taskID))
      return yield* settle({ taskID, attempt: original.attempt, recover: true })
    return yield* lock(
      taskID,
      Effect.gen(function* () {
        const record = yield* get(taskID)
        const exists = yield* io(() =>
          lstat(record.directory)
            .then(() => true)
            .catch((cause) => {
              if (missing(cause)) return false
              throw cause
            }),
        )
        if (record.state === "discarding") {
          if (!record.savedPatch)
            return yield* err("unsaved", "Discard recovery requires its saved patch; the checkout is retained.")
          yield* io(() => guarded(record.savedPatch!))
          yield* io(() => lstat(record.savedPatch!))
          if (exists) yield* remove(record)
          const discarded = { ...record, state: "discarded" }
          yield* save(discarded)
          return discarded
        }
        if (exists) yield* protect(record)
        if (record.mergeStartedAt && !record.mergeCompleted)
          yield* FileLock.forTree(record.parentDirectory)(rollback(record))
        if (record.mergeCompleted && record.state === "merged") {
          const exists = yield* io(() =>
            lstat(record.directory)
              .then(() => true)
              .catch((cause) => {
                if (missing(cause)) return false
                throw cause
              }),
          )
          if (exists) {
            const archived = record.savedPatch ? record : { ...record, savedPatch: yield* savePatch(record, "merged") }
            yield* save(archived)
            yield* remove(archived)
          }
        }
        return yield* get(taskID)
      }),
    )
  })
  const sweep = Effect.fn("TaskIsolation.sweep")(function* (input: { force?: boolean } = {}) {
    const ctx = yield* home
    if (swept.has(ctx.project.id) && !input.force) return []
    swept.add(ctx.project.id)
    const output: string[] = []
    for (const record of yield* records()) {
      if (!record.deleted && !queued.has(record.taskID)) continue
      if (active.has(record.taskID)) continue
      if (["preparing", "failed", "discarding"].includes(record.state))
        yield* reconcile(record.taskID).pipe(Effect.option)
      const result = yield* discard({ taskID: record.taskID, by: { kind: "owner" } }).pipe(Effect.option)
      if (Option.isSome(result)) {
        output.push(record.taskID)
        queued.delete(record.taskID)
      }
    }
    return output
  })
  /** Deletion hooks only enqueue; a later sweep does the Git work outside Session.remove. */
  const enqueue = Effect.fn("TaskIsolation.enqueue")(function* (taskID: string) {
    const record = yield* get(taskID)
    queued.add(taskID)
    yield* save({ ...record, deleted: true })
  })
  /** Wire into execution admission in WP28: a retired isolation family must never silently run at home. */
  const admit = Effect.fn("TaskIsolation.admit")(function* (sessionID: string) {
    for (
      let id: string | undefined = sessionID, seen = new Set<string>();
      id && !seen.has(id);
      id = TaskPlace.parentOf(id)
    ) {
      seen.add(id)
      const record = yield* optional(id)
      if (!record) continue
      const place = TaskPlace.get(id)
      if (record.state !== "running" || !place || FileLock.key(place.work.directory) !== FileLock.key(record.directory))
        return yield* err("retired", "Resume this isolated task through its parent before running it or a descendant.")
    }
  })
  return {
    check,
    reserve,
    start,
    settle,
    changes,
    merge,
    discard,
    resume,
    reconcile,
    sweep,
    get,
    records,
    enqueue,
    admit,
  }
})

export type Interface = Effect.Success<typeof make>
export class Service extends Context.Service<Service, Interface>()("@vector/TaskIsolation") {}
export const layer = Layer.effect(Service, make)
export const node = LayerNode.make({ service: Service, layer, deps: [Git.node, Config.node, Agent.node] })
export * as TaskIsolation from "./isolation"
