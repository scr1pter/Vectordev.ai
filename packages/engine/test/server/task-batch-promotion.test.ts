import { NodeHttpServer } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { BackgroundJob } from "@vectordevai/core/background-job"
import { ProjectV2 } from "@vectordevai/core/project"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Project } from "@/project/project"
import { ToolRegistry } from "@/tool/registry"
import { Worktree } from "@/worktree"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { ExperimentalApi } from "@/server/routes/instance/httpapi/groups/experimental"
import { experimentalHandlers } from "@/server/routes/instance/httpapi/handlers/experimental"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import { schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { testEffect } from "../lib/effect"

const sessionID = SessionID.make("ses_task_batch_promotion")
const jobs = Layer.effect(BackgroundJob.Service, BackgroundJob.make)
const api = HttpApi.make("vector-instance").addHttpApi(ExperimentalApi)
const it = testEffect(
  HttpRouter.serve(
    HttpApiBuilder.layer(api).pipe(
      Layer.provide(experimentalHandlers),
      Layer.provide([
        schemaErrorLayer,
        Layer.succeed(
          Authorization,
          Authorization.of((effect) => effect),
        ),
        Layer.succeed(
          InstanceContextMiddleware,
          InstanceContextMiddleware.of((effect) => effect),
        ),
        Layer.succeed(
          WorkspaceRoutingMiddleware,
          WorkspaceRoutingMiddleware.of((effect) =>
            effect.pipe(Effect.provideService(WorkspaceRouteContext, { directory: process.cwd() })),
          ),
        ),
        RuntimeFlags.layer({ backgroundSubagents: true }),
        // These unrelated experimental endpoints are never called by this test.
        Layer.mock(Agent.Service)({}),
        Layer.mock(MCP.Service)({}),
        Layer.mock(Project.Service)({}),
        Layer.mock(ToolRegistry.Service)({}),
        Layer.mock(Worktree.Service)({}),
        Layer.mock(Session.Service)({
          get: () =>
            Effect.succeed({
              id: sessionID,
              slug: "test",
              projectID: ProjectV2.ID.make("project_test"),
              directory: process.cwd(),
              title: "test",
              version: "test",
              time: { created: 1, updated: 1 },
            }),
        }),
      ]),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provideMerge(jobs)),
)

it.live("background endpoint refuses foreground-only batch jobs but still promotes a single task", () =>
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const batch = yield* background.start({
      type: "task",
      promotable: false,
      metadata: { parentSessionId: sessionID },
      run: Effect.never,
    })
    const request = () =>
      HttpClientRequest.post(`/experimental/session/${sessionID}/background`).pipe(HttpClient.execute)
    const refused = yield* request()
    expect(refused.status).toBe(200)
    expect(yield* refused.json).toBe(false)
    expect(yield* background.get(batch.id)).toEqual(batch)
    const single = yield* background.start({
      type: "task",
      metadata: { parentSessionId: sessionID },
      run: Effect.never,
    })
    const promoted = yield* request()
    expect(promoted.status).toBe(200)
    expect(yield* promoted.json).toBe(true)
    expect((yield* background.get(single.id))?.metadata?.background).toBe(true)
    expect(yield* background.get(batch.id)).toEqual(batch)
  }),
)
