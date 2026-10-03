import { describe, expect } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import {
  OUTBOX_DIRECTORY_RELATIVE_PATH,
  TEAM_MARKER_RELATIVE_PATH,
  TeammateMessageTool,
  type OutboxEntry,
} from "@/tool/teammate"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      Truncate.node,
      Agent.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

describe("tool.send_teammate_message", () => {
  it.instance("a subagent's message is sent as the teammate it works for", () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      yield* Effect.promise(() => Bun.write(join(instance.directory, TEAM_MARKER_RELATIVE_PATH), "{}"))
      const sessions = yield* Session.Service
      const member = yield* sessions.create({ title: "Beta" })
      const child = yield* sessions.create({ parentID: member.id, title: "subagent" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "nested subagent" })
      const tool = yield* (yield* TeammateMessageTool).init()

      yield* tool.execute(
        { message: "The cache key changed.", to: "Alpha" },
        {
          sessionID: grandchild.id,
          messageID: MessageID.ascending(),
          agent: "general",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const outbox = join(instance.directory, OUTBOX_DIRECTORY_RELATIVE_PATH)
      const files = yield* Effect.promise(() => readdir(outbox))
      expect(files).toHaveLength(1)
      const entry: OutboxEntry = yield* Effect.promise(() => Bun.file(join(outbox, files[0]!)).json())
      expect(entry).toMatchObject({ to: "Alpha", message: "The cache key changed.", sessionID: member.id })
    }),
  )
})
