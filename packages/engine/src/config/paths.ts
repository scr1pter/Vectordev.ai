export * as ConfigPaths from "./paths"

import path from "path"
import { lstatSync, readlinkSync } from "fs"
import { Flag } from "@vectordevai/core/flag/flag"
import { Global } from "@vectordevai/core/global"
import { unique } from "remeda"
import { Effect } from "effect"
import { FSUtil } from "@vectordevai/core/fs-util"
import { ConfigImport } from "./import-settings"

const migrate = (directory: string, worktree?: string) =>
  ConfigImport.discover({
    directory,
    worktree,
    global: Global.Path.config,
    home: Global.Path.home,
    disableProject: Flag.VECTOR_DISABLE_PROJECT_CONFIG,
  })

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  yield* migrate(directory, worktree)
  return (yield* afs.up({
    targets: [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
})

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* FSUtil.Service
  yield* migrate(directory, worktree)
  const agentDirectory = yield* environmentPath(Flag.VECTOR_AGENT_CONFIG_DIR, { directory, worktree })
  const result = unique([
    Global.Path.config,
    ...(!Flag.VECTOR_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets: [".vector"],
          start: directory,
          stop: worktree,
        })
      : []),
    ...(yield* afs.up({
      targets: [".vector"],
      start: Global.Path.home,
      stop: Global.Path.home,
    })),
    ...(agentDirectory ? [agentDirectory.path] : []),
  ])
  return result
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}

/**
 * The project's own spelling of `file` when the project owns it, or nothing when it is the user's. A path is the
 * project's when it passes through the project under any spelling: as written, once any directory on its way is
 * resolved (a project's own link stays the project's wherever it points), at any link it passes through on the way
 * (a user's link to a project link that points out again), or where it finally lands (a link from outside into the
 * project). It comes back rebased into the project's own spelling, so containment checks, the trust snapshot and
 * plugin scope all agree; a path inside the project as written keeps that spelling, so trust binds a symlinked config
 * file to its logical identity. The user's own config folders stay theirs even when the workspace is their home or
 * config folder. A path that cannot be resolved (a link loop) is treated as the project's, which holds it back until
 * trust.
 */
export function projectPath(file: string, ctx: { directory: string; worktree?: string }): string | undefined {
  const requested = path.resolve(FSUtil.windowsPath(file))
  if (userOwned(requested)) return
  try {
    return classify(requested, roots(ctx))
  } catch {
    return requested
  }
}

export function projectContains(file: string, ctx: { directory: string; worktree?: string }) {
  return projectPath(file, ctx) !== undefined
}

/**
 * Where a config file or directory named by an environment variable is read from, and whether the project owns it
 * (see projectPath). Anything that is not the project's is read exactly where it was classified, because the raw
 * value can name another file: `..` is collapsed before classifying, while the kernel follows a link before applying
 * `..`. A path that cannot be resolved is not loaded at all rather than trusted as the user's own.
 */
export const environmentPath = Effect.fnUntraced(function* (
  input: string | undefined,
  ctx: { directory: string; worktree?: string },
) {
  if (!input) return
  const requested = path.resolve(FSUtil.windowsPath(input))
  if (userOwned(requested)) return { path: requested, project: false }
  return yield* Effect.try({ try: () => classify(requested, roots(ctx)), catch: (cause) => cause }).pipe(
    Effect.map((project) => (project ? { path: project, project: true } : { path: requested, project: false })),
    Effect.catch((cause) =>
      Effect.logWarning("ignoring a config path that cannot be resolved", { path: input, cause: String(cause) }).pipe(
        Effect.as(undefined),
      ),
    ),
  )
})

// Non-git projects set worktree to "/", which would contain every path.
function roots(ctx: { directory: string; worktree?: string }) {
  return ctx.worktree && ctx.worktree !== "/" ? [ctx.directory, ctx.worktree] : [ctx.directory]
}

/** Whether a path lies in the user's own config folders, which stay theirs even inside a workspace. */
export function userOwned(file: string) {
  return [Global.Path.config, path.join(Global.Path.home, ".vector")].some((root) => FSUtil.contains(root, file))
}

function classify(requested: string, roots: string[]) {
  // As written first, which needs no file system access.
  const written = rebase(requested, roots, roots)
  if (written) return written
  const bases = roots.map((root) => FSUtil.realpath(root))
  return [
    ...ancestors(requested).map((parent) => path.join(FSUtil.realpath(parent), path.relative(parent, requested))),
    ...passes(requested),
    FSUtil.realpath(requested),
  ]
    .map((spelling) => rebase(spelling, roots, bases))
    .find((item) => item !== undefined)
}

// The spelling moved onto the first root whose form in `bases` contains it.
function rebase(spelling: string, roots: string[], bases: string[]) {
  const index = bases.findIndex((base) => FSUtil.contains(base, spelling))
  if (index === -1) return
  return path.join(roots[index], path.relative(bases[index], spelling))
}

// Every link the path passes through while it resolves, one step at a time, spelled as the link's own location
// followed by the rest of the path. Resolving whole parents at once skips the middle of a chain: a user's link to a
// project's link that points out of the project would land outside without ever being seen inside it.
function passes(file: string) {
  const split = (value: string) => value.split(process.platform === "win32" ? /[\\/]/ : "/")
  const start = path.parse(file).root
  const walk = (current: string, rest: string[], hops: number): string[] => {
    if (!rest.length) return []
    const [name, ...remaining] = rest
    if (name === "" || name === ".") return walk(current, remaining, hops)
    // `current` has no links in it, so its parent is the real one.
    if (name === "..") return walk(path.dirname(current), remaining, hops)
    const next = path.join(current, name)
    const info = lstatSync(next, { throwIfNoEntry: false })
    // Nothing below an entry that does not exist can be a link.
    if (!info) return []
    if (!info.isSymbolicLink()) return walk(next, remaining, hops)
    if (hops >= 40) throw new Error(`Too many links in ${file}`)
    // The target's own `..` is applied after its links, as the kernel does, so it is not collapsed up front.
    const target = readlinkSync(next)
    const root = path.isAbsolute(target) ? path.parse(target).root : ""
    return [
      path.join(FSUtil.normalizePath(current), name, ...remaining),
      ...walk(root || current, [...split(target.slice(root.length)), ...remaining], hops + 1),
    ]
  }
  return walk(start, split(file.slice(start.length)), 0)
}

// Deepest first, so the path that comes back is resolved as far as it stays inside the project.
function ancestors(file: string): string[] {
  const parent = path.dirname(file)
  if (parent === file) return []
  return [parent, ...ancestors(parent)]
}
