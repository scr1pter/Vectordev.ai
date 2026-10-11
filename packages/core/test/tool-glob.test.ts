import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FileSystem } from "@vectordevai/core/filesystem"
import { Location } from "@vectordevai/core/location"
import { LocationMutation } from "@vectordevai/core/location-mutation"
import { PermissionV2 } from "@vectordevai/core/permission"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { AbsolutePath, RelativePath } from "@vectordevai/core/schema"
import { SessionV2 } from "@vectordevai/core/session"
import { GlobTool } from "@vectordevai/core/tool/glob"
import { ToolRegistry } from "@vectordevai/core/tool/registry"
import { ToolOutputStore } from "@vectordevai/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_glob_security_test")
const assertions: PermissionV2.AssertInput[] = []
const searches: Ripgrep.GlobInput[] = []
let denyExternal = false

const ripgrep = Layer.succeed(
  Ripgrep.Service,
  Ripgrep.Service.of({
    glob: (input) =>
      Effect.sync(() => {
        searches.push(input)
        return [FileSystem.Entry.make({ path: RelativePath.make("found.ts"), type: "file" })]
      }),
    grep: () => Effect.die("unused"),
    find: () => Effect.die("unused"),
  }),
)
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    deniedResources: () => Effect.succeed([]),
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(
          denyExternal && input.action === "external_directory"
            ? Effect.fail(new PermissionV2.DeniedError({ rules: [] }))
            : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

function withTool<A, E, R>(directory: string, body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>) {
  const active = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.flatMap(ToolRegistry.Service, body).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, LocationMutation.node, GlobTool.node]),
        [
          [Location.node, active],
          [PermissionV2.node, permission],
          [Ripgrep.node, ripgrep],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )
}

const call = (path?: string) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: `call-glob-${path}`, name: "glob", input: { pattern: "*.ts", path } },
})
const it = testEffect(Layer.empty)

describe("GlobTool path boundary", () => {
  it.live("canonicalizes internal roots and approves explicit external roots", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        assertions.length = 0
        searches.length = 0
        denyExternal = false
        return Effect.gen(function* () {
          yield* withTool(active.path, (registry) => executeTool(registry, call(outside.path)))
          expect(assertions.map((assertion) => assertion.action)).toEqual(["external_directory", "glob"])
          expect(searches.map((search) => search.cwd)).toEqual([yield* Effect.promise(() => fs.realpath(outside.path))])
        })
      },
      ([active, outside]) =>
        Effect.promise(() => Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()])).pipe(
          Effect.asVoid,
        ),
    ),
  )

  it.live("rejects relative and symlink escapes before search", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        assertions.length = 0
        searches.length = 0
        return Effect.gen(function* () {
          yield* withTool(active.path, (registry) => executeTool(registry, call("../escape")))
          if (process.platform !== "win32") {
            yield* Effect.promise(() => fs.symlink(outside.path, path.join(active.path, "escape")))
            yield* withTool(active.path, (registry) => executeTool(registry, call("escape")))
          }
          expect(assertions).toEqual([])
          expect(searches).toEqual([])
        })
      },
      ([active, outside]) =>
        Effect.promise(() => Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()])).pipe(
          Effect.asVoid,
        ),
    ),
  )

  it.live("does not search an absolute external root when approval is denied", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        assertions.length = 0
        searches.length = 0
        denyExternal = true
        return withTool(active.path, (registry) => executeTool(registry, call(outside.path))).pipe(
          Effect.andThen(
            Effect.sync(() => {
              expect(assertions.map((assertion) => assertion.action)).toEqual(["external_directory"])
              expect(searches).toEqual([])
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() => Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()])).pipe(
          Effect.asVoid,
        ),
    ),
  )
})
