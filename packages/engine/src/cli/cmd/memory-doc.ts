import type { Argv } from "yargs"
import { EOL } from "os"
import path from "path"
import { Effect } from "effect"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import type { BrainSchema } from "@vectordevai/core/brain/schema"
import { Instruction } from "@/session/instruction"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

// `vector memory doc`: the documents Vector keeps for the repository in the current directory, as Settings > Memory >
// Documents shows them. Files are read on this computer; nothing here sends a document anywhere.

export const MemoryDocCommand = cmd({
  command: "doc",
  aliases: ["docs"],
  describe: "add documents for Vector to know, and see what it read from them",
  builder: (yargs: Argv) =>
    yargs
      .command(MemoryDocAddCommand)
      .command(MemoryDocExtractCommand)
      .command(MemoryDocListCommand)
      .command(MemoryDocShowCommand)
      .command(MemoryDocSearchCommand)
      .command(MemoryDocReadCommand)
      .command(MemoryDocForgetCommand)
      .command(MemoryDocReindexCommand)
      .command(MemoryDocApproveCommand)
      .command(MemoryDocRejectCommand)
      .demandCommand(),
  async handler() {},
})

/** The longest a command waits for a document to be read: past the reader's own 120 s limit for a PDF. */
const WAIT = 150_000

const where = Effect.gen(function* () {
  const instruction = yield* Instruction.Service
  return { knowledge: yield* BrainKnowledge.Service, place: yield* instruction.place() }
})

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}${EOL}`)

export const MemoryDocAddCommand = effectCmd({
  command: "add [files..]",
  describe: "keep files as documents (- reads Markdown from stdin, for any converter's output)",
  builder: (yargs) =>
    yargs
      .positional("files", { describe: "files to keep, or - for Markdown on stdin", type: "string", array: true })
      .option("name", { describe: "the document's title", type: "string" })
      .option("replace", {
        describe: "read a file of the same name as a document here as its next version",
        type: "boolean",
        default: false,
      })
      .option("wait", {
        describe: "wait until the document is searchable by keywords, or until it is read in full",
        choices: ["keyword", "all"] as const,
        default: "keyword" as const,
      })
      .option("json", { describe: "print JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.doc.add")(function* (args) {
    const memory = yield* where
    const files = [...(args.files ?? []).map(String), ...(stdinAsked() ? ["-"] : [])]
    if (files.length === 0) return yield* fail("Name a file to add, or - to read Markdown from stdin.")
    const titled = files.length === 1 ? args.name?.trim() : undefined
    const keep = Effect.fnUntraced(function* (file: string) {
      const piped = file === "-" ? yield* Effect.promise(() => Bun.stdin.text()) : undefined
      const input =
        piped === undefined
          ? { type: "path" as const, path: path.resolve(process.cwd(), file) }
          : {
              type: "text" as const,
              // Whatever the source was, what arrives on stdin is Markdown, kept under the name it was given.
              name: args.name?.trim() || "stdin",
              text: piped,
            }
      const result = yield* memory.knowledge.add(memory.place, {
        ...input,
        origin: "cli",
        replace: args.replace,
        ...(titled ? { title: titled } : {}),
      })
      if (result.type === "refused") return { file, result }
      // A file already kept under other bytes' name is renamed.
      if (titled && result.type === "unchanged")
        yield* memory.knowledge.update(memory.place, result.document.id, { title: titled })
      // Searchable by keywords is all there is to wait for until meaning search arrives.
      const document =
        (yield* memory.knowledge.wait(memory.place, result.document.id, "searchable", WAIT)) ?? result.document
      return { file, result: { ...result, document: titled ? { ...document, title: titled } : document } }
    })
    const results: { file: string; result: BrainKnowledge.AddResult }[] = []
    for (const file of files) results.push(yield* keep(file))
    if (args.json) print(results.map((item) => ({ file: item.file, ...item.result })))
    if (!args.json)
      for (const item of results)
        UI.println(
          item.result.type === "refused"
            ? `${UI.Style.TEXT_DANGER_BOLD}${item.file}${UI.Style.TEXT_NORMAL}: ${refusal(item.result)}`
            : `${UI.Style.TEXT_SUCCESS_BOLD}${verb(item.result.type)}${UI.Style.TEXT_NORMAL} ${line(item.result.document)}`,
        )
    const refused = results.filter((item) => item.result.type === "refused").length
    if (refused > 0) return yield* fail(`${refused} of ${results.length} file${results.length === 1 ? " was" : "s were"} not added.`)
  }),
})

// A dry run: what Vector would learn, read the way `add` reads and stored nowhere.
export const MemoryDocExtractCommand = effectCmd({
  command: "extract <file>",
  describe: "show what Vector would learn from a file, storing nothing",
  builder: (yargs) =>
    yargs
      .positional("file", { type: "string", demandOption: true })
      .option("json", { describe: "print every section, passage and record as JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.doc.extract")(function* (args) {
    const memory = yield* where
    const file = yield* Effect.promise(() =>
      BrainKnowledge.read(memory.place, { type: "path", path: path.resolve(process.cwd(), args.file), origin: "cli" }),
    )
    if (file.type === "refused") return yield* fail(file.message)
    const result = yield* memory.knowledge
      .extract({ name: file.name, bytes: file.bytes })
      .pipe(Effect.catch((error) => fail(`Vector could not read ${args.file}: ${error.message}`)))
    if ("type" in result) return yield* fail(result.message)
    if (args.json) return print(result)
    const kinds = Object.entries(
      result.records.reduce<Record<string, number>>((all, record) => ({ ...all, [record.kind]: (all[record.kind] ?? 0) + 1 }), {}),
    )
    UI.println(
      `${UI.Style.TEXT_HIGHLIGHT_BOLD}${result.title}${UI.Style.TEXT_NORMAL}: ${result.format}${result.pages ? `, ${result.pages} pages` : ""}, ${result.sections.length} sections, ${result.passages.length} passages, about ${result.tokens} tokens`,
    )
    UI.println(`Records: ${kinds.length ? kinds.map(([kind, count]) => `${count} ${kind}`).join(", ") : "none"}`)
    if (result.unread.length) UI.println(`${UI.Style.TEXT_WARNING}Pages with no text (scanned): ${result.unread.join(", ")}${UI.Style.TEXT_NORMAL}`)
    if (result.warnings.length) UI.println(`${UI.Style.TEXT_WARNING}Warnings: ${result.warnings.join(", ")}${UI.Style.TEXT_NORMAL}`)
    if (result.hold) UI.println(`${UI.Style.TEXT_WARNING}It would wait for your review: ${result.hold}${UI.Style.TEXT_NORMAL}`)
    UI.empty()
    for (const record of result.records.slice(0, 40))
      UI.println(`  ${record.kind}${record.page ? ` p.${record.page}` : ""}: ${record.card}${record.hold ? ` (held: ${record.hold})` : ""}`)
    if (result.records.length > 40) UI.println(`  … and ${result.records.length - 40} more; --json prints them all.`)
    UI.empty()
    UI.println(UI.Style.TEXT_DIM + "Nothing was stored. Run vector memory doc add to keep it." + UI.Style.TEXT_NORMAL)
  }),
})

export const MemoryDocListCommand = effectCmd({
  command: ["list", "ls"],
  describe: "list the documents Vector keeps for this repository",
  builder: (yargs) => yargs.option("json", { describe: "print JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.doc.list")(function* (args) {
    const memory = yield* where
    const documents = yield* memory.knowledge.documents(memory.place, { personal: true })
    if (args.json) return print(documents)
    if (documents.length === 0) return UI.println("No documents yet. Add one with: vector memory doc add <file>")
    for (const document of documents) UI.println(line(document))
  }),
})

export const MemoryDocShowCommand = effectCmd({
  command: "show <id>",
  describe: "show a document: its outline and counts, its records, a page, its code links or what waits for review",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "the document's id or number", type: "string", demandOption: true })
      .option("records", { describe: "list its records", type: "boolean", default: false })
      .option("kind", {
        describe: "only records of this kind",
        choices: ["requirement", "constraint", "decision", "contract", "procedure", "term", "entity", "fact", "question"] as const,
      })
      .option("page", { describe: "show the text Vector read from one page", type: "number" })
      .option("anchors", { describe: "list the code it is linked to", type: "boolean", default: false })
      .option("held", { describe: "list what waits for your review", type: "boolean", default: false })
      .option("json", { describe: "print JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.doc.show")(function* (args) {
    const memory = yield* where
    const id = yield* resolve(args.id)
    const detail = yield* memory.knowledge.document(memory.place, id, { personal: true })
    if (!detail) return yield* fail(`No document ${args.id} here.`)
    if (args.page !== undefined) {
      const page = yield* memory.knowledge.page(memory.place, id, args.page, { personal: true })
      if (!page) return yield* fail(`Document ${args.id} has no page ${args.page}.`)
      if (args.json) return print(page)
      if (page.unread) UI.println(`${UI.Style.TEXT_WARNING}Page ${page.page} is a scanned image; Vector read no text on it.${UI.Style.TEXT_NORMAL}`)
      for (const passage of page.passages) {
        UI.println(`${UI.Style.TEXT_DIM}[${passage.id}] ${passage.section}${passage.page !== undefined && passage.page < page.page ? ` (from p.${passage.page})` : ""}${passage.hold ? ` held: ${passage.hold}` : ""}${UI.Style.TEXT_NORMAL}`)
        UI.println(passage.text)
        for (const record of passage.records)
          UI.println(`  ${UI.Style.TEXT_HIGHLIGHT}${record.id}${UI.Style.TEXT_NORMAL} ${record.kind}: ${passage.text.slice(record.start, record.end)}`)
        UI.empty()
      }
      return
    }
    if (args.records || args.kind) {
      const records = yield* allRecords(id, args.kind)
      if (args.json) return print(records)
      if (records.length === 0) return UI.println("No records.")
      for (const record of records) UI.println(recordLine(record))
      return
    }
    if (args.anchors) {
      if (args.json) return print(detail.anchors)
      if (detail.anchors.length === 0) return UI.println("Not linked to any code yet.")
      for (const anchor of detail.anchors)
        UI.println(`${anchor.owner} → ${anchor.path}${anchor.symbol ? ` ${anchor.symbol}` : ""}${anchor.line ? `:${anchor.line}` : ""} (${anchor.status})`)
      return
    }
    if (args.held) {
      if (args.json) return print(detail.held)
      if (detail.held.length === 0) return UI.println("Nothing in this document waits for your review.")
      for (const item of detail.held) UI.println(`${item.id}${item.page ? ` p.${item.page}` : ""}: held, ${item.hold}`)
      UI.println(UI.Style.TEXT_DIM + `Approve with: vector memory doc approve <id>` + UI.Style.TEXT_NORMAL)
      return
    }
    if (args.json) return print(detail)
    const document = detail.document
    UI.println(line(document))
    UI.println(
      `  ${document.stats.sections} sections, ${detail.counts.passages} passages, ${detail.counts.records} records (${detail.counts.active} in use, ${detail.counts.held} to review, ${detail.counts.archived} put away), about ${document.stats.tokens} tokens if sent whole`,
    )
    if (document.unread.length) UI.println(`  Pages with no text (scanned): ${document.unread.join(", ")}`)
    if (document.warnings.length) UI.println(`  Warnings: ${document.warnings.join(", ")}`)
    if (document.error) UI.println(`  ${UI.Style.TEXT_DANGER}${document.error}${UI.Style.TEXT_NORMAL}`)
    if (detail.versions.length > 1)
      UI.println(`  Versions: ${detail.versions.map((version) => `v${version.version} ${day(version.createdAt)} (${version.status})`).join(", ")}`)
    UI.empty()
    for (const section of detail.sections.filter((item) => item.path))
      UI.println(
        `${"  ".repeat(Math.max(0, section.level - 1))}${section.heading}${section.pageStart === undefined ? "" : ` ${UI.Style.TEXT_DIM}p.${section.pageStart}${section.pageEnd && section.pageEnd !== section.pageStart ? `-${section.pageEnd}` : ""}${UI.Style.TEXT_NORMAL}`}`,
      )
  }),
})

export const MemoryDocSearchCommand = effectCmd({
  command: "search <query..>",
  describe: "search documents by keywords, the way the agent does",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", array: true, demandOption: true })
      .option("why", { describe: "say which of the words each result matched", type: "boolean", default: false })
      .option("json", { describe: "print JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.doc.search")(function* (args) {
    const memory = yield* where
    const query = args.query.join(" ")
    const cards = yield* memory.knowledge.search(memory.place, { query, limit: 10, personal: true })
    const words = Array.from(new Set<string>(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []))
    // What each result shares with the query, said plainly; it is never sent to a model.
    const why = (card: BrainSchema.Card) =>
      words.filter((word) => `${card.title} ${card.section ?? ""} ${card.text}`.toLowerCase().includes(word))
    if (args.json) return print(cards.map((card) => (args.why ? { ...card, why: why(card) } : card)))
    if (cards.length === 0) return UI.println("Nothing in the documents matches.")
    for (const card of cards) {
      UI.println(
        `${UI.Style.TEXT_HIGHLIGHT}${card.id}${UI.Style.TEXT_NORMAL} ${card.kind} · ${card.title}${card.page ? ` p.${card.page}` : ""}${card.section ? ` §${card.section}` : ""}: ${card.text.replace(/\s+/g, " ").slice(0, 200)}`,
      )
      if (args.why) UI.println(`  ${UI.Style.TEXT_DIM}matched: ${why(card).join(", ") || "related words"}${UI.Style.TEXT_NORMAL}`)
    }
  }),
})

export const MemoryDocReadCommand = effectCmd({
  command: "read <id> [part]",
  describe: "read a document's outline, a section (3.2 or a heading) or a page (p14), or a record or passage",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "a document's id or number, or a record's or passage's id", type: "string", demandOption: true })
      .positional("part", { describe: "a section number or heading, or a page such as p14", type: "string" }),
  handler: Effect.fn("Cli.memory.doc.read")(function* (args) {
    const memory = yield* where
    const id = /^#?\d+$/.test(args.id) ? yield* resolve(args.id) : args.id
    const got = yield* memory.knowledge.get(memory.place, {
      id,
      ...(args.part ? { part: args.part } : {}),
      // The user reads more than the agent is given at once.
      budget: 4 * BrainKnowledge.GET.part,
      personal: true,
    })
    if (!got) return yield* fail(args.part ? `Document ${args.id} has no ${args.part}.` : `Nothing ${args.id} here.`)
    process.stdout.write(`${got.text}${EOL}`)
  }),
})

export const MemoryDocForgetCommand = effectCmd({
  command: "forget <id>",
  describe: "forget a document and every version of it; Vector will not keep it again on its own",
  builder: (yargs) => yargs.positional("id", { describe: "the document's id or number", type: "string", demandOption: true }),
  handler: Effect.fn("Cli.memory.doc.forget")(function* (args) {
    const memory = yield* where
    const id = yield* resolve(args.id)
    if ((yield* memory.knowledge.remove(memory.place, id)) === "not-found") return yield* fail(`No document ${args.id} here.`)
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Forgot ${id}` + UI.Style.TEXT_NORMAL)
  }),
})

export const MemoryDocReindexCommand = effectCmd({
  command: "reindex [id]",
  describe: "read a document again from its file, or every document an older reader read",
  builder: (yargs) => yargs.positional("id", { describe: "the document's id or number", type: "string" }),
  handler: Effect.fn("Cli.memory.doc.reindex")(function* (args) {
    const memory = yield* where
    const id = args.id ? yield* resolve(args.id) : undefined
    const count = yield* memory.knowledge.reindex(memory.place, id)
    if (id && count === 0)
      return yield* fail(`Vector cannot read ${args.id} again now: it is being read, or its file changed or is gone and no copy was kept.`)
    const documents = yield* memory.knowledge.documents(memory.place, { personal: true })
    yield* Effect.forEach(
      documents.filter((document) => !id || document.id === id),
      (document) => memory.knowledge.wait(memory.place, document.id, "searchable", WAIT),
      { discard: true },
    )
    UI.println(`Read ${count} document${count === 1 ? "" : "s"} again.`)
  }),
})

const decide = (action: "approve" | "reject", describe: string, done: string) =>
  effectCmd({
    command: `${action} <id>`,
    describe,
    builder: (yargs) =>
      yargs.positional("id", { describe: "a document's id or number, or a held passage's or record's id", type: "string", demandOption: true }),
    handler: Effect.fn(`Cli.memory.doc.${action}`)(function* (args) {
      const memory = yield* where
      const id = /^#?\d+$/.test(args.id) ? yield* resolve(args.id) : args.id
      if ((yield* memory.knowledge.update(memory.place, id, { action })) === "not-found")
        return yield* fail(`Nothing ${args.id} waits for your review here.`)
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + `${done} ${id}` + UI.Style.TEXT_NORMAL)
    }),
  })

export const MemoryDocApproveCommand = decide("approve", "let Vector use a document or passage that waited for your review", "Approved")
export const MemoryDocRejectCommand = decide("reject", "forget a document, or put away a passage or record, that waited for your review", "Rejected")

// `vector memory repo-docs on|off`: whether Vector reads the repository's own docs (READMEs, docs/, ADRs, API specs).
export const MemoryRepoDocsCommand = effectCmd({
  command: "repo-docs [state]",
  describe: "see or set whether Vector reads this repository's own docs, which are shared like its memory, not private",
  builder: (yargs) => yargs.positional("state", { choices: ["on", "off"] as const }),
  handler: Effect.fn("Cli.memory.repoDocs")(function* (args) {
    const memory = yield* where
    const settings = args.state
      ? yield* memory.knowledge.configure(memory.place, { repositoryDocs: args.state === "on" })
      : yield* memory.knowledge.settings(memory.place)
    UI.println(
      settings.repositoryDocs
        ? "Vector reads this repository's docs (READMEs, docs/, decision records and API specs). Unlike documents you add, they are not private: they are shared like the repository's memory, with invited guests and with models that may train on prompts."
        : "Vector does not read this repository's docs.",
    )
  }),
})

// Whether `-` (stdin) is among the files. yargs drops a lone "-" from a list of positionals, so it is looked for where
// the user typed it, after `doc add`.
function stdinAsked() {
  const raw = process.argv.slice(2)
  const at = raw.findIndex((arg, index) => arg === "add" && (raw[index - 1] === "doc" || raw[index - 1] === "docs"))
  if (at < 0) return false
  const rest = raw.slice(at + 1)
  const end = rest.indexOf("--")
  return (end < 0 ? rest : rest.slice(0, end)).some((arg, index, all) => arg === "-" && all[index - 1] !== "--name")
}

// A document by its id, or by the number it is listed under.
const resolve = Effect.fnUntraced(function* (input: string) {
  if (!/^#?\d+$/.test(input)) return input
  const memory = yield* where
  const ordinal = Number(input.replace("#", ""))
  const found = (yield* memory.knowledge.documents(memory.place, { personal: true })).find(
    (document) => document.ordinal === ordinal,
  )
  return found?.id ?? input
})

const allRecords = Effect.fnUntraced(function* (document: string, kind?: BrainSchema.RecordKind) {
  const memory = yield* where
  const pages: BrainSchema.Record[] = []
  for (let cursor: string | undefined = undefined; ; ) {
    const page: BrainKnowledge.RecordPage = yield* memory.knowledge.records(memory.place, {
      document,
      ...(kind ? { kind } : {}),
      status: "all",
      limit: BrainKnowledge.LIMIT.records,
      ...(cursor ? { cursor } : {}),
      personal: true,
    })
    pages.push(...page.records)
    if (!page.cursor) return pages
    cursor = page.cursor
  }
})

// Why a file was not added, in the CLI's words: a new version is the user's call, made with --replace.
function refusal(result: { readonly reason: string; readonly message: string; readonly document?: BrainSchema.Document }) {
  if (result.reason !== "version" || !result.document) return result.message
  return `${result.document.name} is already document #${result.document.ordinal} (v${result.document.version}, added ${day(result.document.createdAt)}). Run again with --replace to read this file as its next version.`
}

function verb(type: "queued" | "unchanged" | "version") {
  if (type === "unchanged") return "Already kept"
  if (type === "version") return "Replaced with a new version:"
  return "Added"
}

function day(at: number) {
  return new Date(at).toISOString().slice(0, 10)
}

function line(document: BrainSchema.Document) {
  const marks = [
    document.status === "held" && document.hold ? `held: ${document.hold}` : document.status,
    document.paused ? "paused" : undefined,
    document.visibility === "private" ? "private" : undefined,
    document.version > 1 ? `v${document.version}` : undefined,
  ].filter((mark): mark is string => mark !== undefined)
  return `${UI.Style.TEXT_HIGHLIGHT}#${document.ordinal} ${document.id}${UI.Style.TEXT_NORMAL} ${document.title} ${UI.Style.TEXT_DIM}(${document.format}${document.pages ? `, ${document.pages} pages` : ""}, ${document.stats.records} records; ${marks.join(", ")})${UI.Style.TEXT_NORMAL}`
}

function recordLine(record: BrainSchema.Record) {
  const marks = [
    record.status === "active" ? undefined : record.hold ? `${record.status}: ${record.hold}` : record.status,
    record.pinned ? "pinned" : undefined,
    record.userEdited ? "edited" : undefined,
    record.page ? `p.${record.page}` : undefined,
  ].filter((mark): mark is string => mark !== undefined)
  return `${UI.Style.TEXT_HIGHLIGHT}${record.id}${UI.Style.TEXT_NORMAL} ${record.kind}: ${record.card.replace(/\s+/g, " ").slice(0, 200)}${marks.length ? `${UI.Style.TEXT_DIM} (${marks.join(", ")})${UI.Style.TEXT_NORMAL}` : ""}`
}
