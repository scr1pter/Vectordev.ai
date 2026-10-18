import { createHash } from "node:crypto"
import path from "path"
import { Effect, Schema } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainSchema } from "@vectordevai/core/brain/schema"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { FSUtil } from "@vectordevai/core/fs-util"
import { SessionID } from "@vectordevai/schema/session-id"
import { Git } from "@/git"
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
  /** Personal entries this result stands in for; the transcript keeps their ids, never their words. */
  [SessionMemory.PERSONAL]?: string[]
}

export const MemoryTool = Tool.define<
  typeof Parameters,
  Metadata,
  Brain.Service | Instruction.Service | FreeModelGuests.Service | Git.Service
>(
  "memory",
  Effect.gen(function* () {
    const brain = yield* Brain.Service
    const instruction = yield* Instruction.Service
    const guests = yield* FreeModelGuests.Service
    const git = yield* Git.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const place = yield* instruction.place()
          const guest = yield* guests.marked(SessionID.make(ctx.sessionID))
          // The owner's personal memory is not for a session an invited guest drives, nor for a model that may train on
          // prompts. The session runtime says which the model is; without its word, personal memory stays out.
          const personal = !guest && ctx.extra?.mayTrain === false

          if (params.action === "search") {
            const found = yield* brain.search(place, {
              query: params.text ?? "",
              personal,
              sessionID: ctx.sessionID,
            })
            // Personal entries are saved as ids; each request fills their lines in while personal memory is allowed.
            return {
              title: params.text ? `Memory: ${params.text}` : "Memory",
              output: found.length
                ? found.map((entry) => (entry.scope === "personal" ? SessionMemory.withheld(entry.id) : describe(entry))).join("\n")
                : "Nothing in memory matches. Search with other words, or carry on without it.",
              metadata: { action: "search", result: `${found.length}`, ...withheld(found) },
            }
          }

          if (params.action === "get") {
            const detail = params.id ? yield* brain.get(place, params.id, { personal }) : undefined
            if (!detail) return refused("get", `No memory ${params.id ?? ""} here.`)
            // A personal entry's evidence is the user's own words, so it shows as its line alone.
            if (detail.entry.scope === "personal")
              return {
                title: `Memory ${detail.entry.id}`,
                output: SessionMemory.withheld(detail.entry.id),
                metadata: { action: "get", id: detail.entry.id, ...withheld([detail.entry]) },
              }
            return {
              title: `Memory ${detail.entry.id}`,
              output: [
                describe(detail.entry),
                ...detail.evidence.slice(-3).map((item) => `  evidence: ${evidenceLine(item)}`),
                ...(detail.related.length
                  ? [
                      `Related: ${detail.related.map((item) => (item.scope === "personal" ? `[${item.id}] (personal)` : `[${item.id}] ${item.text.slice(0, 60)}`)).join("; ")}`,
                    ]
                  : []),
              ].join("\n"),
              metadata: { action: "get", id: detail.entry.id },
            }
          }

          // Writes: what the session took in decides whether they wait for the user.
          const hold = guest ? "guest" : place.held ? "untrusted-repository" : SessionMemory.taint(ctx.messages)

          // An entry the agent may not see here is one it may not change either.
          const target = params.id && params.action !== "add" ? yield* brain.get(place, params.id, { personal }) : undefined
          if (params.id && params.action !== "add" && !target) return refused(params.action, `No memory ${params.id} here.`)

          if (params.action === "forget") {
            if (!params.id) return refused("forget", "Say which memory to forget, by id.")
            // The agent only puts an entry away; the user deletes for good in Settings > Memory. A session that read
            // outside content may not put anything away at all, so planted text cannot wipe what Vector knows, and
            // what the user wrote (or a file says) is theirs to put away.
            if (hold) return refused("forget", "This session took in outside content, so ask the user to forget it in Settings > Memory.")
            if (target?.entry.origin !== "agent")
              return refused("forget", `${params.id} is the user's own, so ask them to put it away in Settings > Memory.`)
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
          if (params.file && SECRET_FILE.test(params.file.replace(/\\/g, "/")))
            return refused(
              params.action,
              "Vector does not cite .env, key or credentials files as evidence. Quote the user, or cite another file.",
            )
          const evidence = yield* verify(params, ctx, place.root, git)
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
            output: written(result, target?.entry),
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

// Files whose lines are secrets, never evidence.
const SECRET_FILE =
  /(?:^|\/)(?:\.env(?:\.[\w.-]+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_[a-z0-9]+|[\w.-]+\.(?:pem|key|p12|pfx)|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml|txt|env))$/i

// Evidence is checked here against the conversation and the files, never taken from the model's word: a quote must be
// the user's own, a file line must be on the default branch in a file the agent did not change in this session, and a
// command must be a check that failed and then passed in it. The brain then checks that the evidence states the memory.
const verify = Effect.fnUntraced(function* (
  params: Schema.Schema.Type<typeof Parameters>,
  ctx: Tool.Context<Metadata>,
  root: string,
  git: Git.Interface,
) {
  if (params.command)
    return { type: "check" as const, command: params.command, verified: SessionMemory.checked(ctx.messages, params.command) }
  if (params.file && params.quote) {
    const target = path.resolve(root, params.file)
    const file = path.relative(root, target).split(path.sep).join("/")
    // The file as the default branch has it, so a line the agent wrote this session, a file it created, or a pull
    // request checked out for review (whose commit is HEAD) cannot vouch for itself.
    const base = FSUtil.contains(root, target) && !SessionMemory.touched(ctx.messages, target, root) ? yield* git.defaultBranch(root) : undefined
    const committed = base ? yield* git.show(root, base.ref, file) : ""
    return {
      type: "file" as const,
      path: file,
      quote: params.quote,
      ...(committed ? { hash: createHash("sha256").update(committed).digest("hex").slice(0, 16) } : {}),
      verified: committed !== "" && normal(params.quote).length >= 6 && normal(committed).includes(normal(params.quote)),
    }
  }
  if (params.quote)
    return {
      type: "message" as const,
      quote: params.quote,
      // Personal memory follows the user everywhere, so it takes what they said in the message this step answers.
      verified: SessionMemory.quoted(params.scope === "personal" ? SessionMemory.request(ctx.messages) : ctx.messages, params.quote),
    }
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
  if (item.type === "message") return item.quote ? `the user said "${item.quote}"` : "a quote Vector could not check"
  if (item.type === "file") return item.quote ? `${item.path ?? "a file"}: "${item.quote}"` : `${item.path ?? "a file"}, unchecked`
  if (item.type === "check") return item.command ? `\`${item.command}\` passed after failing` : "a check Vector could not confirm"
  if (item.type === "file-item") return "a file"
  return "the user saved it"
}

// The words memory keeps, quoted, so the agent knows what memory says rather than assuming its own wording was saved.
// A personal entry's words stay out of the transcript.
function words(entry: BrainSchema.Entry, length = 300) {
  return entry.scope === "personal" ? "(personal memory)" : `"${entry.text.slice(0, length)}"`
}

function written(result: Exclude<Brain.WriteResult, { type: "refused" }>, replaced: BrainSchema.Entry | undefined) {
  const id = result.entry.id
  // A different fact can share most of these words, so memory never replaces it on its own; the agent decides.
  const related =
    "related" in result && result.related
      ? ` Related ${result.related.id}: ${words(result.related, 120)}. If this replaces it, use update(${result.related.id}) instead.`
      : ""
  if (result.type === "added") return `Saved as ${id}.${related}`
  if (result.type === "merged") {
    if (result.entry.status === "active") return `Already known as ${id}: ${words(result.entry)}`
    if (result.entry.status === "archived") return `Already in memory as ${id}, put away: ${words(result.entry)}`
    return `Already in memory as ${id}, waiting for the user's review: ${words(result.entry)}`
  }
  if (result.type === "promoted") return `Confirmed ${id}: ${words(result.entry)}. It is in use now.`
  if (result.type === "superseded")
    return `Saved as ${id}, replacing ${result.previous}${replaced ? `: ${words(replaced, 120)}` : ""}.`
  if (result.type === "proposed")
    return `Saved ${id} as a proposal, not in use yet: its evidence did not check out (the user's own words, a line on the default branch, or a check that went from failing to passing has to say what the memory says). The user can approve it in Settings > Memory.${related}`
  return `Saved ${id} for the user's review (${holdReason(result.entry.hold)}). It is not used until they approve it.${related}`
}

function withheld(entries: readonly BrainSchema.Entry[]) {
  const ids = entries.filter((entry) => entry.scope === "personal").map((entry) => entry.id)
  return ids.length ? { [SessionMemory.PERSONAL]: ids } : {}
}

function holdReason(hold: BrainSchema.Hold | undefined) {
  if (hold === "web") return "this session read web content or ran a command that reaches outside this computer"
  if (hold === "mcp") return "this session ran an MCP tool or an MCP server's prompt"
  if (hold === "subagent") return "this session took a subagent's report"
  if (hold === "guest") return "an invited guest is in this session"
  if (hold === "untrusted-repository") return "this repository's settings are not trusted"
  if (hold === "hidden-unicode") return "it had hidden characters"
  return "it reads like an instruction to the agent"
}

function refused(action: string, message: string) {
  return { title: "Memory not changed", output: message, metadata: { action, result: "refused" } }
}
