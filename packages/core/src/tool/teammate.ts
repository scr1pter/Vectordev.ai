export * as TeammateMessageTool from "./teammate"

import { ToolFailure } from "@opencode-ai/llm"
import { access, appendFile, mkdir } from "node:fs/promises"
import * as path from "node:path"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { LocationMutation } from "../location-mutation"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "send_teammate_message"

// Agents reach teammates through an on-disk outbox rather than a direct call:
// the tool runs in the engine, which has no access to the desktop's team store.
// The orchestrator drains this file between turns and routes each entry. Both
// processes already share the workspace directory, so this needs no new
// transport and survives either side restarting.
export const OUTBOX_RELATIVE_PATH = path.join(".vector", "team-outbox.jsonl")

// Written by the orchestrator when a workspace joins a team. Its absence means
// this agent is working alone, and reporting a queued message in that case
// would be a lie the agent then acts on.
export const TEAM_MARKER_RELATIVE_PATH = path.join(".vector", "team.json")

export const Input = Schema.Struct({
  message: Schema.String.annotate({
    description: "What you need the teammate to know or answer. Be specific and self-contained.",
  }),
  to: Schema.optional(
    Schema.String.annotate({ description: "The teammate's name. Omit to send to everyone on the team." }),
  ),
})

export const Output = Schema.Struct({
  queued: Schema.Boolean,
  to: Schema.optional(Schema.String),
  detail: Schema.String,
})
export type Output = typeof Output.Type

const DESCRIPTION = [
  "Send a message to another agent working with you in this shared workspace.",
  "",
  "Use it when a teammate genuinely needs to know something or answer you: you changed something they depend on,",
  "you are about to edit a file they are also working in, you need a decision only they can make, or you finished",
  "a piece they are blocked on.",
  "",
  "Do not narrate routine progress. Vector already broadcasts a summary of your work when your turn completes, so a",
  "message that only restates what you did is noise for everyone else.",
  "",
  "Name one teammate when the message is for them specifically; omit the recipient to reach everyone.",
  "Messages are delivered at the start of the recipient's next turn, so do not wait on a reply within this turn.",
].join("\n")

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description: DESCRIPTION,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.detail }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const message = input.message.trim()
              if (!message) {
                return { queued: false, detail: "No message was sent because the text was empty." }
              }

              // Resolve through the Location so the outbox lands in the
              // agent's actual workspace, shared or isolated.
              const root = yield* mutation.resolve({ path: ".", kind: "directory" })
              const directory = root.canonical
              const hasTeam = yield* Effect.promise(() =>
                access(path.join(directory, TEAM_MARKER_RELATIVE_PATH))
                  .then(() => true)
                  .catch(() => false),
              )
              if (!hasTeam) {
                return {
                  queued: false,
                  detail:
                    "You are working alone in this workspace, so there is no one to message. Continue with your task and report the result normally.",
                }
              }

              const to = input.to?.trim() || undefined
              const outbox = path.join(directory, OUTBOX_RELATIVE_PATH)
              const entry = { to, message, sessionID: context.sessionID, createdAt: new Date().toISOString() }

              // Append rather than rewrite: several agents share this workspace
              // and rewriting the file would drop a teammate's queued message.
              yield* Effect.promise(() =>
                mkdir(path.dirname(outbox), { recursive: true })
                  .then(() => appendFile(outbox, `${JSON.stringify(entry)}\n`, "utf8"))
                  .catch(() => undefined),
              )

              return {
                queued: true,
                to,
                detail: [
                  to
                    ? `Queued for ${to}. It is delivered at the start of their next turn.`
                    : "Queued for every teammate. It is delivered at the start of their next turn.",
                  "Continue with work that does not depend on a reply.",
                ].join("\n"),
              }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: "Unable to queue the teammate message" }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/teammate",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node],
})
