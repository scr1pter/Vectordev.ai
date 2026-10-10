export * as TodoTransition from "./todo-transition"

import { Schema } from "effect"
import { SessionTodo } from "@vectordevai/schema/session-todo"

export const Reset = Schema.optional(Schema.Boolean).annotate({
  description: "Set true only when the user explicitly requests restarting or reprioritizing already-started work.",
})

export class Rejected extends Schema.TaggedErrorClass<Rejected>()("TodoTransition.Rejected", {
  content: Schema.String,
}) {
  override get message() {
    return `Cannot move the started todo ${JSON.stringify(this.content)} back to pending. Keep blocked work in_progress and add a pending blocker follow-up. Use reset: true only for an explicit user request to restart or reprioritize work. The todo list was not changed.`
  }
}

export function demoted(previous: ReadonlyArray<SessionTodo.Info>, next: ReadonlyArray<SessionTodo.Info>) {
  // Legacy todos have no stable IDs. Ambiguous or renamed items cannot safely be matched by inference.
  return previous.find(
    (todo) =>
      todo.status === "in_progress" &&
      previous.filter((item) => item.content === todo.content).length === 1 &&
      next.filter((item) => item.content === todo.content).length === 1 &&
      next.some((item) => item.content === todo.content && item.status === "pending"),
  )
}
