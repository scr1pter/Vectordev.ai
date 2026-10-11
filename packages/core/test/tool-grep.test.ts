import fs from "fs/promises"
import path from "path"
import { beforeAll, describe, expect } from "bun:test"
import { Effect, Layer, PlatformError } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FileSystem } from "@vectordevai/core/filesystem"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Location } from "@vectordevai/core/location"
import { LocationMutation } from "@vectordevai/core/location-mutation"
import { PermissionV2 } from "@vectordevai/core/permission"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { AbsolutePath, RelativePath } from "@vectordevai/core/schema"
import { SessionV2 } from "@vectordevai/core/session"
import { internalSessionPermissions } from "@vectordevai/core/session/permission"
import { GrepTool } from "@vectordevai/core/tool/grep"
import { ToolRegistry } from "@vectordevai/core/tool/registry"
import { ToolOutputStore } from "@vectordevai/core/tool-output-store"
import { location, tempLocationLayer } from "./fixture/location"
import { prepareRipgrep } from "./fixture/ripgrep"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_grep_security_test")
const assertions: PermissionV2.AssertInput[] = []
const searches: Ripgrep.GrepInput[] = []

const ripgrep = Layer.succeed(
  Ripgrep.Service,
  Ripgrep.Service.of({
    glob: () => Effect.die("unused"),
    grep: (input) =>
      Effect.sync(() => {
        searches.push(input)
        return [
          FileSystem.Match.make({
            entry: FileSystem.Entry.make({ path: RelativePath.make("found.ts"), type: "file" }),
            line: 1,
            offset: 0,
            text: "needle",
            submatches: [],
          }),
        ]
      }),
    find: () => Effect.die("unused"),
  }),
)
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    deniedResources: () => Effect.succeed([]),
    assert: (input) => Effect.sync(() => assertions.push(input)),
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
        LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, LocationMutation.node, GrepTool.node]),
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
  call: { type: "tool-call" as const, id: `call-grep-${path}`, name: "grep", input: { pattern: "needle", path } },
})
const it = testEffect(Layer.empty)

describe("GrepTool path boundary", () => {
  it.live("canonicalizes and approves an explicit absolute external file", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        assertions.length = 0
        searches.length = 0
        const file = path.join(outside.path, "outside.txt")
        return Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(file, "needle"))
          yield* withTool(active.path, (registry) => executeTool(registry, call(file)))
          expect(assertions.map((assertion) => assertion.action)).toEqual(["external_directory", "grep", "read"])
          expect(searches).toMatchObject([
            { cwd: yield* Effect.promise(() => fs.realpath(outside.path)), file: "./outside.txt" },
          ])
        })
      },
      ([active, outside]) =>
        Effect.promise(() => Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()])).pipe(
          Effect.asVoid,
        ),
    ),
  )

  it.live("rejects relative and symlink escapes before grep", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        assertions.length = 0
        searches.length = 0
        return Effect.gen(function* () {
          yield* withTool(active.path, (registry) => executeTool(registry, call("../outside.txt")))
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
})

const layer = (
  permission = Layer.mock(PermissionV2.Service, {
    assert: () => Effect.void,
    deniedResources: () => Effect.succeed([]),
  }),
  filesystem = LayerNode.compile(FSUtil.node),
) =>
  AppNodeBuilder.build(
    LayerNode.group([
      FSUtil.node,
      Location.node,
      LocationMutation.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      GrepTool.node,
    ]),
    [
      [Location.node, tempLocationLayer],
      [PermissionV2.node, permission],
      [FSUtil.node, filesystem],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  )
const real = testEffect(layer())
const literal = (input: typeof GrepTool.Input.Encoded) => ({
  sessionID: SessionV2.ID.make("ses_grep_tool_test"),
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call-grep", name: "grep", input },
})

describe("GrepTool", () => {
  beforeAll(prepareRipgrep, 65_000)

  real.live("rejects a missing literal file without searching its siblings", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const registry = yield* ToolRegistry.Service
      yield* fs.writeFileString(path.join(location.directory, "sibling.txt"), "needle: unrelated sibling\n")

      expect(yield* executeTool(registry, literal({ pattern: "needle", path: "missing.txt" }))).toEqual({
        type: "error",
        value:
          "Search path does not exist: missing.txt. 'path' is a literal file or directory; use 'include' for file globs.",
      })
    }),
  )

  real.live("rejects a missing literal directory instead of searching its parent", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const registry = yield* ToolRegistry.Service
      yield* fs.makeDirectory(path.join(location.directory, "src"))
      yield* fs.writeFileString(path.join(location.directory, "src", "sibling.txt"), "needle\n")

      expect(yield* executeTool(registry, literal({ pattern: "needle", path: "src/missing{a,b}" }))).toEqual({
        type: "error",
        value:
          "Search path does not exist: src/missing{a,b}. 'path' is a literal file or directory; use 'include' for file globs.",
      })
    }),
  )

  real.live("searches literal brace-named files and directories without expanding them", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const registry = yield* ToolRegistry.Service
      yield* fs.makeDirectory(path.join(location.directory, "dir{a,b}"))
      yield* fs.writeFileString(path.join(location.directory, "dir{a,b}", "literal{a,b}.txt"), "needle literal\n")
      yield* fs.writeFileString(path.join(location.directory, "dir{a,b}", "sibling.txt"), "needle sibling\n")
      yield* fs.makeDirectory(path.join(location.directory, "dira"))
      yield* fs.writeFileString(path.join(location.directory, "dira", "expanded.txt"), "needle expanded\n")

      const file = yield* executeTool(registry, literal({ pattern: "needle", path: "dir{a,b}/literal{a,b}.txt" }))
      expect(file.type).toBe("text")
      expect(file.value).toContain("needle literal")
      expect(file.value).not.toContain("needle sibling")
      expect(file.value).not.toContain("needle expanded")
      const directory = yield* executeTool(registry, literal({ pattern: "needle", path: "dir{a,b}" }))
      expect(directory.value).toContain("needle literal")
      expect(directory.value).toContain("needle sibling")
      expect(directory.value).not.toContain("needle expanded")
    }),
  )

  real.live("preserves omitted root, include filtering and genuine no-match results", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const registry = yield* ToolRegistry.Service
      yield* fs.writeFileString(path.join(location.directory, "match.ts"), "needle included\n")
      yield* fs.writeFileString(path.join(location.directory, "ignore.txt"), "needle excluded\n")
      const result = yield* executeTool(registry, literal({ pattern: "needle", include: "*.ts" }))
      expect(result.value).toContain("needle included")
      expect(result.value).not.toContain("needle excluded")
      expect(yield* executeTool(registry, literal({ pattern: "absent", path: "match.ts" }))).toEqual({
        type: "text",
        value: "No files found",
      })
      expect(yield* executeTool(registry, literal({ pattern: "[", path: "match.ts" }))).toEqual({
        type: "error",
        value: "Unable to grep for [",
      })
    }),
  )

  real.live("searches a file named dash instead of treating it as stdin", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const registry = yield* ToolRegistry.Service
      yield* fs.writeFileString(path.join(location.directory, "-"), "needle literal dash\n")
      yield* fs.writeFileString(path.join(location.directory, "sibling.txt"), "needle sibling\n")
      const result = yield* executeTool(registry, literal({ pattern: "needle", path: "-" }))
      expect(result.type).toBe("text")
      expect(result.value).toContain("needle literal dash")
      expect(result.value).not.toContain("needle sibling")
    }),
  )
})

const denied = testEffect(
  layer(
    Layer.mock(PermissionV2.Service, {
      assert: (input) =>
        Effect.sync(() => {
          expect(input).toMatchObject({
            action: "grep",
            resources: ["needle"],
            metadata: { path: "missing.txt" },
            source: { type: "tool", messageID: toolIdentity.assistantMessageID, callID: "call-grep" },
          })
        }).pipe(Effect.andThen(new PermissionV2.DeniedError({ rules: [] }))),
    }),
    Layer.effect(
      FSUtil.Service,
      FSUtil.Service.use((fs) =>
        Effect.succeed({
          ...fs,
          // Resolving the workspace boundary inspects the existing parent directory first; the target itself is only
          // inspected once grep is allowed.
          stat: (target) =>
            path.basename(target) === "missing.txt"
              ? Effect.die("stat must not run before permission")
              : fs.stat(target),
        }),
      ),
    ).pipe(Layer.provide(LayerNode.compile(FSUtil.node))),
  ),
)

denied.live("grep permission denial precedes target inspection", () =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    expect(yield* executeTool(registry, literal({ pattern: "needle", path: "missing.txt" }))).toEqual({
      type: "error",
      value: "Unable to grep for needle",
    })
  }),
)

const inaccessible = testEffect(
  layer(
    undefined,
    Layer.effect(
      FSUtil.Service,
      FSUtil.Service.use((fs) =>
        Effect.succeed({
          ...fs,
          stat: (target) =>
            path.basename(target) === "inaccessible.txt"
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "stat",
                    pathOrDescriptor: target,
                  }),
                )
              : fs.stat(target),
        }),
      ),
    ).pipe(Layer.provide(LayerNode.compile(FSUtil.node))),
  ),
)

inaccessible.live("a non-NotFound stat error stays a failure instead of searching siblings", () =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const registry = yield* ToolRegistry.Service
    yield* fs.writeFileString(path.join(location.directory, "sibling.txt"), "needle unrelated\n")
    expect(yield* executeTool(registry, literal({ pattern: "needle", path: "inaccessible.txt" }))).toEqual({
      type: "error",
      value: "Unable to grep for needle",
    })
  }),
)

const helperRules = [
  ...internalSessionPermissions("swarm.planner"),
  { action: "read", resource: "*blocked.txt", effect: "deny" as const },
]
const helperReads: PermissionV2.AssertInput[] = []
const helperDirectory = { path: "" }
const helper = testEffect(
  layer(
    Layer.mock(PermissionV2.Service, {
      deniedResources: (input) =>
        Effect.succeed(
          input.resources.filter(
            (resource) => PermissionV2.evaluate(input.action, resource, helperRules).effect === "deny",
          ),
        ),
      assert: (input) =>
        Effect.gen(function* () {
          if (
            input.resources.some(
              (resource) => PermissionV2.evaluate(input.action, resource, helperRules).effect === "deny",
            )
          )
            return yield* new PermissionV2.DeniedError({ rules: helperRules })
          if (input.action !== "read") return
          helperReads.push(input)
          // A newly created file must not enter a search whose file set was already admitted.
          yield* Effect.promise(() => Bun.write(path.join(helperDirectory.path, "late.txt"), "needle late-unapproved"))
        }),
    }),
  ),
)

helper.live(
  "helper grep admits filenames before reading and excludes denied content across literal and directory searches",
  () =>
    Effect.gen(function* () {
      const filesystem = yield* FSUtil.Service
      const location = yield* Location.Service
      const registry = yield* ToolRegistry.Service
      yield* filesystem.makeDirectory(path.join(location.directory, "nested"))
      for (const [file, contents] of [
        [".env", "needle FAKE_SECRET_ONLY"],
        ["nested/private.key", "needle FAKE_KEY_ONLY"],
        ["blocked.txt", "needle arbitrary-denied"],
        ["source.ts", "needle permitted-source"],
      ])
        yield* filesystem.writeFileString(path.join(location.directory, file), contents)
      helperReads.length = 0
      helperDirectory.path = location.directory
      const directory = yield* executeTool(registry, literal({ pattern: "needle" }))
      expect(directory.value).toContain("permitted-source")
      expect(directory.value).not.toContain("FAKE_")
      expect(directory.value).not.toContain("arbitrary-denied")
      expect(directory.value).not.toContain("late-unapproved")
      expect(helperReads).toHaveLength(1)
      expect(helperReads[0].resources).toEqual(["source.ts"])
      for (const file of [".env", "blocked.txt", "nested/private.key"])
        expect((yield* executeTool(registry, literal({ pattern: "needle", path: file }))).type).toBe("error")
      expect((yield* executeTool(registry, literal({ pattern: "needle", include: "*.env" }))).value).toBe(
        "No files found",
      )
      expect((yield* executeTool(registry, literal({ pattern: "needle", path: "nested" }))).value).toBe(
        "No files found",
      )
      if (process.platform !== "win32") {
        yield* Effect.promise(() => fs.symlink(".env", path.join(location.directory, "innocent.txt")))
        expect((yield* executeTool(registry, literal({ pattern: "needle", path: "innocent.txt" }))).type).toBe("error")
        yield* Effect.promise(() => fs.symlink("nested", path.join(location.directory, "alias")))
        expect((yield* executeTool(registry, literal({ pattern: "needle", path: "alias" }))).value).toBe(
          "No files found",
        )
      }
    }),
)

real.live("directory grep preserves explicitly authorized environment-file reads", () =>
  Effect.gen(function* () {
    const filesystem = yield* FSUtil.Service
    const location = yield* Location.Service
    const registry = yield* ToolRegistry.Service
    yield* filesystem.writeFileString(path.join(location.directory, ".env"), "needle authorized-fixture")
    expect((yield* executeTool(registry, literal({ pattern: "needle", include: "*.env" }))).value).toContain(
      "authorized-fixture",
    )
  }),
)
