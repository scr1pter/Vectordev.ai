import { describe, expect } from "bun:test"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Deferred, Effect, Layer } from "effect"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionRunState.node,
      Session.node,
      SessionStatus.node,
      BackgroundJob.node,
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

const within = <T>(deferred: Deferred.Deferred<T>, message: string) =>
  Effect.race(
    Deferred.await(deferred),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error(message)))),
  )

describe("SessionRunState.cancel with nothing running", () => {
  it.instance("republishes the session's current info so a stale client catches up", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const runState = yield* SessionRunState.Service
      const events = yield* EventV2Bridge.Service
      const child = yield* sessions.create({})
      // A subagent that finished while a client's event stream was down: the client still holds the running record.
      yield* sessions.setMetadata({
        sessionID: child.id,
        metadata: { subagent: { status: "completed", startedAt: 1, completedAt: 2 } },
      })
      const current = yield* sessions.get(child.id)

      const updated = yield* Deferred.make<unknown>()
      const idle = yield* Deferred.make<unknown>()
      const unsubscribe = yield* events.listen((event) => {
        if (event.type === Session.Event.Updated.type) Deferred.doneUnsafe(updated, Effect.succeed(event.data))
        if (event.type === SessionStatus.Event.Status.type) Deferred.doneUnsafe(idle, Effect.succeed(event.data))
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* runState.cancel(child.id)

      expect(yield* within(updated, "stop never republished the session")).toEqual({
        sessionID: child.id,
        info: current,
      })
      expect(yield* within(idle, "stop never reported the session idle")).toEqual({
        sessionID: child.id,
        status: { type: "idle" },
      })
      expect(yield* sessions.get(child.id)).toEqual(current)
    }),
  )

  it.instance("still succeeds for a session that does not exist", () =>
    Effect.gen(function* () {
      const runState = yield* SessionRunState.Service
      yield* runState.cancel(SessionID.descending())
    }),
  )
})
