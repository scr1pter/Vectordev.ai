export * as TodoWriteTool from "./todowrite"

import { ToolFailure } from "@vectordevai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SessionTodo } from "../session/todo"
import { TodoTransition } from "../session/todo-transition"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "todowrite"

export const Input = Schema.Struct({
  todos: Schema.Array(SessionTodo.Info).annotate({ description: "The updated todo list" }),
  reset: TodoTransition.Reset,
})

export const Output = Schema.Struct({
  todos: Schema.Array(SessionTodo.Info),
})
export type Output = typeof Output.Type

// The model wrote the list itself; echoing it back cost ~200 tokens on every update.
export const toModelOutput = (output: Output) =>
  `Todo list updated: ${output.todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled").length} open, ${output.todos.filter((todo) => todo.status === "completed").length} completed.`

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const todos = yield* SessionTodo.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Create and maintain a structured task list when the user requests tracking, the work has several substantial independent objectives, or extended work needs meaningful checkpoints. Otherwise skip it for one bounded bug fix, feature, or mechanical change, including its investigation and verification; multiple files or tool calls alone do not justify a list. Track substantial outcomes. Persist observed progress and new blockers before reporting final status; prose alone does not update the list. Combine known status changes and independent productive calls when possible. Mark completed only after work and required verification succeed. Keep exactly one milestone in_progress while work remains; keep the original blocked/partial milestone active, including failed verification, and add a pending blocker follow-up. Preserve user commands verbatim.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: ["*"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              yield* todos.updateFromModel({ sessionID: context.sessionID, todos: input.todos, reset: input.reset })
              return { todos: input.todos }
            }).pipe(
              Effect.mapError(
                (error) =>
                  new ToolFailure({
                    message: error instanceof TodoTransition.Rejected ? error.message : "Unable to update todos",
                  }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/todowrite",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, SessionTodo.node],
})
