import { describe, expect } from "bun:test"
import { asc } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { EventV2 } from "@vectordevai/core/event"
import { Project } from "@vectordevai/core/project"
import { ProjectTable } from "@vectordevai/core/project/sql"
import { AbsolutePath } from "@vectordevai/core/schema"
import { SessionV2 } from "@vectordevai/core/session"
import { SessionTable, TodoTable } from "@vectordevai/core/session/sql"
import { SessionTodo } from "@vectordevai/core/session/todo"
import { TodoTransition } from "@vectordevai/core/session/todo-transition"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionTodo.node])))
const sessionID = SessionV2.ID.make("ses_todo_test")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "todo",
      directory: "/project",
      title: "todo",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

describe("SessionTodo", () => {
  it.effect("rejects a model regression without changing any rows or publishing an update", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* SessionTodo.Service
      const events = yield* EventV2.Service
      const original = [
        { content: "Implement change", status: "completed", priority: "high" },
        { content: "Verify change", status: "in_progress", priority: "high" },
      ]
      yield* todos.update({ sessionID, todos: original })
      const published = new Array<EventV2.Payload>()
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === SessionTodo.Event.Updated.type) published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      const rejected = yield* todos
        .updateFromModel({
          sessionID,
          todos: [
            { content: "Implement change", status: "cancelled", priority: "low" },
            { content: "Verify change", status: "pending", priority: "high" },
            { content: "Resolve verification blocker", status: "in_progress", priority: "high" },
          ],
        })
        .pipe(Effect.flip)

      expect(rejected).toBeInstanceOf(TodoTransition.Rejected)
      expect(rejected.message).toContain("Verify change")
      expect(yield* todos.get(sessionID)).toEqual(original)
      expect(published).toEqual([])
    }),
  )

  it.effect("keeps ordinary updates permissive and publishes an explicit model reset", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* SessionTodo.Service
      const events = yield* EventV2.Service
      const active = [{ content: "Verify change", status: "in_progress", priority: "high" }]
      const pending = [{ content: "Verify change", status: "pending", priority: "low" }]
      const published = new Array<EventV2.Payload>()
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === SessionTodo.Event.Updated.type) published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* todos.update({ sessionID, todos: active })
      yield* todos.update({ sessionID, todos: pending })
      expect(yield* todos.get(sessionID)).toEqual(pending)
      yield* todos.update({ sessionID, todos: active })
      yield* todos.updateFromModel({ sessionID, todos: pending, reset: true })
      expect(yield* todos.get(sessionID)).toEqual(pending)
      expect(published.map((event) => event.data)).toEqual([
        { sessionID, todos: active },
        { sessionID, todos: pending },
        { sessionID, todos: active },
        { sessionID, todos: pending },
      ])
    }),
  )

  it.effect("allows reordering, priority changes, completion, and edits without an unambiguous match", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* SessionTodo.Service
      const active = { content: "Verify change", status: "in_progress", priority: "high" }
      const pending = { content: "Resolve blocker", status: "pending", priority: "medium" }

      yield* Effect.forEach(
        [
          { before: [active, pending], after: [pending, { ...active, priority: "low" }] },
          { before: [active], after: [{ ...active, status: "completed" }] },
          { before: [active], after: [{ ...active, status: "cancelled" }] },
          { before: [active], after: [{ ...active, content: "Verify revised change", status: "pending" }] },
          { before: [active], after: [] },
          { before: [active, { ...active, status: "pending" }], after: [{ ...active, status: "pending" }] },
          { before: [active], after: [{ ...active, status: "pending" }, { ...active, priority: "low" }] },
        ],
        (edit) =>
          Effect.gen(function* () {
            yield* todos.update({ sessionID, todos: edit.before })
            yield* todos.updateFromModel({ sessionID, todos: edit.after })
            expect(yield* todos.get(sessionID)).toEqual(edit.after)
          }),
      )
    }),
  )

  it.effect("replaces persisted todos in order and publishes updates", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const todos = yield* SessionTodo.Service
      const published = new Array<EventV2.Payload>()
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === SessionTodo.Event.Updated.type) published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* todos.update({
        sessionID,
        todos: [
          { content: "second", status: "pending", priority: "low" },
          { content: "first", status: "in_progress", priority: "high" },
        ],
      })
      expect(yield* todos.get(sessionID)).toEqual([
        { content: "second", status: "pending", priority: "low" },
        { content: "first", status: "in_progress", priority: "high" },
      ])
      expect(
        (yield* db.select().from(TodoTable).orderBy(asc(TodoTable.position)).all().pipe(Effect.orDie)).map((row) => ({
          content: row.content,
          position: row.position,
        })),
      ).toEqual([
        { content: "second", position: 0 },
        { content: "first", position: 1 },
      ])

      yield* todos.update({ sessionID, todos: [{ content: "replacement", status: "completed", priority: "medium" }] })
      expect(yield* todos.get(sessionID)).toEqual([{ content: "replacement", status: "completed", priority: "medium" }])

      yield* todos.update({ sessionID, todos: [] })
      expect(yield* todos.get(sessionID)).toEqual([])
      expect(published.map((event) => event.data)).toEqual([
        {
          sessionID,
          todos: [
            { content: "second", status: "pending", priority: "low" },
            { content: "first", status: "in_progress", priority: "high" },
          ],
        },
        { sessionID, todos: [{ content: "replacement", status: "completed", priority: "medium" }] },
        { sessionID, todos: [] },
      ])
    }),
  )
})
