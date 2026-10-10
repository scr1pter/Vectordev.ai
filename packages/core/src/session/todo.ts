export * as SessionTodo from "./todo"

import { asc, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { SessionTodo } from "@vectordevai/schema/session-todo"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionSchema } from "./schema"
import { TodoTable } from "./sql"
import { TodoTransition } from "./todo-transition"

export const Info = SessionTodo.Info
export type Info = typeof Info.Type
export const Event = SessionTodo.Event

export interface Interface {
  readonly update: (input: {
    readonly sessionID: SessionSchema.ID
    readonly todos: ReadonlyArray<Info>
  }) => Effect.Effect<void>
  readonly updateFromModel: (input: {
    readonly sessionID: SessionSchema.ID
    readonly todos: ReadonlyArray<Info>
    readonly reset?: boolean
  }) => Effect.Effect<void, TodoTransition.Rejected>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Info>>
}

export class Service extends Context.Service<Service, Interface>()("@vector/v2/SessionTodo") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const replace = Effect.fn("SessionTodo.replace")(function* (
      input: { readonly sessionID: SessionSchema.ID; readonly todos: ReadonlyArray<Info> },
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

    const get = Effect.fn("SessionTodo.get")(function* (sessionID: SessionSchema.ID) {
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

export const node = makeLocationNode({ service: Service, layer, deps: [EventV2.node, Database.node] })
