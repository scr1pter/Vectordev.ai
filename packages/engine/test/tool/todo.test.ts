import { describe, expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Database } from "@vectordevai/core/database/database"
import { EventV2 } from "@vectordevai/core/event"
import { Project } from "@vectordevai/core/project"
import { ProjectTable } from "@vectordevai/core/project/sql"
import { AbsolutePath } from "@vectordevai/core/schema"
import { SessionTable } from "@vectordevai/core/session/sql"
import { MessageID, SessionID } from "../../src/session/schema"
import { Todo } from "../../src/session/todo"
import { TodoWriteTool } from "../../src/tool/todo"
import { Truncate } from "../../src/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Database.node, EventV2.node, Todo.node, Truncate.node, Agent.node])),
)

describe("todowrite progress", () => {
  it.instance("preserves stored progress on rejection and permits an explicit reset through the real tool", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const todos = yield* Todo.Service
      const sessionID = SessionID.make("ses_todo_progress_test")
      yield* database.db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "todo-progress",
          directory: "/project",
          title: "todo progress",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)

      const published = new Array<EventV2.Payload>()
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === Todo.Event.Updated.type) published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const original = [{ content: "Verify package changes", status: "in_progress", priority: "high" }]
      const proposed = [{ content: "Verify package changes", status: "pending", priority: "high" }]
      yield* todos.update({ sessionID, todos: original })
      const info = yield* TodoWriteTool
      const tool = yield* info.init()
      const context = {
        sessionID,
        messageID: MessageID.make("msg_todo_progress_test"),
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const rejected = yield* tool.execute({ todos: proposed }, context).pipe(Effect.exit)
      expect(Exit.isFailure(rejected)).toBe(true)
      if (Exit.isFailure(rejected))
        expect(Cause.squash(rejected.cause)).toMatchObject({
          message: expect.stringContaining("The todo list was not changed"),
        })
      expect(yield* todos.get(sessionID)).toEqual(original)
      expect(published).toHaveLength(1)

      const result = yield* tool.execute({ todos: proposed, reset: true }, context)
      expect(result.metadata.todos).toEqual(proposed)
      expect(result.output).toBe("Todo list updated: 1 open, 0 completed.")
      expect(yield* todos.get(sessionID)).toEqual(proposed)
      expect(published).toHaveLength(2)
      expect(published[1]?.data).toEqual({ sessionID, todos: proposed })
    }),
  )
})
