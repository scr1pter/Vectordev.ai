import type { Argv } from "yargs"
import { EOL } from "os"
import path from "path"
import { Effect } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import type { BrainSchema } from "@vectordevai/core/brain/schema"
import { Instruction } from "@/session/instruction"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

// `vector memory`: the same controls as Settings > Memory, for the repository in the current directory and for the
// user. Memory stays on this computer; nothing here sends it anywhere.

export const MemoryCommand = cmd({
  command: "memory",
  describe: "see and manage what Vector remembers for this repository and for you",
  builder: (yargs: Argv) =>
    yargs
      .command(MemoryListCommand)
      .command(MemorySearchCommand)
      .command(MemoryShowCommand)
      .command(MemoryAddCommand)
      .command(MemoryEditCommand)
      .command(MemoryPinCommand)
      .command(MemoryUnpinCommand)
      .command(MemoryApproveCommand)
      .command(MemoryRejectCommand)
      .command(MemoryForgetCommand)
      .command(MemoryTidyCommand)
      .command(MemoryEraseCommand)
      .command(MemoryLearningCommand)
      .command(MemoryExportCommand)
      .demandCommand(),
  async handler() {},
})

const where = Effect.gen(function* () {
  const instruction = yield* Instruction.Service
  return { brain: yield* Brain.Service, place: yield* instruction.place() }
})

const scopeOption = <T>(yargs: Argv<T>) =>
  yargs.option("personal", { describe: "your own memory, for every repository", type: "boolean", default: false })

export const MemoryListCommand = effectCmd({
  command: ["list", "ls"],
  describe: "list memory: rules, saved preferences and what Vector learned",
  builder: (yargs) =>
    scopeOption(yargs)
      .option("review", { describe: "only what waits for your review", type: "boolean", default: false })
      .option("archived", { describe: "only archived and replaced entries", type: "boolean", default: false })
      .option("all", { describe: "every entry, whatever its state", type: "boolean", default: false })
      .option("json", { describe: "print JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.list")(function* (args) {
    const { brain, place } = yield* where
    const entries = yield* brain.list(place, {
      filter: args.all ? "all" : args.review ? "review" : args.archived ? "archived" : "active",
      ...(args.personal ? { scope: "personal" as const } : {}),
    })
    if (args.json) return void process.stdout.write(`${JSON.stringify(entries, null, 2)}${EOL}`)
    if (entries.length === 0) return UI.println(args.review ? "Nothing waits for your review." : "Nothing in memory yet.")
    for (const entry of entries) UI.println(line(entry))
    const stats = yield* brain.stats(place)
    UI.empty()
    UI.println(
      UI.Style.TEXT_DIM +
        `${stats.active} active, ${stats.review} to review, ${stats.archived} archived. The always-loaded part costs about ${stats.digestTokens} tokens per request.` +
        UI.Style.TEXT_NORMAL,
    )
  }),
})

export const MemorySearchCommand = effectCmd({
  command: "search <query..>",
  describe: "search memory the way the agent does",
  builder: (yargs) => yargs.positional("query", { type: "string", array: true, demandOption: true }),
  handler: Effect.fn("Cli.memory.search")(function* (args) {
    const { brain, place } = yield* where
    const entries = yield* brain.list(place, { query: args.query.join(" ") })
    if (entries.length === 0) return UI.println("Nothing in memory matches.")
    for (const entry of entries.slice(0, 20)) UI.println(line(entry))
  }),
})

export const MemoryShowCommand = effectCmd({
  command: "show <id>",
  describe: "show one entry with its evidence",
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.memory.show")(function* (args) {
    const { brain, place } = yield* where
    const detail = yield* brain.get(place, args.id, { personal: true })
    if (!detail) return yield* fail(`No memory ${args.id} here.`)
    UI.println(line(detail.entry))
    for (const item of detail.evidence)
      UI.println(
        `  ${new Date(item.createdAt).toISOString().slice(0, 10)} | ${item.type}${item.path ? ` ${item.path}` : ""}${item.quote ? `: "${item.quote}"` : ""}${item.command ? `: ${item.command}` : ""}`,
      )
    if (detail.related.length) UI.println(`  Related: ${detail.related.map((item) => item.id).join(", ")}`)
  }),
})

export const MemoryAddCommand = effectCmd({
  command: "add <text..>",
  describe: "save something for Vector to remember",
  builder: (yargs) =>
    scopeOption(yargs)
      .positional("text", { type: "string", array: true, demandOption: true })
      .option("kind", {
        describe: "what it is",
        choices: ["preference", "decision", "lesson", "fact"] as const,
        default: "lesson" as const,
      }),
  handler: Effect.fn("Cli.memory.add")(function* (args) {
    const { brain, place } = yield* where
    const result = yield* brain.propose(place, {
      kind: args.kind,
      text: args.text.join(" "),
      scope: args.personal ? "personal" : "repository",
      origin: "user",
      evidence: { type: "user" },
    })
    if (result.type === "refused") return yield* fail(result.message)
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Saved ${result.entry.id}` + UI.Style.TEXT_NORMAL)
  }),
})

export const MemoryEditCommand = effectCmd({
  command: "edit <id> <text..>",
  describe: "change the text of an entry Vector learned",
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .positional("text", { type: "string", array: true, demandOption: true }),
  handler: Effect.fn("Cli.memory.edit")(function* (args) {
    yield* change(args.id, { text: args.text.join(" ") }, "Updated")
  }),
})

const simple = (name: string, describe: string, update: Brain.Change, done: string) =>
  effectCmd({
    command: `${name} <id>`,
    describe,
    builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
    handler: Effect.fn(`Cli.memory.${name}`)(function* (args) {
      yield* change(args.id, update, done)
    }),
  })

export const MemoryPinCommand = simple("pin", "keep an entry in every request", { pinned: true }, "Pinned")
export const MemoryUnpinCommand = simple("unpin", "stop pinning an entry", { pinned: false }, "Unpinned")
export const MemoryApproveCommand = simple(
  "approve",
  "let Vector use an entry that waited for your review",
  { action: "approve" },
  "Approved",
)
export const MemoryRejectCommand = simple(
  "reject",
  "delete an entry that waited for your review",
  { action: "reject" },
  "Rejected",
)

const change = Effect.fnUntraced(function* (id: string, update: Brain.Change, done: string) {
  const { brain, place } = yield* where
  const result = yield* brain.update(place, id, update, "user")
  if (!result) return yield* fail(`No memory ${id} here.`)
  if (result.type === "refused") return yield* fail(result.message)
  UI.println(UI.Style.TEXT_SUCCESS_BOLD + `${done} ${id}` + UI.Style.TEXT_NORMAL)
})

export const MemoryForgetCommand = effectCmd({
  command: "forget <id>",
  describe: "delete an entry for good; Vector will not learn it again",
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.memory.forget")(function* (args) {
    const { brain, place } = yield* where
    const result = yield* brain.forget(place, args.id)
    if (result === "not-found") return yield* fail(`No memory ${args.id} here.`)
    if (result === "file-entry") return yield* fail("That entry comes from a file you wrote; change it in that file.")
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Forgot ${args.id}` + UI.Style.TEXT_NORMAL)
  }),
})

export const MemoryTidyCommand = effectCmd({
  command: "tidy",
  describe: "merge duplicates, confirm or drop proposals, archive what goes unused",
  handler: Effect.fn("Cli.memory.tidy")(function* () {
    const { brain, place } = yield* where
    const report = yield* brain.consolidate(place, { force: true })
    UI.println(
      `Merged ${report.merged}, confirmed ${report.promoted}, archived ${report.archived}, dropped ${report.dropped}, marked ${report.stale} stale.`,
    )
  }),
})

export const MemoryEraseCommand = effectCmd({
  command: "erase",
  describe: "erase what Vector learned (files you wrote are left alone)",
  builder: (yargs) =>
    scopeOption(yargs)
      .option("everywhere", { describe: "every repository and your own", type: "boolean", default: false })
      .option("yes", { describe: "confirm", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.erase")(function* (args) {
    const scope = args.everywhere ? "all" : args.personal ? "personal" : "repository"
    const what =
      scope === "all"
        ? "everything Vector learned, in every repository and about you"
        : scope === "personal"
          ? "what Vector learned about you"
          : "what Vector learned in this repository, its failure memory included"
    if (!args.yes) return yield* fail(`This erases ${what}. Run it again with --yes to confirm.`)
    const { brain, place } = yield* where
    const count = yield* brain.erase(place, scope)
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Erased ${count} entr${count === 1 ? "y" : "ies"}` + UI.Style.TEXT_NORMAL)
  }),
})

export const MemoryLearningCommand = effectCmd({
  command: "learning [state]",
  describe: "see or set whether Vector adds to its memory as it works",
  builder: (yargs) => yargs.positional("state", { choices: ["on", "off"] as const }),
  handler: Effect.fn("Cli.memory.learning")(function* (args) {
    const brain = yield* Brain.Service
    if (args.state) yield* brain.setLearning(args.state === "on")
    UI.println(`Learning is ${(yield* brain.learning()) ? "on" : "off"}.`)
  }),
})

// A readable page per kind, each entry with its evidence below it: open your brain and read it.
export const MemoryExportCommand = effectCmd({
  command: "export",
  describe: "print memory as Markdown, entries with their evidence",
  builder: (yargs) => scopeOption(yargs),
  handler: Effect.fn("Cli.memory.export")(function* (args) {
    const { brain, place } = yield* where
    const entries = yield* brain.list(place, { filter: "all", ...(args.personal ? { scope: "personal" as const } : {}) })
    const kinds: readonly BrainSchema.Kind[] = ["rule", "preference", "decision", "lesson", "fact", "failure", "review"]
    const sections = yield* Effect.forEach(kinds, (kind) =>
      Effect.gen(function* () {
        const items = entries.filter((entry) => entry.kind === kind)
        if (items.length === 0) return []
        const body = yield* Effect.forEach(items, (entry) =>
          Effect.gen(function* () {
            const detail = yield* brain.get(place, entry.id, { personal: true })
            return [
              `- **${entry.id}** ${entry.text}${entry.status === "active" ? "" : ` _(${entry.status})_`}`,
              ...(entry.source ? [`  - from ${path.basename(entry.source.file)}`] : []),
              ...(detail?.evidence ?? []).map(
                (item) =>
                  `  - ${new Date(item.createdAt).toISOString().slice(0, 10)} | ${item.type}${item.quote ? `: "${item.quote}"` : ""}${item.command ? `: \`${item.command}\`` : ""}`,
              ),
            ]
          }),
        )
        return [`## ${kind[0]!.toUpperCase()}${kind.slice(1)}s`, "", ...body.flat(), ""]
      }),
    )
    process.stdout.write(`${["# Vector memory", "", ...sections.flat()].join(EOL)}${EOL}`)
  }),
})

function line(entry: BrainSchema.Entry) {
  const marks = [
    entry.pinned ? "pinned" : undefined,
    entry.status === "active" ? undefined : entry.status,
    entry.hold ? `held: ${entry.hold}` : undefined,
    entry.stale ? "stale" : undefined,
    entry.scope === "personal" ? "personal" : undefined,
    entry.source ? path.basename(entry.source.file) : undefined,
  ].filter((mark): mark is string => mark !== undefined)
  return `${UI.Style.TEXT_HIGHLIGHT}${entry.id}${UI.Style.TEXT_NORMAL} ${entry.kind}: ${entry.text.replace(/\s+/g, " ").slice(0, 160)}${marks.length ? `${UI.Style.TEXT_DIM} (${marks.join(", ")})${UI.Style.TEXT_NORMAL}` : ""}`
}
