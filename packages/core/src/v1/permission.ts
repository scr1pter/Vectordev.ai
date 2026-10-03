export * as PermissionV1 from "./permission"

import { Schema } from "effect"
export * from "@vectordevai/schema/permission-v1"
import { ID } from "@vectordevai/schema/permission-v1"

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionRejectedError", {}) {
  override get message() {
    return "The user rejected permission to use this specific tool call."
  }
}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionCorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
  }
}

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionDeniedError", {
  ruleset: Schema.Any,
  permission: Schema.optional(Schema.String),
  pattern: Schema.optional(Schema.String),
}) {
  // The model reads this on every later step, so it names the denied call and what is allowed instead of dumping the
  // whole ruleset, which for a read-only subagent ran to dozens of rules.
  override get message() {
    const rules: ReadonlyArray<{ permission?: unknown; pattern?: unknown; action?: unknown }> = Array.isArray(
      this.ruleset,
    )
      ? this.ruleset
      : []
    const allowed = [
      ...new Set(
        rules
          .filter((rule) => rule.action === "allow" && typeof rule.pattern === "string" && rule.pattern !== "*")
          .map((rule) => String(rule.pattern)),
      ),
    ]
    const call = this.permission === undefined ? "this tool call" : `${this.permission} "${this.pattern ?? "*"}"`
    return [
      `A permission rule denies ${call}. Do not retry it.`,
      allowed.length > 0 ? `Allowed for this agent: ${allowed.join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join(" ")
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Permission.NotFoundError", {
  requestID: ID,
}) {}

export type Error = DeniedError | RejectedError | CorrectedError
