import { Effect, Schema } from "effect"
import * as path from "path"
import { access, appendFile, mkdir } from "node:fs/promises"
import * as Tool from "./tool"
import DESCRIPTION from "./teammate.txt"
import { InstanceState } from "@/effect/instance-state"

// Agents reach teammates through an on-disk outbox rather than a direct call:
// the tool runs in the engine sidecar, which has no access to the desktop's
// team store. The orchestrator drains this file between turns and routes each
// entry. Both processes already share the workspace directory, so this needs no
// new transport and survives either side restarting.
export const OUTBOX_RELATIVE_PATH = path.join(".vector", "team-outbox.jsonl")

// Written by the orchestrator when a workspace joins a team. Its absence means
// this agent is working alone, and reporting a queued message in that case
// would be a lie the agent then acts on.
export const TEAM_MARKER_RELATIVE_PATH = path.join(".vector", "team.json")

export const Parameters = Schema.Struct({
  message: Schema.String.annotate({
    description: "What you need the teammate to know or answer. Be specific and self-contained.",
  }),
  to: Schema.optional(
    Schema.String.annotate({
      description: "The teammate's name. Omit to send to everyone on the team.",
    }),
  ),
})

type Metadata = { to?: string }

export type OutboxEntry = {
  to?: string
  message: string
  sessionID: string
  createdAt: string
}

export const TeammateMessageTool = Tool.define<typeof Parameters, Metadata, never>(
  "send_teammate_message",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const message = params.message.trim()
          if (!message) {
            return { title: "Empty message", output: "No message was sent because the text was empty.", metadata: {} }
          }

          const instance = yield* InstanceState.context
          const marker = path.join(instance.directory, TEAM_MARKER_RELATIVE_PATH)
          const hasTeam = yield* Effect.promise(() =>
            access(marker)
              .then(() => true)
              .catch(() => false),
          )
          if (!hasTeam) {
            return {
              title: "No teammates",
              output:
                "You are working alone in this workspace, so there is no one to message. Continue with your task and report the result normally.",
              metadata: {},
            }
          }

          const outbox = path.join(instance.directory, OUTBOX_RELATIVE_PATH)
          const entry: OutboxEntry = {
            to: params.to?.trim() || undefined,
            message,
            sessionID: ctx.sessionID,
            createdAt: new Date().toISOString(),
          }

          // Append rather than rewrite: several agents share this workspace and
          // rewriting the file would drop a teammate's queued message.
          yield* Effect.promise(() =>
            mkdir(path.dirname(outbox), { recursive: true })
              .then(() => appendFile(outbox, `${JSON.stringify(entry)}\n`, "utf8"))
              .catch(() => undefined),
          )

          return {
            title: params.to ? `Message queued for ${params.to}` : "Message queued for the team",
            output: [
              params.to
                ? `Queued for ${params.to}. It is delivered at the start of their next turn.`
                : "Queued for every teammate. It is delivered at the start of their next turn.",
              "Continue with work that does not depend on a reply.",
            ].join("\n"),
            metadata: { to: entry.to },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
