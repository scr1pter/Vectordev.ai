import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "path"
import { Effect, Schema } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainSchema } from "@vectordevai/core/brain/schema"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { FSUtil } from "@vectordevai/core/fs-util"
import { SessionID } from "@vectordevai/schema/session-id"
import { Instruction } from "../session/instruction"
import { SessionMemory } from "../session/memory"
import * as Tool from "./tool"
import DESCRIPTION from "./memory.txt"

// Every Work request carries this definition, so it stays small: a search reads `text`, and an entry about a file takes
// the cited file as its path scope instead of a parameter of its own.
export const Parameters = Schema.Struct({
  action: Schema.Literals(["search", "get", "add", "update", "forget"]),
  id: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  kind: Schema.optional(BrainSchema.LearnedKind),
  scope: Schema.optional(BrainSchema.Scope),
  quote: Schema.optional(Schema.String),
  file: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
})

type Metadata = {
  action: string
  result?: string
  id?: string
  hold?: BrainSchema.Hold
}

export const MemoryTool = Tool.define<typeof Parameters, Metadata, Brain.Service | Instruction.Service | FreeModelGuests.Service>(
  "memory",
  Effect.gen(function* () {
    const brain = yield* Brain.Service
    const instruction = yield* Instruction.Service
    const guests = yield* FreeModelGuests.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const place = yield* instruction.place()
          const guest = yield* guests.marked(SessionID.make(ctx.sessionID))
          // The owner's personal memory is not for a session an invited guest drives.
          const personal = !guest

          if (params.action === "search") {
            const found = yield* brain.search(place, {
              query: params.text ?? "",
              personal,
              sessionID: ctx.sessionID,
            })
            return {
              title: params.text ? `Memory: ${params.text}` : "Memory",
              output: found.length
                ? found.map(describe).join("\n")
                : "Nothing in memory matches. Search with other words, or carry on without it.",
              metadata: { action: "search", result: `${found.length}` },
            }
          }

          if (params.action === "get") {
            const detail = params.id ? yield* brain.get(place, params.id, { personal }) : undefined
            if (!detail) return refused("get", `No memory ${params.id ?? ""} here.`)
            return {
              title: `Memory ${detail.entry.id}`,
              output: [
                describe(detail.entry),
                ...detail.evidence.slice(-3).map((item) => `  evidence: ${evidenceLine(item)}`),
                ...(detail.related.length
                  ? [`Related: ${detail.related.map((item) => `[${item.id}] ${item.text.slice(0, 60)}`).join("; ")}`]
                  : []),
              ].join("\n"),
              metadata: { action: "get", id: detail.entry.id },
            }
          }

          // Writes: what the session took in decides whether they wait for the user.
          const hold = guest ? "guest" : place.held ? "untrusted-repository" : SessionMemory.taint(ctx.messages)

          if (params.action === "forget") {
            if (!params.id) return refused("forget", "Say which memory to forget, by id.")
            // The agent only puts an entry away; the user deletes for good in Settings > Memory. A session that read
            // outside content may not put anything away at all, so planted text cannot wipe what Vector knows.
            if (hold) return refused("forget", "This session took in outside content, so ask the user to forget it in Settings > Memory.")
            const result = yield* brain.update(place, params.id, { action: "archive" }, "agent")
            if (!result || result.type === "refused") return refused("forget", result?.type === "refused" ? result.message : `No memory ${params.id} here.`)
            return {
              title: `Put away ${params.id}`,
              output: `Put away ${params.id}. The user can restore it in Settings > Memory.`,
              metadata: { action: "forget", id: params.id },
            }
          }

          if (!params.text) return refused(params.action, "Give the text to remember.")
          if (params.action === "update" && !params.id) return refused("update", "Say which memory to update, by id.")
          const evidence = yield* verify(params, ctx, place.root)
          const result = yield* brain.propose(place, {
            kind: params.kind ?? "lesson",
            text: params.text,
            scope: params.scope ?? "repository",
            // An entry about a file comes up again when that file is read, so its cited file is its path scope.
            ...(evidence?.type === "file" && evidence.verified ? { paths: [evidence.path] } : {}),
            ...(evidence ? { evidence } : {}),
            ...(params.action === "update" ? { supersedes: params.id } : {}),
            origin: "agent",
            sessionID: ctx.sessionID,
            since: SessionMemory.since(ctx.messages),
            ...(hold ? { hold } : {}),
          })
          if (result.type === "refused") return refused(params.action, result.message)
          return {
            title: `Memory ${result.type}: ${result.entry.id}`,
            output: written(result),
            metadata: {
              action: params.action,
              result: result.type,
              id: result.entry.id,
              ...(result.entry.hold ? { hold: result.entry.hold } : {}),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// Evidence is checked here against the conversation and the files, never taken from the model's word: a quote must be
// the user's own, a file must hold the quoted line, and a command must have failed and then passed in this session.
const verify = Effect.fnUntraced(function* (
  params: Schema.Schema.Type<typeof Parameters>,
  ctx: Tool.Context<Metadata>,
  root: string,
) {
  if (params.command)
    return { type: "check" as const, command: params.command, verified: SessionMemory.checked(ctx.messages, params.command) }
  if (params.file && params.quote) {
    const target = path.resolve(root, params.file)
    const inside = FSUtil.contains(root, target)
    const content = inside ? yield* Effect.promise(() => fs.readFile(target, "utf8").catch(() => undefined)) : undefined
    const found = content !== undefined && normal(content).includes(normal(params.quote)) && normal(params.quote).length >= 6
    return {
      type: "file" as const,
      path: path.relative(root, target).split(path.sep).join("/"),
      quote: params.quote,
      ...(content !== undefined ? { hash: createHash("sha256").update(content).digest("hex").slice(0, 16) } : {}),
      verified: found,
    }
  }
  if (params.quote) return { type: "message" as const, quote: params.quote, verified: SessionMemory.quoted(ctx.messages, params.quote) }
  return undefined
})

function normal(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim()
}

function describe(entry: BrainSchema.Entry) {
  const from = entry.source ? ` (from ${path.basename(entry.source.file)})` : ""
  const scope = entry.paths.length ? ` [${entry.paths.slice(0, 3).join(", ")}]` : ""
  const stale = entry.stale ? " (may be out of date: its cited code changed)" : ""
  return `[${entry.id}] ${entry.kind}${scope}: ${entry.text}${from}${stale}`
}

function evidenceLine(item: BrainSchema.Evidence) {
  if (item.type === "message") return `the user said "${item.quote ?? ""}"`
  if (item.type === "file") return `${item.path ?? "a file"}: "${item.quote ?? ""}"`
  if (item.type === "check") return `\`${item.command ?? ""}\` passed after failing`
  if (item.type === "file-item") return "a file"
  return "the user saved it"
}

function written(result: Exclude<Brain.WriteResult, { type: "refused" }>) {
  const id = result.entry.id
  if (result.type === "added") return `Saved as ${id}.`
  if (result.type === "merged") return `Already known as ${id}; added this evidence to it.`
  if (result.type === "promoted") return `Confirmed ${id}, which an earlier session proposed; it is in use now.`
  if (result.type === "superseded") return `Saved as ${id}, replacing ${result.previous}.`
  if (result.type === "proposed")
    return `Saved ${id} as a proposal: Vector could not check its evidence, so it is used once another session confirms it or the user approves it.`
  return `Saved ${id} for the user's review (${holdReason(result.entry.hold)}). It is not used until they approve it.`
}

function holdReason(hold: BrainSchema.Hold | undefined) {
  if (hold === "web") return "this session read web content"
  if (hold === "mcp") return "this session ran an MCP tool"
  if (hold === "subagent") return "this session took a subagent's report"
  if (hold === "guest") return "an invited guest is in this session"
  if (hold === "untrusted-repository") return "this repository's settings are not trusted"
  if (hold === "hidden-unicode") return "it had hidden characters"
  return "it reads like an instruction to the agent"
}

function refused(action: string, message: string) {
  return { title: "Memory not changed", output: message, metadata: { action, result: "refused" } }
}
