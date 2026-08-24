import path from "path"
import { lstatSync, readlinkSync } from "fs"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type * as Tool from "./tool"
import { containsPath } from "../project/instance-context"
import { FSUtil } from "@opencode-ai/core/fs-util"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

export const assertExternalDirectoryEffect = Effect.fn("Tool.assertExternalDirectory")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  if (!target) return false

  if (options?.bypass) return false

  const ins = yield* InstanceState.context
  // Containment is decided on the real destination, never on the requested path.
  // A symlink committed inside the project satisfies a purely textual check, so
  // checking the requested path would let any repository that ships such a link
  // hand a tool unprompted read and write access to the rest of the filesystem.
  // Both sides have to be resolved: the instance directory is itself commonly
  // reached through a link (/tmp -> /private/tmp on macOS), and comparing a real
  // path against a symlinked root would prompt for every file in the project.
  const full = realpath(target)
  if (
    containsPath(full, {
      ...ins,
      directory: realpath(ins.directory),
      worktree: realpath(ins.worktree),
    })
  )
    return false

  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? full : path.dirname(full)
  // Lexical only: FSUtil.resolve runs realpathSync, which would follow the very
  // link whose name the rule is meant to keep.
  const requested = path.resolve(FSUtil.windowsPath(target))
  const requestedDir = kind === "directory" ? requested : path.dirname(requested)
  const asGlob = (value: string) =>
    process.platform === "win32"
      ? FSUtil.normalizePathPattern(path.join(value, "*"))
      : path.join(value, "*").replaceAll("\\", "/")
  // The rule is written against the path the caller actually asked for, so an
  // allow the user already granted on a link keeps matching and approving once
  // does not silently depend on where the link happens to point today.
  // Containment above is still decided on the resolved destination, so this
  // only changes which name the rule carries, never whether we ask.
  const glob = asGlob(requestedDir)
  const resolvedGlob = asGlob(dir)

  yield* ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      // The resolved path, so an approval reads as the directory that is really
      // being opened up rather than the in-project name of the link.
      filepath: full,
      parentDir: dir,
      // Surfaced separately so an approval prompt can show that the requested
      // path is a link and where it lands.
      ...(resolvedGlob === glob ? {} : { requestedPath: requested }),
    },
  })
  return true
})

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  return Effect.runPromise(assertExternalDirectoryEffect(ctx, target, options))
}

function realpath(target: string): string {
  const resolved = FSUtil.resolve(target)
  const link = lstatSync(resolved, { throwIfNoEntry: false })
  // A dangling symlink cannot be resolved by realpath, but writing through it
  // still lands wherever it points, so follow the link by hand.
  if (link?.isSymbolicLink()) return realpath(path.resolve(path.dirname(resolved), readlinkSync(resolved)))
  if (link) return resolved
  // FSUtil.resolve hands back the lexical path for something that does not exist
  // yet, which still looks project-local when a parent is a link pointing out of
  // the project. Resolve the deepest existing ancestor and re-attach the rest so
  // creating a file cannot escape either.
  const parent = path.dirname(resolved)
  if (parent === resolved) return resolved
  return path.join(realpath(parent), path.basename(resolved))
}
