import { describe, expect } from "bun:test"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { Database } from "@vectordevai/core/database/database"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { aggregateSessionStats } from "@/cli/cmd/stats"
import { Session } from "@/session/session"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      Database.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
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

const step = Effect.fn("StatsTest.step")(function* (sessionID: SessionID, created: number, cost: number) {
  const session = yield* Session.Service
  const id = MessageID.ascending()
  const tokens = { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }
  yield* session.updateMessage({
    id,
    role: "assistant",
    parentID: MessageID.ascending(),
    sessionID,
    mode: "build",
    agent: "build",
    cost,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens,
    modelID: "test",
    providerID: "lmstudio",
    time: { created, completed: created },
  } as unknown as SessionV1.Info)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: id,
    sessionID,
    type: "step-finish",
    reason: "stop",
    cost,
    tokens,
  })
})

describe("vector stats", () => {
  it.instance("a window counts only the spend made inside it, not the lifetime of a session touched in it", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const before = yield* aggregateSessionStats(7)
      const info = yield* session.create({ title: "long running" })
      yield* step(info.id, Date.now() - 60 * 24 * 60 * 60 * 1000, 40)
      yield* step(info.id, Date.now(), 0.1)

      const after = yield* aggregateSessionStats(7)
      expect(after.totalCost - before.totalCost).toBeCloseTo(0.1)
      expect(after.totalTokens.input - before.totalTokens.input).toBe(1_000)
      expect((yield* session.get(info.id)).cost).toBeCloseTo(40.1)
      yield* session.remove(info.id)
    }),
  )
})
