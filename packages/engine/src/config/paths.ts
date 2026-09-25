export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@vectordevai/core/flag/flag"
import { Global } from "@vectordevai/core/global"
import { unique } from "remeda"
import { Effect } from "effect"
import { FSUtil } from "@vectordevai/core/fs-util"

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  return (yield* afs.up({
    targets: [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
})

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* FSUtil.Service
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
