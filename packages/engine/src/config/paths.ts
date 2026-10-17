export * as ConfigPaths from "./paths"

import path from "path"
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
    ...(Flag.VECTOR_AGENT_CONFIG_DIR ? [Flag.VECTOR_AGENT_CONFIG_DIR] : []),
  ])
  return result
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}

// Config authority follows the workspace even through an external path alias. Keep lexical project paths
// intact so trust snapshots still bind symlinked config files to their original logical identity.
export function projectPath(file: string, ctx: { directory: string; worktree?: string }): string | undefined {
  const roots = [ctx.directory, ...(ctx.worktree && ctx.worktree !== "/" ? [ctx.worktree] : [])]
  if (roots.some((root) => FSUtil.contains(root, file))) return path.resolve(file)
  const resolved = FSUtil.resolve(file)
  if (roots.some((root) => FSUtil.contains(FSUtil.resolve(root), resolved))) return resolved
}

export function projectContains(file: string, ctx: { directory: string; worktree?: string }) {
  return projectPath(file, ctx) !== undefined
}
