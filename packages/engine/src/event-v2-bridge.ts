// Vector publish boundary for core events. Attach routed instance location
// so direct EventV2 consumers can isolate directory/workspace streams.
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@vectordevai/core/event"
import { Location } from "@vectordevai/core/location"
import { Project } from "@vectordevai/core/project"
import { AbsolutePath } from "@vectordevai/core/schema"
import { Context, Effect, Layer } from "effect"
import { SessionV1 } from "@vectordevai/schema/session-v1"
import { PermissionV1 } from "@vectordevai/schema/permission-v1"
import { QuestionV1 } from "@vectordevai/schema/question-v1"
import { SessionStatusEvent } from "@vectordevai/schema/session-status-event"
import { SessionTodo } from "@vectordevai/schema/session-todo"
import { TaskPlace } from "@/task/place"

// These families describe a session, rather than the files in its execution workspace.
const atHome = new Set<string>(
  [
    ...SessionV1.Event.Definitions,
    ...PermissionV1.Event.Definitions,
    ...QuestionV1.Event.Definitions,
    ...SessionStatusEvent.Definitions,
    ...SessionTodo.Event.Definitions,
  ].map((definition) => definition.type),
)

export class Service extends Context.Service<Service, EventV2.Interface>()("@vector/EventV2Bridge") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service

    const publish: EventV2.Interface["publish"] = (definition, data, options) =>
      Effect.gen(function* () {
        if (options?.location) return yield* events.publish(definition, data, options)
        const current = yield* InstanceRef
        const sessionID = data && typeof data === "object" && "sessionID" in data ? data.sessionID : undefined
        const ctx =
          atHome.has(definition.type) && typeof sessionID === "string"
            ? (TaskPlace.homeOf(sessionID) ?? current)
            : current
        if (!ctx) return yield* events.publish(definition, data, options)
        const workspaceID = yield* WorkspaceRef
        return yield* events.publish(definition, data, {
          ...options,
          location: new Location.Info({
            directory: AbsolutePath.make(ctx.directory),
            ...(workspaceID ? { workspaceID } : {}),
            project: { id: Project.ID.make(ctx.project.id), directory: AbsolutePath.make(ctx.worktree) },
          }),
        })
      })

    const unsubscribe = yield* events.listen((event) =>
      Effect.gen(function* () {
        const ctx = yield* InstanceRef
        const workspaceID = (yield* WorkspaceRef) ?? event.location?.workspaceID
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory,
          project: ctx?.project.id,
          workspace: workspaceID,
          payload: { id: event.id, type: event.type, properties: event.data },
        })
        if (event.durable === undefined) return
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory,
          project: ctx?.project.id,
          workspace: workspaceID,
          payload: {
            type: "sync",
            syncEvent: {
              id: event.id,
              type: EventV2.versionedType(event.type, event.durable.version),
              seq: event.durable.seq,
              aggregateID: event.durable.aggregateID,
              data: event.data,
            },
          },
        })
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)

    return Service.of({ ...events, publish })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2.node] })

export * as EventV2Bridge from "./event-v2-bridge"
