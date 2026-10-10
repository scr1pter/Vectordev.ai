import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { SessionID } from "./schema"
import { Effect, Layer, Context } from "effect"
import { Database } from "@vectordevai/core/database/database"
import { eq } from "drizzle-orm"
import { asc } from "drizzle-orm"
import { TodoTable } from "@vectordevai/core/session/sql"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionTodo } from "@vectordevai/schema/session-todo"
import { TodoTransition } from "@vectordevai/core/session/todo-transition"

export const Info = SessionTodo.Info
export type Info = SessionTodo.Info

export const Event = SessionTodo.Event

export interface Interface {
  readonly update: (input: { sessionID: SessionID; todos: ReadonlyArray<Info> }) => Effect.Effect<void>
  readonly updateFromModel: (input: {
    sessionID: SessionID
    todos: ReadonlyArray<Info>
    reset?: boolean
  }) => Effect.Effect<void, TodoTransition.Rejected>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@vector/SessionTodo") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service

    const replace = Effect.fn("Todo.replace")(function* (
      input: { sessionID: SessionID; todos: ReadonlyArray<Info> },
      preserveProgress: boolean,
    ) {
      const demoted = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            if (preserveProgress) {
              const previous = yield* tx.select().from(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).all()
              const demoted = TodoTransition.demoted(previous, input.todos)
              if (demoted) return demoted
            }
            yield* tx.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()
            if (input.todos.length === 0) return
            yield* tx
              .insert(TodoTable)
              .values(
                input.todos.map((todo, position) => ({
                  session_id: input.sessionID,
                  content: todo.content,
                  status: todo.status,
                  priority: todo.priority,
                  position,
                })),
              )
              .run()
          }),
        )
        .pipe(Effect.orDie)
      if (demoted) return yield* new TodoTransition.Rejected({ content: demoted.content })
      yield* events.publish(Event.Updated, { sessionID: input.sessionID, todos: input.todos })
    })

    const update: Interface["update"] = (input) => replace(input, false).pipe(Effect.orDie)
    const updateFromModel: Interface["updateFromModel"] = (input) => replace(input, input.reset !== true)

    const get = Effect.fn("Todo.get")(function* (sessionID: SessionID) {
      const rows = yield* db
        .select()
        .from(TodoTable)
        .where(eq(TodoTable.session_id, sessionID))
        .orderBy(asc(TodoTable.position))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        content: row.content,
        status: row.status,
        priority: row.priority,
      }))
    })

    return Service.of({ update, updateFromModel, get })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node, Database.node] })

export * as Todo from "./todo"
