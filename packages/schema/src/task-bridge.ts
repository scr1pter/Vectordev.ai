export * as TaskBridge from "./task-bridge"

import { Schema } from "effect"
import { Task } from "./task"
import { optional } from "./schema"

const Lease = Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(128))
export const RegisterInput = Schema.Struct({
  lease: optional(Lease),
  tasks: Schema.Array(Task.Info).check(Schema.isMaxLength(200)),
  truncated: optional(Schema.Boolean),
}).annotate({ identifier: "TaskBridge.RegisterInput" })
export interface RegisterInput extends Schema.Schema.Type<typeof RegisterInput> {}
export const RegisterResult = Schema.Struct({ lease: Lease, expiresAt: Schema.Finite }).annotate({
  identifier: "TaskBridge.RegisterResult",
})
export interface RegisterResult extends Schema.Schema.Type<typeof RegisterResult> {}
export const Command = Schema.Struct({
  id: Schema.String,
  taskID: Schema.String,
  sender: Schema.String,
  action: Schema.Literals(["inspect", "message", "stop"]),
  text: optional(Schema.String),
  delivery: optional(Schema.Literals(["steer", "queue"])),
  reason: optional(Schema.String),
  createdAt: Schema.Finite,
  expiresAt: Schema.Finite,
}).annotate({ identifier: "TaskBridge.Command" })
export interface Command extends Schema.Schema.Type<typeof Command> {}
export const PollInput = Schema.Struct({
  lease: Lease,
  timeout: optional(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 30_000 }))),
}).annotate({ identifier: "TaskBridge.PollInput" })
export interface PollInput extends Schema.Schema.Type<typeof PollInput> {}
export const PollResult = Schema.Struct({ commands: Schema.Array(Command), expiresAt: Schema.Finite }).annotate({
  identifier: "TaskBridge.PollResult",
})
export interface PollResult extends Schema.Schema.Type<typeof PollResult> {}
export const ReceiptInput = Schema.Struct({
  lease: Lease,
  commandID: Schema.String.check(Schema.isMaxLength(200)),
  result: optional(Schema.Union([Task.InspectResult, Task.MessageResult, Task.StopResult])),
  error: optional(Schema.String.check(Schema.isMaxLength(1000))),
}).annotate({ identifier: "TaskBridge.ReceiptInput" })
export interface ReceiptInput extends Schema.Schema.Type<typeof ReceiptInput> {}
export const ReceiptResult = Schema.Struct({ accepted: Schema.Boolean }).annotate({
  identifier: "TaskBridge.ReceiptResult",
})
export interface ReceiptResult extends Schema.Schema.Type<typeof ReceiptResult> {}
