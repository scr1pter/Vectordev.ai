import path from "node:path"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@vectordevai/core/fs-util"
import { TaskClaims } from "@/task/claims"
import { TaskSize } from "@vectordevai/core/task-size"
import type { Tool } from "./tool"

type Context = Pick<Tool.Context, "sessionID" | "parentID" | "getOwnedPaths" | "ownedPaths">

/** Explicit file tools enforce assignments. Shell execution is not a filesystem sandbox. */
export const assertOwnedPath = Effect.fn("Task.assertOwnedPath")(function* (context: Context, target: string) {
  const ownedPaths = context.getOwnedPaths ? yield* context.getOwnedPaths() : context.ownedPaths
  if (!ownedPaths?.length) return
  const instance = yield* InstanceState.context
  const root = FSUtil.realpath(instance.directory)
  const destination = FSUtil.realpath(target)
  const inside = (parent: string, child: string) => {
    const relative = path.relative(parent, child)
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  }
  if (
    inside(root, destination) &&
    ownedPaths.some((owned) => {
      const boundary = FSUtil.realpath(path.resolve(root, owned))
      return inside(root, boundary) && inside(boundary, destination)
    })
  )
    return
  return yield* Effect.die(
    new Error(
      "This edit is outside the subagent's owned_paths. Report the required cross-boundary change to the parent; a message cannot expand file ownership.",
    ),
  )
})

/** Refuses conflicting ownership before prompting and again inside the file lock. */
export const assertWritable = Effect.fn("OwnedPath.assertWritable")(function* (
  context: Context,
  input: { files: readonly string[]; via?: "shell" | "file" },
) {
  const instance = yield* InstanceState.context
  for (const file of input.files) {
    const protectedTree = TaskClaims.protectedConflict(context.sessionID, file)
    if (protectedTree)
      return yield* Effect.die(
        new Error(`${file} is protected for subagent ${protectedTree.taskID}. It was not changed.`),
      )
    const destination = TaskClaims.parentTarget(context.sessionID, file)
    if (destination)
      return yield* Effect.die(
        new Error(
          `An isolated subagent cannot edit its parent's working tree. Change ${destination} in your worktree instead.`,
        ),
      )
    yield* assertOwnedPath(context, file)
    const conflict = TaskClaims.conflicts({ tree: instance.worktree, sessionID: context.sessionID, file })[0]
    if (!conflict) continue
    const title = TaskSize.neutralizeTags(conflict.entry.title)
    const who = `the running subagent "${title}" (${conflict.entry.taskID ?? "starting"})`
    const reason =
      conflict.owned !== undefined
        ? `${file} belongs to ${who}, which owns ${conflict.owned}. It was not changed.`
        : `${file} was changed by ${who} and stays its file until it finishes. It was not changed.`
    const next = context.parentID
      ? "Report the change you need to the parent."
      : "Wait for its report, send it the change with task_manage message, or stop it first."
    return yield* Effect.die(new Error(`${reason} ${next}`))
  }
})
