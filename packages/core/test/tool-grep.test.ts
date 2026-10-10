import { beforeAll, describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer, PlatformError } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Location } from "@vectordevai/core/location"
import { PermissionV2 } from "@vectordevai/core/permission"
import { SessionV2 } from "@vectordevai/core/session"
import { GrepTool } from "@vectordevai/core/tool/grep"
import { ToolRegistry } from "@vectordevai/core/tool/registry"
import { ToolOutputStore } from "@vectordevai/core/tool-output-store"
import { tempLocationLayer } from "./fixture/location"
import { prepareRipgrep } from "./fixture/ripgrep"
import { testEffect } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"

const layer = (
  permission = Layer.mock(PermissionV2.Service, { assert: () => Effect.void }),
  filesystem = LayerNode.compile(FSUtil.node),
) =>
  AppNodeBuilder.build(
    LayerNode.group([FSUtil.node, Location.node, ToolRegistry.node, ToolRegistry.toolsNode, GrepTool.node]),
    [
      [Location.node, tempLocationLayer],
      [PermissionV2.node, permission],
      [FSUtil.node, filesystem],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  )
const it = testEffect(layer())
const call = (input: typeof GrepTool.Input.Encoded) => ({
  sessionID: SessionV2.ID.make("ses_grep_tool_test"),
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call-grep", name: "grep", input },
})

describe("GrepTool", () => {
  beforeAll(prepareRipgrep, 65_000)

  it.live("rejects a missing literal file without searching its siblings", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const registry = yield* ToolRegistry.Service
      yield* fs.writeFileString(path.join(location.directory, "sibling.txt"), "needle: unrelated sibling\n")

      expect(yield* executeTool(registry, call({ pattern: "needle", path: "missing.txt" }))).toEqual({
        type: "error",
        value:
          "Search path does not exist: missing.txt. 'path' is a literal file or directory; use 'include' for file globs.",
      })
    }),
  )

  it.live("rejects a missing literal directory instead of searching its parent", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const registry = yield* ToolRegistry.Service
      yield* fs.makeDirectory(path.join(location.directory, "src"))
      yield* fs.writeFileString(path.join(location.directory, "src", "sibling.txt"), "needle\n")

      expect(yield* executeTool(registry, call({ pattern: "needle", path: "src/missing{a,b}" }))).toEqual({
        type: "error",
        value:
          "Search path does not exist: src/missing{a,b}. 'path' is a literal file or directory; use 'include' for file globs.",
      })
    }),
  )

  it.live("searches literal brace-named files and directories without expanding them", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const registry = yield* ToolRegistry.Service
      yield* fs.makeDirectory(path.join(location.directory, "dir{a,b}"))
      yield* fs.writeFileString(path.join(location.directory, "dir{a,b}", "literal{a,b}.txt"), "needle literal\n")
      yield* fs.writeFileString(path.join(location.directory, "dir{a,b}", "sibling.txt"), "needle sibling\n")
      yield* fs.makeDirectory(path.join(location.directory, "dira"))
      yield* fs.writeFileString(path.join(location.directory, "dira", "expanded.txt"), "needle expanded\n")

      const file = yield* executeTool(registry, call({ pattern: "needle", path: "dir{a,b}/literal{a,b}.txt" }))
      expect(file.type).toBe("text")
      expect(file.value).toContain("needle literal")
      expect(file.value).not.toContain("needle sibling")
      expect(file.value).not.toContain("needle expanded")
      const directory = yield* executeTool(registry, call({ pattern: "needle", path: "dir{a,b}" }))
      expect(directory.value).toContain("needle literal")
      expect(directory.value).toContain("needle sibling")
      expect(directory.value).not.toContain("needle expanded")
    }),
  )

  it.live("preserves omitted root, include filtering and genuine no-match results", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const registry = yield* ToolRegistry.Service
      yield* fs.writeFileString(path.join(location.directory, "match.ts"), "needle included\n")
      yield* fs.writeFileString(path.join(location.directory, "ignore.txt"), "needle excluded\n")
      const result = yield* executeTool(registry, call({ pattern: "needle", include: "*.ts" }))
      expect(result.value).toContain("needle included")
      expect(result.value).not.toContain("needle excluded")
      expect(yield* executeTool(registry, call({ pattern: "absent", path: "match.ts" }))).toEqual({
        type: "text",
        value: "No files found",
      })
      expect(yield* executeTool(registry, call({ pattern: "[", path: "match.ts" }))).toEqual({
        type: "error",
        value: "Unable to grep for [",
      })
    }),
  )

  it.live("searches a file named dash instead of treating it as stdin", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const registry = yield* ToolRegistry.Service
      yield* fs.writeFileString(path.join(location.directory, "-"), "needle literal dash\n")
      yield* fs.writeFileString(path.join(location.directory, "sibling.txt"), "needle sibling\n")
      const result = yield* executeTool(registry, call({ pattern: "needle", path: "-" }))
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
        Effect.succeed({ ...fs, stat: () => Effect.die("stat must not run before permission") }),
      ),
    ).pipe(Layer.provide(LayerNode.compile(FSUtil.node))),
  ),
)

denied.live("grep permission denial precedes target inspection", () =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    expect(yield* executeTool(registry, call({ pattern: "needle", path: "missing.txt" }))).toEqual({
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
    expect(yield* executeTool(registry, call({ pattern: "needle", path: "inaccessible.txt" }))).toEqual({
      type: "error",
      value: "Unable to grep for needle",
    })
  }),
)
