import { describe, expect } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Effect, Exit } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { assertOwnedPath } from "@/tool/owned-path"
import type { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "@/session/schema"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))
const context: Tool.Context = {
  sessionID: SessionID.make("ses_test"), messageID: MessageID.make("msg_test"), agent: "general",
  abort: new AbortController().signal, messages: [], metadata: () => Effect.void, ask: () => Effect.void,
  ownedPaths: ["src/owned"],
}

describe("owned file mutation boundary", () => {
  it.instance("allows assigned descendants and rejects prefix lookalikes and traversal", () => Effect.gen(function* () {
    const instance = yield* TestInstance
    yield* assertOwnedPath(context, path.join(instance.directory, "src/owned/new.ts"))
    for (const target of ["src/owned-other/new.ts", "src/owned/../other.ts", "../outside.ts"]) {
      expect(Exit.isFailure(yield* assertOwnedPath(context, path.resolve(instance.directory, target)).pipe(Effect.exit))).toBe(true)
    }
  }))

  it.instance("refreshes trusted ownership after an explicit parent assignment update", () => Effect.gen(function* () {
    const instance = yield* TestInstance
    const refreshed = { ...context, getOwnedPaths: () => Effect.succeed(["src/owned", "src/added"]) }
    yield* assertOwnedPath(refreshed, path.join(instance.directory, "src/added/new.ts"))
    expect(Exit.isFailure(yield* assertOwnedPath(refreshed, path.join(instance.directory, "src/other/new.ts")).pipe(Effect.exit))).toBe(true)
  }))

  it.instance("resolves symlink ancestors before enforcing ownership", () => Effect.gen(function* () {
    const instance = yield* TestInstance
    const external = yield* tmpdirScoped()
    yield* Effect.promise(() => fs.mkdir(path.join(instance.directory, "src/owned"), { recursive: true }))
    yield* Effect.promise(() => fs.symlink(external, path.join(instance.directory, "src/owned/escape")))
    expect(Exit.isFailure(yield* assertOwnedPath(context, path.join(instance.directory, "src/owned/escape/new.ts")).pipe(Effect.exit))).toBe(true)
    yield* assertOwnedPath({ ...context, ownedPaths: undefined }, path.join(instance.directory, "unassigned.ts"))
  }))
})
