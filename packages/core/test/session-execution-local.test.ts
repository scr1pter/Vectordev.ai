import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Database } from "@vectordevai/core/database/database"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { EventV2 } from "@vectordevai/core/event"
import { Location } from "@vectordevai/core/location"
import { PluginInternal } from "@vectordevai/core/plugin/internal"
import { ProjectV2 } from "@vectordevai/core/project"
import { AbsolutePath } from "@vectordevai/core/schema"
import { SessionV2 } from "@vectordevai/core/session"
import { SessionExecution } from "@vectordevai/core/session/execution"
import { SessionExecutionLocal } from "@vectordevai/core/session/execution/local"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { SessionRunner } from "@vectordevai/core/session/runner"
import { node } from "@vectordevai/core/session/runner/llm"
import { SessionStore } from "@vectordevai/core/session/store"
import { Credential } from "../src/credential"
import { ApplicationTools } from "../src/tool/application-tools"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// The session's location keeps loading its plugins until the test lets them finish, and its runner records whether
// they had finished when it was asked to run.
const waiting = Deferred.makeUnsafe<void>()
const loaded = Deferred.makeUnsafe<void>()
const runs: boolean[] = []
const plugins = Layer.succeed(
  PluginInternal.Service,
  PluginInternal.Service.of({ ready: Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Deferred.await(loaded))) }),
)
const runner = Layer.succeed(
  SessionRunner.Service,
  SessionRunner.Service.of({
    run: () =>
      Deferred.isDone(loaded).pipe(
        Effect.map((done) => {
          runs.push(done)
        }),
      ),
  }),
)
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      ApplicationTools.node,
      Credential.node,
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
      SessionExecution.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecutionLocal.node],
      [PluginInternal.node, plugins],
      [node, runner],
    ],
  ),
)

describe("SessionExecutionLocal", () => {
  it.live("runs a session only once its location's plugins have loaded the agents and models a turn reads", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const sessions = yield* SessionV2.Service
          const execution = yield* SessionExecution.Service
          const session = yield* sessions.create({
            location: Location.Ref.make({ directory: AbsolutePath.make(dir.path) }),
          })
          const drain = yield* execution.resume(session.id).pipe(Effect.forkChild)
          // A drain that did not wait finishes first, having run the session before the plugins loaded.
          yield* Effect.raceFirst(Deferred.await(waiting), Fiber.join(drain))
          expect(runs).toEqual([])

          yield* Deferred.succeed(loaded, undefined)
          yield* Fiber.join(drain)
          expect(runs).toEqual([true])
        }),
      ),
    ),
  )
})
