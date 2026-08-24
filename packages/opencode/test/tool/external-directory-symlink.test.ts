import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Agent } from "../../src/agent/agent"
import { Git } from "@/git"
import { Truncate } from "@/tool/truncate"
import { assertExternalDirectoryEffect } from "../../src/tool/external-directory"
import { TestInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import type * as Tool from "../../src/tool/tool"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Ripgrep.node, Truncate.node, Agent.node, Git.node]),
  ),
)

// The permission gate is what stands between an agent and the rest of the disk.
// A symlink committed inside a repository satisfies a purely textual containment
// check, so without resolving the destination any dependency, merged pull
// request, or web page that can plant a link hands the agent unprompted read and
// write access outside the project.
describe("external_directory containment", () => {
  const asked = (requests: unknown[]) => requests.length > 0

  const context = (requests: Omit<Tool.Context, never>[]): Tool.Context =>
    ({
      sessionID: SessionID.make("ses_test"),
      messageID: MessageID.make("msg_test"),
      callID: "",
      agent: "build",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: (request: unknown) =>
        Effect.sync(() => {
          requests.push(request as never)
        }),
    }) as unknown as Tool.Context

  it.instance("a symlink inside the project that points outside still asks permission", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const instance = yield* TestInstance
      const outside = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-escape-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
      )
      yield* Effect.promise(() => Bun.write(path.join(outside, "secret.txt"), "secret"))
      const link = path.join(instance.directory, "escape")
      yield* Effect.promise(() => fs.symlink(outside, link, "dir"))

      const requests: Omit<Tool.Context, never>[] = []
      yield* assertExternalDirectoryEffect(context(requests), path.join(link, "secret.txt"))
      expect(asked(requests)).toBe(true)
    }),
  )

  it.instance("a file that does not exist yet under an escaping link still asks", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const instance = yield* TestInstance
      const outside = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-escape-new-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
      )
      const link = path.join(instance.directory, "escape-new")
      yield* Effect.promise(() => fs.symlink(outside, link, "dir"))

      const requests: Omit<Tool.Context, never>[] = []
      // Writing a new file through the link must be gated too: the lexical path
      // looks project-local right up until the write lands outside.
      yield* assertExternalDirectoryEffect(context(requests), path.join(link, "created.txt"))
      expect(asked(requests)).toBe(true)
    }),
  )

  it.instance("an ordinary file inside the project is never gated", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(instance.directory, "inside.txt"), "fine"))
      const requests: Omit<Tool.Context, never>[] = []
      yield* assertExternalDirectoryEffect(context(requests), path.join(instance.directory, "inside.txt"))
      expect(asked(requests)).toBe(false)
    }),
  )

  it.instance("a project reached through a symlinked root does not gate its own files", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const instance = yield* TestInstance
      // macOS hands out /var and /tmp as links to /private/*, so a resolved
      // target compared against an unresolved root would prompt for every file.
      yield* Effect.promise(() => Bun.write(path.join(instance.directory, "own.txt"), "fine"))
      const requests: Omit<Tool.Context, never>[] = []
      yield* assertExternalDirectoryEffect(context(requests), path.join(instance.directory, "own.txt"))
      expect(asked(requests)).toBe(false)
    }),
  )
})
