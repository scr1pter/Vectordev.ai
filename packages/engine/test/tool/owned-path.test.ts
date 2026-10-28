import { describe, expect } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Effect, Exit } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { InstanceState } from "@/effect/instance-state"
import { TaskClaims } from "@/task/claims"
import { FileLock } from "@/tool/file-lock"
import { FileState } from "@/tool/file-state"
import { assertWritable, assertOwnedPath } from "@/tool/owned-path"
import type { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "@/session/schema"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))
const context: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  agent: "general",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
  ownedPaths: ["src/owned"],
}

describe("owned file mutation boundary", () => {
  it.instance("allows assigned descendants and rejects prefix lookalikes and traversal", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      yield* assertOwnedPath(context, path.join(instance.directory, "src/owned/new.ts"))
      for (const target of ["src/owned-other/new.ts", "src/owned/../other.ts", "../outside.ts"]) {
        expect(
          Exit.isFailure(yield* assertOwnedPath(context, path.resolve(instance.directory, target)).pipe(Effect.exit)),
        ).toBe(true)
      }
    }),
  )

  it.instance("refreshes trusted ownership after an explicit parent assignment update", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const refreshed = { ...context, getOwnedPaths: () => Effect.succeed(["src/owned", "src/added"]) }
      yield* assertOwnedPath(refreshed, path.join(instance.directory, "src/added/new.ts"))
      expect(
        Exit.isFailure(
          yield* assertOwnedPath(refreshed, path.join(instance.directory, "src/other/new.ts")).pipe(Effect.exit),
        ),
      ).toBe(true)
    }),
  )

  it.instance("resolves symlink ancestors before enforcing ownership", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const external = yield* tmpdirScoped()
      yield* Effect.promise(() => fs.mkdir(path.join(instance.directory, "src/owned"), { recursive: true }))
      yield* Effect.promise(() => fs.symlink(external, path.join(instance.directory, "src/owned/escape")))
      expect(
        Exit.isFailure(
          yield* assertOwnedPath(context, path.join(instance.directory, "src/owned/escape/new.ts")).pipe(Effect.exit),
        ),
      ).toBe(true)
      yield* assertOwnedPath({ ...context, ownedPaths: undefined }, path.join(instance.directory, "unassigned.ts"))
    }),
  )
})

describe("write ownership chokepoint", () => {
  it.instance("refuses a parent's write with the exact owned-path text and permits the child's helper", () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const file = path.join(instance.directory, "src/owned/new.ts")
      const owner = TaskClaims.reserve({
        tree: instance.worktree,
        directory: instance.directory,
        parentSessionID: "ses_root",
        taskID: "ses_owner",
        title: "Owner",
        paths: ["src/owned"],
      })
      const child = TaskClaims.reserve({
        tree: instance.worktree,
        directory: instance.directory,
        parentSessionID: "ses_owner",
        taskID: "ses_helper",
        title: "Helper",
        paths: [],
      })
      TaskClaims.bind(owner, "ses_owner")
      TaskClaims.bind(child, "ses_helper")
      const parent = { ...context, sessionID: SessionID.make("ses_root"), ownedPaths: undefined }
      const refused = yield* assertWritable(parent, { files: [file] }).pipe(Effect.exit)
      expect(String(Exit.isFailure(refused) && refused.cause)).toContain(
        `${file} belongs to the running subagent "Owner" (ses_owner), which owns src/owned. It was not changed. Wait for its report, send it the change with task_manage message, or stop it first.`,
      )
      yield* assertWritable(
        { ...parent, sessionID: SessionID.make("ses_helper"), parentID: SessionID.make("ses_owner") },
        { files: [file] },
      )
      TaskClaims.release(child)
      TaskClaims.release(owner)
    }),
  )

  it.instance("refuses a sibling's changed file until its owner settles", () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const file = path.join(instance.directory, "changed.ts")
      const claim = TaskClaims.reserve({
        tree: instance.worktree,
        directory: instance.directory,
        parentSessionID: "ses_root",
        taskID: "ses_owner",
        title: "Owner",
        paths: [],
      })
      TaskClaims.bind(claim, "ses_owner")
      FileState.wrote("ses_owner", file, undefined)
      const sibling = {
        ...context,
        sessionID: SessionID.make("ses_sibling"),
        parentID: SessionID.make("ses_root"),
        ownedPaths: undefined,
      }
      const refused = yield* assertWritable(sibling, { files: [file] }).pipe(Effect.exit)
      expect(String(Exit.isFailure(refused) && refused.cause)).toContain(
        `${file} was changed by the running subagent "Owner" (ses_owner) and stays its file until it finishes. It was not changed. Report the change you need to the parent.`,
      )
      TaskClaims.release(claim)
      yield* assertWritable(sibling, { files: [file] })
    }),
  )

  it.instance("two unscoped writers recheck ownership inside the same file lock", () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const file = path.join(instance.directory, "race.ts")
      const claims = ["ses_first", "ses_second"].map((taskID) =>
        TaskClaims.reserve({
          tree: instance.worktree,
          directory: instance.directory,
          parentSessionID: "ses_root",
          taskID,
          title: taskID,
          paths: [],
        }),
      )
      claims.forEach((claim) => TaskClaims.bind(claim, claim.taskID!))
      const contexts = claims.map((claim) => ({
        ...context,
        sessionID: SessionID.make(claim.taskID!),
        parentID: SessionID.make("ses_root"),
        ownedPaths: undefined,
      }))
      // Both passed before either changed the file: the second check must run inside the lock.
      for (const writer of contexts) yield* assertWritable(writer, { files: [file] })
      const writes: string[] = []
      const exits = yield* Effect.forEach(
        contexts,
        (writer) =>
          FileLock.withFiles([file])(
            Effect.gen(function* () {
              yield* assertWritable(writer, { files: [file] })
              yield* Effect.promise(() => fs.writeFile(file, writer.sessionID))
              yield* FileState.commit({ sessionID: writer.sessionID, file })
              writes.push(writer.sessionID)
            }),
          ).pipe(Effect.exit),
        { concurrency: 2 },
      )
      expect(writes).toHaveLength(1)
      expect(exits.filter(Exit.isFailure)).toHaveLength(1)
      expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(writes[0])
      claims.forEach(TaskClaims.release)
    }),
  )
})
