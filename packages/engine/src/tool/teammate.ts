import { Effect, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises"
import * as Tool from "./tool"
import DESCRIPTION from "./teammate.txt"
import { InstanceState } from "@/effect/instance-state"

// Agents reach teammates through an on-disk outbox rather than a direct call:
// the tool runs in the engine sidecar, which has no access to the desktop's
// team store. The orchestrator drains these atomic files continuously and
// routes each entry. Both processes already share the workspace directory, so
// this needs no new transport and survives either side restarting.
export const OUTBOX_DIRECTORY_RELATIVE_PATH = join(".vector", "team-outbox")

// Written by the orchestrator when a workspace joins a team. Its absence means
// this agent is working alone, and reporting a queued message in that case
// would be a lie the agent then acts on.
export const TEAM_MARKER_RELATIVE_PATH = join(".vector", "team.json")

export const NO_TEAMMATES_DETAIL = [
  "No Parallel Workspace team is configured here. Task-tool sibling subagents are separate child sessions, not workspace teammates, so this message was not sent.",
  "Stop this coordination attempt. Do not search outside the workspace for team state, inspect Vector application data, logs, or packaged resources, or create a team marker.",
  "Continue independently and report the unavailable teammate exchange to the parent.",
].join("\n")

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
  id: string
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
          const marker = join(instance.directory, TEAM_MARKER_RELATIVE_PATH)
          const hasTeam = yield* Effect.promise(() =>
            access(marker)
              .then(() => true)
              .catch(() => false),
          )
          if (!hasTeam) {
            return {
              title: "No teammates",
              output: NO_TEAMMATES_DETAIL,
              metadata: {},
            }
          }

          const entry: OutboxEntry = {
            id: randomUUID(),
            to: params.to?.trim() || undefined,
            message,
            sessionID: ctx.sessionID,
            createdAt: new Date().toISOString(),
          }

          // One atomically-renamed file per message avoids the race where the
          // desktop rotates a shared append-only file while another process
          // still has that file open. Unique ids make concurrent writers and
          // crash replay independent.
          const outbox = join(instance.directory, OUTBOX_DIRECTORY_RELATIVE_PATH)
          const temporary = join(outbox, `${entry.id}.tmp`)
          const target = join(outbox, `${entry.id}.json`)
          const queued = yield* Effect.promise(() =>
            mkdir(outbox, { recursive: true })
              .then(() => writeFile(temporary, JSON.stringify(entry), "utf8"))
              .then(() => rename(temporary, target))
              .then(() => true)
              .catch(() => rm(temporary, { force: true }).then(() => false)),
          )
          if (!queued) {
            return {
              title: "Message not queued",
              output:
                "Vector could not write the team's durable message outbox, so no teammate received this message. Continue independently and include the dependency in your final report.",
              metadata: { to: entry.to },
            }
          }

          return {
            title: params.to ? `Message queued for ${params.to}` : "Message queued for the team",
            output: [
              params.to
                ? `Queued for ${params.to}. Vector will deliver it into their active session when possible, or at the start of their next turn.`
                : "Queued for every teammate. Vector will deliver it into active sessions when possible, or at the start of their next turn.",
              "Continue with work that does not depend on a reply.",
            ].join("\n"),
            metadata: { to: entry.to },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
