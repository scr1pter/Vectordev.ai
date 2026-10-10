import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@vectordevai/core/database/database"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { EventV2 } from "@vectordevai/core/event"
import { PermissionV2 } from "@vectordevai/core/permission"
import { Project } from "@vectordevai/core/project"
import { ProjectTable } from "@vectordevai/core/project/sql"
import { AbsolutePath } from "@vectordevai/core/schema"
import { SessionV2 } from "@vectordevai/core/session"
import { SessionTable } from "@vectordevai/core/session/sql"
import { SessionTodo } from "@vectordevai/core/session/todo"
import { TodoWriteTool } from "@vectordevai/core/tool/todowrite"
import { ToolRegistry } from "@vectordevai/core/tool/registry"
import { ToolOutputStore } from "@vectordevai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_todowrite_tool_test")
const assertions: PermissionV2.AssertInput[] = []
let deny = false

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(deny ? Effect.fail(new PermissionV2.DeniedError({ rules: [] })) : Effect.void),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionTodo.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      TodoWriteTool.node,
    ]),
    [
      [PermissionV2.node, permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)

const setup = Effect.gen(function* () {
  assertions.length = 0
  deny = false
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
      slug: "todowrite",
      directory: "/project",
      title: "todowrite",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

const call = (todos: ReadonlyArray<SessionTodo.Info>, id = "call-todowrite", reset = false) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: TodoWriteTool.name, input: { todos, reset } },
})

describe("TodoWriteTool", () => {
  it.effect("registers, approves the wildcard resource, persists todos, and returns typed output", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const service = yield* SessionTodo.Service
      const todoList: ReadonlyArray<SessionTodo.Info> = [
        { content: "Implement slice", status: "in_progress", priority: "high" },
      ]

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([TodoWriteTool.name])
      // The model wrote the list, so it gets a one-line acknowledgement; the UI reads the structured todos.
      const acknowledged = "Todo list updated: 1 open, 0 completed."
      expect(yield* settleTool(registry, call(todoList))).toEqual({
        result: { type: "text", value: acknowledged },
        output: {
          structured: { todos: todoList },
          content: [{ type: "text", text: acknowledged }],
        },
      })
      expect(assertions).toMatchObject([{ sessionID, action: "todowrite", resources: ["*"], save: ["*"] }])
      expect(yield* service.get(sessionID)).toEqual(todoList)
    }),
  )

  it.effect("returns an actionable regression error and accepts an explicit reset", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const service = yield* SessionTodo.Service
      const active = [{ content: "Verify change", status: "in_progress", priority: "high" }]
      const pending = [{ content: "Verify change", status: "pending", priority: "high" }]
      yield* service.update({ sessionID, todos: active })

      const result = yield* executeTool(registry, call(pending))
      expect(result).toMatchObject({ type: "error" })
      expect(result.value).toContain("Verify change")
      expect(result.value).toContain("in_progress")
      expect(result.value).toContain("pending")
      expect(result.value).toContain("reset")
      expect(yield* service.get(sessionID)).toEqual(active)
      expect(assertions).toHaveLength(1)

      expect(yield* executeTool(registry, call(pending, "call-todowrite-reset", true))).toEqual({
        type: "text",
        value: "Todo list updated: 1 open, 0 completed.",
      })
      expect(yield* service.get(sessionID)).toEqual(pending)
      expect(assertions).toHaveLength(2)
    }),
  )

  it.effect("checks permission before transition validation and does not allow reset to bypass denial", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const service = yield* SessionTodo.Service
      const active = [{ content: "Verify change", status: "in_progress", priority: "high" }]
      const pending = [{ content: "Verify change", status: "pending", priority: "high" }]
      yield* service.update({ sessionID, todos: active })
      deny = true

      expect(yield* executeTool(registry, call(pending))).toEqual({
        type: "error",
        value: "Unable to update todos",
      })
      expect(yield* executeTool(registry, call(pending, "call-todowrite-denied-reset", true))).toEqual({
        type: "error",
        value: "Unable to update todos",
      })
      expect(yield* service.get(sessionID)).toEqual(active)
      expect(assertions).toMatchObject([
        { sessionID, action: "todowrite", resources: ["*"], save: ["*"] },
        { sessionID, action: "todowrite", resources: ["*"], save: ["*"] },
      ])
    }),
  )
})
