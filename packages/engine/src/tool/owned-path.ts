import path from "node:path"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type { Tool } from "./tool"
import { realpath } from "./external-directory"

/** Explicit file tools enforce assignments. Shell execution is not a filesystem sandbox. */
export const assertOwnedPath = Effect.fn("Task.assertOwnedPath")(function* (context: Tool.Context, target: string) {
  if (!context.ownedPaths?.length) return
  const instance = yield* InstanceState.context
  const root = realpath(instance.directory)
  const destination = realpath(target)
  const inside = (parent: string, child: string) => {
    const relative = path.relative(parent, child)
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  }
  if (inside(root, destination) && context.ownedPaths.some((owned) => {
    const boundary = realpath(path.resolve(root, owned))
    return inside(root, boundary) && inside(boundary, destination)
  })) return
  return yield* Effect.die(new Error("This edit is outside the subagent's owned_paths. Report the required cross-boundary change to the parent; a message cannot expand file ownership."))
})
