export * as SessionMemory from "./memory"

import path from "path"
import { fileURLToPath } from "url"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { BrainAnchor } from "@vectordevai/core/brain/anchor"
import { BrainFuse } from "@vectordevai/core/brain/fuse"
import { BrainSchema } from "@vectordevai/core/brain/schema"
import { FSUtil } from "@vectordevai/core/fs-util"
import { attachedMemory, links, type Asking } from "./instruction"

// What the session runtime and the memory tool read from a conversation to use and to grow Vector's memory: the user's
// own words (evidence for what they said), the checks that went from failing to passing (evidence for a lesson), the
// memory already in the conversation (never sent twice), and whether outside content came in (memory waits for the
// user then). All of it is read from the history, so it holds across restarts and is the same in every engine.

/** Metadata key of the synthetic part that carries a request message's recalled memory. */
export const RECALL = "vector.memory.recall"

/**
 * Metadata key of a text part a slash command wrote: its template, an MCP server's prompt, a skill, or what its shell
 * snippets printed. The value says which arguments the user typed and whether the text came from outside.
 */
export const COMMAND = "vector.command"

/** Metadata key of a memory tool result's personal entries, which the transcript keeps as ids only. */
export const PERSONAL = "vector.memory.personal"

/** How a memory tool result stands in for a personal entry; each request fills the line in while that is allowed. */
export function withheld(id: string) {
  return `[${id}] (personal memory)`
}

/**
 * Metadata key of the text part that marks an attachment for Vector to keep as a document: `{ mode, part }`, where
 * `part` is the attached file part's id (or `filename` its name). "keep" sends the file too; "instead" keeps it in memory
 * in place of sending it, so the model gets its outline and cards rather than its pages. A marker has no text of its
 * own, so it costs nothing on the request.
 */
export const REMEMBER = "vector.memory.remember"

/**
 * Metadata key of what document knowledge a part stands for, by id, so the transcript never keeps a document's words:
 * the outline of a document kept from an attachment (`document`, `part`), or the cards and passages a memory tool
 * result showed (`cards`, `get`). Each request renders them again from the brain, so a forgotten document is gone from
 * old sessions too, and a private one stays out where private documents may not go.
 */
export const KNOWLEDGE = "vector.memory.knowledge"

/**
 * A client's part metadata without the keys only the engine writes. Recall, document knowledge and personal ids record
 * what a request was given; a client's copy of them would skip recall for its request, or pass off ids it was never
 * shown as delivered (and so as verified citations).
 */
export function admitted(metadata: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => key !== RECALL && key !== KNOWLEDGE && key !== PERSONAL),
  )
}

/** How a memory tool result stands in for a document card or passage; each request renders it again. */
export function document(id: string) {
  return `[${id}] (document)`
}

/** The attachments a message marked for Vector to keep, with their file parts. */
export function remember(message: SessionV1.WithParts) {
  return message.parts.flatMap((part) => {
    if (part.type !== "text") return []
    const value = part.metadata?.[REMEMBER]
    if (!value || typeof value !== "object" || !("mode" in value)) return []
    const mode = value.mode === "instead" ? ("instead" as const) : value.mode === "keep" ? ("keep" as const) : undefined
    const id = "part" in value && typeof value.part === "string" ? value.part : undefined
    const name = "filename" in value && typeof value.filename === "string" ? value.filename : undefined
    const file = message.parts.find(
      (item): item is SessionV1.FilePart =>
        item.type === "file" && (id ? item.id === id : name !== undefined && item.filename === name),
    )
    return mode && file ? [{ mode, file, marker: part.id }] : []
  })
}

/** What document knowledge a part stands for, when it does. */
export function knowledge(part: SessionV1.Part) {
  const value =
    part.type === "text" && part.synthetic
      ? part.metadata?.[KNOWLEDGE]
      : part.type === "tool" && part.tool === "memory" && part.state.status === "completed"
        ? part.state.metadata?.[KNOWLEDGE]
        : undefined
  if (!value || typeof value !== "object") return undefined
  const strings = (list: unknown) =>
    Array.isArray(list) ? list.filter((id: unknown): id is string => typeof id === "string") : []
  const gets = "get" in value && Array.isArray(value.get) ? value.get : []
  return {
    document: "document" in value && typeof value.document === "string" ? value.document : undefined,
    part: "part" in value && typeof value.part === "string" ? value.part : undefined,
    cards: "cards" in value ? strings(value.cards) : [],
    get: (gets as unknown[]).flatMap((item) =>
      item && typeof item === "object" && "id" in item && typeof item.id === "string"
        ? [
            {
              id: item.id,
              ...("part" in item && typeof item.part === "string" ? { part: item.part } : {}),
              budget: "budget" in item && typeof item.budget === "number" ? item.budget : 600,
            },
          ]
        : [],
    ),
    tokens: "tokens" in value && typeof value.tokens === "number" ? value.tokens : 0,
  }
}

// Tools whose output is written by Vector or by the user's own repository. Anything else (web fetch and search, the
// browser, Vector Cloud logs, MCP servers, a subagent's report of its own work) brings in content from outside.
const LOCAL_TOOLS = new Set([
  "bash",
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "apply_patch",
  "todowrite",
  "question",
  "skill",
  "memory",
  "escalate",
  "lsp",
  "plan_exit",
  "invalid",
  "StructuredOutput",
])

/**
 * What the user typed in a message, without Vector's synthetic notes or attached file contents. A slash command's text
 * is someone else's words (a template, an MCP server's prompt, a skill, a snippet's output), so of it only the
 * arguments the user typed count, and text from outside (an imported transcript, an issue) does not count at all.
 */
export function typed(message: SessionV1.WithParts) {
  return message.parts
    .flatMap((part) => {
      if (part.type !== "text" || part.synthetic || part.ignored || outside(part)) return []
      return [command(part)?.arguments ?? part.text]
    })
    .join("\n")
    .trim()
}

/** What a message asks for, a slash command's text included: what recall reads a request by. */
export function asked(message: SessionV1.WithParts) {
  return message.parts
    .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
    .join("\n")
    .trim()
}

/** Where a slash command's text part came from, or nothing for a part the user typed. */
export function command(part: SessionV1.Part) {
  if (part.type !== "text") return undefined
  const value = part.metadata?.[COMMAND]
  if (!value || typeof value !== "object") return undefined
  return {
    arguments: "arguments" in value && typeof value.arguments === "string" ? value.arguments : "",
    outside: "outside" in value && (value.outside === "web" || value.outside === "mcp") ? value.outside : undefined,
  }
}

/**
 * Whether a part's text came from outside this conversation though it may sit in a "user" message: a transcript
 * imported as passive history, the issue and pull request text the GitHub agent was given, a resource an editor
 * embedded, or what was piped into `vector run`.
 */
export function outside(part: SessionV1.Part) {
  return part.type === "text" && part.metadata?.[BrainSchema.OUTSIDE] !== undefined
}

/**
 * The document knowledge this conversation took in, by id: the cards recalled into its messages, the outlines of the
 * attachments it kept, and the cards and passages the memory tool showed. What the agent learns after reading them
 * takes their documents' privacy, and waits for the user when one came from outside.
 */
export function documents(messages: readonly SessionV1.WithParts[]) {
  return [
    ...new Set(
      messages.flatMap((message) =>
        message.parts.flatMap((part) => {
          const known = knowledge(part)
          return [
            ...(recall(part)?.cards ?? []),
            ...(known?.cards ?? []),
            ...(known?.get.map((item) => item.id) ?? []),
            // A tool result naming a document only says it was kept; an outline the request carried showed it.
            ...(part.type === "text" && known?.document ? [known.document] : []),
          ]
        }),
      ),
    ),
  ]
}

/** The personal entries a memory tool result stands in for. */
export function personal(part: SessionV1.Part) {
  if (part.type !== "tool" || part.tool !== "memory" || part.state.status !== "completed") return []
  const ids = part.state.metadata?.[PERSONAL]
  return Array.isArray(ids) ? ids.filter((id: unknown): id is string => typeof id === "string") : []
}

/** The files a message attached, as paths. */
export function files(message: SessionV1.WithParts) {
  return message.parts.flatMap((part) => {
    if (part.type !== "file" || !part.url.startsWith("file:")) return []
    try {
      return [fileURLToPath(part.url)]
    } catch {
      return []
    }
  })
}

/**
 * The memory a part recalled: every entry's id, and which of them are the user's personal memory. Personal lines are
 * not saved with the part, so each request fills them in again while personal memory is allowed.
 */
export function recall(part: SessionV1.Part) {
  if (part.type !== "text" || !part.synthetic) return undefined
  const value = part.metadata?.[RECALL]
  if (!value || typeof value !== "object" || !("ids" in value) || !Array.isArray(value.ids)) return undefined
  const strings = (list: unknown) =>
    Array.isArray(list) ? list.filter((id: unknown): id is string => typeof id === "string") : []
  return {
    ids: strings(value.ids),
    personal: "personal" in value ? strings(value.personal) : [],
    newest: "newest" in value && value.newest === true,
    /** Which of `ids` are document cards, which the saved text never holds. */
    cards: "cards" in value ? strings(value.cards) : [],
  }
}

/**
 * The memory already in this conversation: recalled into a message, attached to a read result, a document card or
 * passage the memory tool showed, or a card a code-link line named.
 */
export function injected(messages: readonly SessionV1.WithParts[]) {
  const recalled = messages.flatMap((message) => message.parts.flatMap((part) => recall(part)?.ids ?? []))
  const shown = messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      const known = knowledge(part)
      return [...(known ? [...known.cards, ...known.get.map((item) => item.id)] : []), ...links(part).flatMap((item) => item.ids)]
    }),
  )
  return new Set([...recalled, ...shown, ...attachedMemory([...messages])])
}

/** Who a tool call's code-link lines are for, from what the session runtime told the tool. */
export function linking(ctx: {
  readonly sessionID: string
  readonly extra?: { readonly [key: string]: unknown }
  readonly messages: readonly SessionV1.WithParts[]
}): Asking {
  const size = ctx.extra?.taskSize
  const tier =
    size && typeof size === "object" && "tier" in size && typeof size.tier === "string" ? size.tier : undefined
  return {
    sessionID: ctx.sessionID,
    // Without the runtime's word that personal memory may go to this model, private documents stay out.
    personal: ctx.extra?.personal === true,
    ...(tier === "chat" || tier === "light" || tier === "standard" || tier === "thorough" ? { tier } : {}),
    exclude: injected(ctx.messages),
  }
}

/** Messages the working set is read from. */
const WORKING = 20

/**
 * What a request is working on, for recall to bring in what is linked to it: files the last 20 messages edited, wrote,
 * patched, attached or read, files and symbols the request names, and the working tree's changed files. At most
 * `BrainFuse.SEEDS`, strongest first; a file touched several ways counts the strongest way.
 */
export function workingSet(messages: readonly SessionV1.WithParts[], root: string, changed: readonly string[] = []) {
  const relative = (file: string) =>
    (path.isAbsolute(file) ? path.relative(root, file) : file).split(path.sep).join("/").replace(/^\.\//, "")
  const recent = messages.slice(-WORKING)
  const touched = recent.flatMap((message) =>
    message.parts.flatMap((part): BrainFuse.Seed[] => {
      if (part.type === "file" && part.url.startsWith("file:"))
        return files({ ...message, parts: [part] }).map((file) => ({ path: relative(file), weight: BrainFuse.SEED.attached }))
      if (part.type !== "tool") return []
      const input = part.state.input
      if ((part.tool === "edit" || part.tool === "write") && typeof input.filePath === "string")
        return [{ path: relative(input.filePath), weight: BrainFuse.SEED.edited }]
      if (part.tool === "read" && typeof input.filePath === "string")
        return [{ path: relative(input.filePath), weight: BrainFuse.SEED.read }]
      if (part.tool === "apply_patch" && typeof input.patchText === "string")
        return [...input.patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => ({
          path: relative(match[1]!.trim()),
          weight: BrainFuse.SEED.edited,
        }))
      return []
    }),
  )
  const asked = request(messages).flatMap((message) =>
    BrainAnchor.names({ text: typed(message) }).flatMap((name): BrainFuse.Seed[] => {
      if (name.kind === "path") return [{ path: relative(name.text), weight: BrainFuse.SEED.attached }]
      if (name.kind === "symbol" || name.kind === "env") return [{ symbol: name.text, weight: BrainFuse.SEED.symbol }]
      return []
    }),
  )
  const seeds: BrainFuse.Seed[] = [
    ...touched,
    ...asked,
    ...changed.map((file) => ({ path: relative(file), weight: BrainFuse.SEED.changed })),
  ]
  const strongest = new Map<string, BrainFuse.Seed>()
  // Newest first, so a cap keeps what the request touched last.
  for (const seed of seeds.toReversed()) {
    const key = seed.path !== undefined ? `path:${seed.path}` : `symbol:${seed.symbol}`
    if ((strongest.get(key)?.weight ?? 0) < seed.weight) strongest.set(key, seed)
  }
  return [...strongest.values()].toSorted((a, b) => b.weight - a.weight).slice(0, BrainFuse.SEEDS)
}

/** Whether the message already carries its recall, so a later step of the same request never adds another. */
export function recalled(message: SessionV1.WithParts) {
  return message.parts.some((part) => part.type === "text" && part.synthetic && part.metadata?.[RECALL] !== undefined)
}

function normal(text: string) {
  return text.toLowerCase().replace(/[\s"'`]+/g, " ").trim()
}

/** The request message this step answers: what the user sent last. */
export function request(messages: readonly SessionV1.WithParts[]) {
  return messages.filter((message) => message.info.role === "user" && asked(message)).slice(-1)
}

/** Whether the user said this, word for word, in a message of this conversation. */
export function quoted(messages: readonly SessionV1.WithParts[], quote: string) {
  const wanted = normal(quote)
  // A word or two ("yes", "thanks") could be anyone's; evidence has to say something.
  if (wanted.length < 12) return false
  return messages.some((message) => message.info.role === "user" && normal(typed(message)).includes(wanted))
}

type Run = { readonly command: string; readonly exit: number | undefined; readonly at: number }

function runs(messages: readonly SessionV1.WithParts[]): Run[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (part.type !== "tool" || part.tool !== "bash") return []
      if (part.state.status !== "completed" && part.state.status !== "error") return []
      const command = typeof part.state.input?.command === "string" ? part.state.input.command : undefined
      if (!command) return []
      const exit = part.state.status === "completed" ? part.state.metadata?.exit : 1
      return [{ command: normal(command), exit: typeof exit === "number" ? exit : undefined, at: part.state.time.start }]
    }),
  )
}

// The check a command runs, without its flags: `bun test --isolate a.test.ts` checks what `bun test a.test.ts` did.
function check(command: string) {
  return command
    .split(" ")
    .filter((word) => word && !word.startsWith("-"))
    .join(" ")
}

// The checks a lesson can be learned from: test, lint, build and typecheck runners. `test -f x` fails and then passes
// once `touch x` ran, and proves nothing.
const CHECK =
  /(?:^|[\s;&|(])(?:(?:bun|npm|pnpm|yarn|deno)\s+(?:run\s+)?(?:test|lint|build|check|typecheck|tsc|e2e|verify|spec)[\w:.-]*|(?:bunx|npx|pnpx|pnpm\s+exec|yarn\s+exec|npm\s+exec)\s+(?:tsc|vitest|jest|eslint|biome|playwright|prettier|mocha|oxlint)|tsc|tsgo|vitest|jest|pytest|mypy|pyright|ruff|eslint|biome|oxlint|rspec|phpunit|xcodebuild|mvn|gradlew?|\.\/gradlew|cargo\s+(?:test|check|build|clippy|nextest)|go\s+(?:test|build|vet)|dotnet\s+(?:test|build)|swift\s+(?:test|build)|mix\s+test|make|python3?\s+-m\s+(?:pytest|unittest|mypy))(?=\s|$)/

/**
 * Whether this command passed in the conversation after the same check failed earlier in it: the outcome a lesson
 * about it is worth remembering for. A check that only ever passed proves nothing was learned.
 */
export function checked(messages: readonly SessionV1.WithParts[], command: string) {
  const wanted = normal(command)
  if (!wanted || !CHECK.test(wanted)) return false
  const all = runs(messages)
  const passed = all.findLastIndex((run) => run.exit === 0 && (run.command === wanted || run.command.includes(wanted)))
  if (passed < 0) return false
  const target = check(all[passed]!.command)
  return all
    .slice(0, passed)
    .some((run) => run.exit !== undefined && run.exit !== 0 && check(run.command) === target)
}

/**
 * Whether a check went from failing to passing in the request that started at `since`: a test, lint, build or typecheck
 * run that passed then, where the run of the same check before it failed (in this request or an earlier one), and that
 * still passed the last time it ran. A check that only ever passed proves nothing, nor does one broken again since.
 */
export function recovered(messages: readonly SessionV1.WithParts[], since: number) {
  const all = runs(messages).filter((run) => CHECK.test(run.command))
  const targets = new Set(all.filter((run) => run.at >= since).map((run) => check(run.command)))
  return [...targets].some((target) => {
    const same = all.filter((run) => check(run.command) === target)
    if (same.at(-1)?.exit !== 0) return false
    return same.some(
      (run, index) =>
        run.at >= since && run.exit === 0 && index > 0 && same[index - 1]!.exit !== undefined && same[index - 1]!.exit !== 0,
    )
  })
}

/** Whether Vector's judge passed the work in these messages. */
export function judged(messages: readonly SessionV1.WithParts[]) {
  return messages.some((message) =>
    message.parts.some((part) => {
      if (part.type !== "tool") return false
      const judge = part.metadata?.judge
      return Boolean(judge && typeof judge === "object" && "verdict" in judge && judge.verdict === "PASS")
    }),
  )
}

// Ids of memory and document knowledge in the brain's base32: memory entries (m, 5 or 13), file entries (f, 6), records
// and passages (r, p, 12) and documents (d, 8). Exact lengths keep words such as "[demand]" from reading as one.
const ID =
  "(?:m(?:[0-9a-hjkmnp-tv-z]{13}|[0-9a-hjkmnp-tv-z]{5})|f[0-9a-hjkmnp-tv-z]{6}|[rp][0-9a-hjkmnp-tv-z]{12}|d[0-9a-hjkmnp-tv-z]{8})"
const CITATION = new RegExp(`\\[(${ID})\\]`, "g")

/**
 * Every id these messages gave the model: what recall put in a request, what memory tool calls returned or printed,
 * the outline of a kept attachment, and what code-link lines named. A citation is verified only against these.
 */
export function delivered(messages: readonly SessionV1.WithParts[]) {
  return new Set([
    ...injected(messages),
    ...messages.flatMap((message) =>
      message.parts.flatMap((part) => {
        const known = knowledge(part)
        if (part.type === "text") return part.synthetic && known?.document ? [known.document] : []
        if (part.type !== "tool" || part.tool !== "memory" || part.state.status !== "completed") return []
        return [
          ...personal(part),
          ...(typeof part.state.metadata?.id === "string" ? [part.state.metadata.id] : []),
          ...[...part.state.output.matchAll(CITATION)].flatMap((match) => (match[1] ? [match[1]] : [])),
        ]
      }),
    ),
  ])
}

/** The ids an answer cited as [id] that it was given: a made-up or mistyped id is no citation. */
export function cited(text: string, given: ReadonlySet<string>) {
  return [...new Set([...text.matchAll(CITATION)].flatMap((match) => (match[1] ? [match[1]] : [])))].filter((id) =>
    given.has(id),
  )
}

/** What the agent's answers in these messages say, Vector's own notes left out. */
export function answered(messages: readonly SessionV1.WithParts[]) {
  return messages
    .filter((message) => message.info.role === "assistant")
    .flatMap((message) => message.parts.flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : [])))
    .join("\n")
}

/** What the agent opened with the memory tool's get: an entry, record, passage or document, by id. */
export function fetched(messages: readonly SessionV1.WithParts[]) {
  return [
    ...new Set(
      messages.flatMap((message) =>
        message.parts.flatMap((part) => {
          if (part.type !== "tool" || part.tool !== "memory" || part.state.status !== "completed") return []
          if (part.state.input.action !== "get") return []
          return [
            ...(knowledge(part)?.get.map((item) => item.id) ?? []),
            ...(typeof part.state.metadata?.id === "string" ? [part.state.metadata.id] : []),
          ]
        }),
      ),
    ),
  ]
}

/** The files the agent edited, wrote or patched in these messages, as it named them. */
export function edited(messages: readonly SessionV1.WithParts[]) {
  return [
    ...new Set(
      messages.flatMap((message) =>
        message.parts.flatMap((part) => {
          if (part.type !== "tool" || part.state.status !== "completed") return []
          const input = part.state.input
          if ((part.tool === "edit" || part.tool === "write") && typeof input.filePath === "string") return [input.filePath]
          if (part.tool === "apply_patch" && typeof input.patchText === "string")
            return [...input.patchText.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)].map((match) => match[1]!.trim())
          return []
        }),
      ),
    ),
  ]
}

/**
 * Whether the agent changed this file in the conversation: edited, wrote or patched it, or named it in a shell
 * command. A file the agent changed cannot vouch for a memory, because the agent could have written the line itself.
 */
export function touched(messages: readonly SessionV1.WithParts[], file: string, root: string) {
  const relative = path.relative(root, file).split(path.sep).join("/")
  const name = path.basename(file)
  return messages.some((message) =>
    message.parts.some((part) => {
      if (part.type !== "tool") return false
      const input = part.state.input
      if (part.tool === "edit" || part.tool === "write")
        return typeof input.filePath === "string" && path.resolve(root, input.filePath) === file
      if (part.tool === "apply_patch") return typeof input.patchText === "string" && input.patchText.includes(relative)
      if (part.tool === "bash") return typeof input.command === "string" && input.command.includes(name)
      return false
    }),
  )
}

/**
 * Why memory learned in this conversation has to wait for the user: it read the web (with a web tool, a shell command
 * that is not a local one, a skill pulled from a skills URL, or a slash command whose snippets reached outside or whose
 * skill came from the web), holds
 * text from outside (an imported transcript, an issue or pull request), used the browser or Vector Cloud, ran an MCP
 * tool or an MCP server's prompt, or took a subagent's report. Memory poisoning works by planting text the agent later
 * saves as its own, so once outside content is in the history, every write is held for review.
 */
export function taint(messages: readonly SessionV1.WithParts[]): BrainSchema.Hold | undefined {
  const calls = messages.flatMap((message) => message.parts.flatMap((part) => (part.type === "tool" ? [part] : [])))
  const tools = calls.map((part) => part.tool)
  const commands = messages.flatMap((message) => message.parts.flatMap((part) => command(part)?.outside ?? []))
  if (tools.some((tool) => tool === "webfetch" || tool === "websearch" || tool === "browser" || tool === "vector_cloud"))
    return "web"
  // A local file an editor embedded is this computer's, like what the read tool returns; other outside text is not.
  if (
    messages.some((message) =>
      message.parts.some((part) => part.type === "text" && outside(part) && part.metadata?.[BrainSchema.OUTSIDE] !== "file"),
    )
  )
    return "web"
  if (calls.some((part) => part.tool === "skill" && part.state.status === "completed" && part.state.metadata?.remote === true))
    return "web"
  if (
    commands.includes("web") ||
    calls.some(
      (part) => part.tool === "bash" && typeof part.state.input.command === "string" && !local(part.state.input.command),
    )
  )
    return "web"
  if (tools.some((tool) => tool === "task" || tool === "task_manage" || tool === "send_teammate_message"))
    return "subagent"
  if (commands.includes("mcp") || tools.some((tool) => !LOCAL_TOOLS.has(tool))) return "mcp"
  return undefined
}

/**
 * Whether a file is one Vector's memory is read from: a repository's .vector/RULES.md, .vector/BRAIN.md or BRAIN.md, or
 * the user's own RULES.md and MEMORY.md. Both the name a tool was given and the file it lands on count, so a link to
 * one is one too.
 */
export function source(file: string, personal: { readonly memory: string; readonly rules: string }) {
  const own = [personal.memory, personal.rules].map((item) => FSUtil.realpath(item))
  return [file, FSUtil.realpath(file)].some(
    (item) => /(?:^|\/)(?:\.vector\/(?:rules|brain)|brain)\.md$/i.test(item.split(path.sep).join("/")) || own.includes(item),
  )
}

/** When the request message this step answers was sent: the per-message write cap counts from here. */
export function since(messages: readonly SessionV1.WithParts[]) {
  return messages.findLast((message) => message.info.role === "user" && asked(message))?.info.time.created ?? 0
}

/**
 * Whether a shell command's output comes from this computer: its files, the repository's own history, and the checks
 * and scripts it runs. Anything else (a fetch, a hosted issue or pull request, a remote's history, a package run
 * straight from a registry, code passed inline to an interpreter, or a program Vector does not know) may print someone
 * else's text, so it is an allowlist: what is not known to be local counts as outside content.
 */
export function local(command: string) {
  return simple(withoutHeredocs(command)).every(runsLocally)
}

// Text utilities, shell builtins and the repository's own build and check tools. Their output is this computer's.
const LOCAL_PROGRAMS = new Set([
  ...["ls", "cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "fd", "sed", "awk"],
  ...["gawk", "cut", "tr", "wc", "sort", "uniq", "diff", "cmp", "comm", "echo", "printf", "pwd", "cd", "pushd", "popd"],
  ...["mkdir", "rmdir", "rm", "cp", "mv", "touch", "chmod", "chown", "ln", "stat", "file", "which", "whereis", "type"],
  ...["test", "[", "[[", "]", "]]", "true", "false", ":", "export", "set", "unset", "source", ".", "tree", "jq", "yq"],
  ...["xxd", "hexdump", "od", "basename", "dirname", "realpath", "readlink", "date", "sleep", "tee", "seq", "column"],
  ...["paste", "join", "split", "tar", "gzip", "gunzip", "zip", "unzip", "shasum", "sha1sum", "sha256sum", "md5", "md5sum"],
  ...["du", "df", "ps", "kill", "pkill", "pgrep", "uname", "whoami", "id", "clear", "exit", "read", "wait", "trap", "nl"],
  ...["rev", "fold", "fmt", "iconv", "strings", "base64", "bc", "expr", "let", "local", "declare", "printenv", "patch"],
  ...["in", "return", "shift", "open", "lsof", "tsc", "tsgo", "vitest", "jest", "pytest", "mypy", "pyright", "ruff"],
  ...["eslint", "biome", "oxlint", "prettier", "rspec", "phpunit", "xcodebuild", "xcrun", "swiftc", "clang", "gcc", "cc"],
  ...["c++", "make", "cmake", "ninja", "mvn", "gradle", "gradlew", "dotnet", "swift", "mix", "turbo", "playwright", "tsx"],
  ...["ts-node", "mocha", "knip", "vite", "drizzle-kit", "stylelint", "rustc", "rustfmt", "gofmt", "black", "isort"],
])

// What `npx` and its kin may run without counting as a registry download: tools a repository installs itself.
const LOCAL_TOOLS_RUN = new Set([
  ...["tsc", "tsgo", "vitest", "jest", "eslint", "biome", "prettier", "playwright", "tsx", "turbo", "oxlint", "mocha"],
  ...["ts-node", "knip", "svelte-check", "vue-tsc", "astro", "next", "vite", "drizzle-kit", "stylelint", "c8", "nyc"],
])

const GIT_LOCAL = new Set([
  ...["status", "diff", "log", "show", "add", "commit", "branch", "checkout", "switch", "restore", "reset", "stash"],
  ...["rev-parse", "rev-list", "merge-base", "merge", "rebase", "cherry-pick", "revert", "blame", "grep", "ls-files"],
  ...["ls-tree", "cat-file", "describe", "tag", "worktree", "mv", "rm", "clean", "apply", "am", "format-patch"],
  ...["shortlog", "reflog", "notes", "bisect", "init", "config", "symbolic-ref", "for-each-ref", "show-ref", "name-rev"],
  ...["check-ignore", "check-attr", "var", "help", "version", "gc", "fsck", "count-objects", "whatchanged", "range-diff"],
  ...["sparse-checkout", "update-index", "write-tree", "read-tree", "hash-object", "cherry", "diff-tree", "diff-index"],
  ...["diff-files", "update-ref", "stage", "annotate", "prune", "repack", "--version", "--help"],
])

// Package manager commands that reach a registry and print what it sends: a package's readme or metadata, a template,
// advisories, or a package run straight from it.
const REGISTRY = new Set([
  ...["x", "dlx", "create", "init", "view", "info", "show", "v", "docs", "home", "repo", "bugs", "search", "s"],
  ...["publish", "login", "logout", "adduser", "whoami", "owner", "access", "token", "deprecate", "dist-tag", "star"],
  ...["stars", "unpublish", "team", "org", "hook", "profile", "ping", "audit", "outdated", "upgrade", "fund"],
  ...["upgrade-interactive", "self-update", "feedback", "repl"],
])

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"])
// Reserved words open or close a compound command and run nothing themselves: in `if true; then curl …; fi` and
// `{ curl …; }` the command after them is what runs.
const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "esac", "!", "{", "}"])
// A loop's or a case's header (`for url in https://…`, `case $1 in`) is a list of words, not a command.
const HEADERS = new Set(["for", "select", "case"])
// A redirection may come before the command it applies to (`> out.txt echo`, `done < urls.txt`). An operator on its own
// takes the next word as its file.
const REDIRECT = /^(?:\d*(?:>&|<&|<>|>\||>>|<<<|<<-?|>|<)|&>>?)/
const WRAPPERS = new Set(["sudo", "time", "nice", "nohup", "command", "builtin", "exec", "env", "xargs", "timeout", "stdbuf"])
const RUNTIMES = new Set(["node", "deno", "python", "python3", "ruby", "perl", "php", "lua"])
const PACKAGES = new Set(["bun", "npm", "pnpm", "yarn"])
const PYTHON_PACKAGES = new Set(["pip", "pip3", "uv", "poetry", "pipenv"])
const INLINE = new Set(["-e", "--eval", "-p", "--print", "-c", "-r", "eval"])
const URL_ARG = /^(?:[a-z][a-z0-9+.-]*:\/\/|git@|github:|gitlab:|bitbucket:|gist:)/i

function runsLocally(words: readonly string[]): boolean {
  const [first, ...rest] = words
  if (first === undefined) return true
  // `FOO=1 cmd`: the assignment, then the command.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return runsLocally(rest)
  if (KEYWORDS.has(first)) return runsLocally(rest)
  if (HEADERS.has(first)) return true
  // `function name { …`: the name, then the body.
  if (first === "function") return runsLocally(rest.slice(1))
  const redirect = REDIRECT.exec(first)?.[0]
  if (redirect !== undefined) return runsLocally(rest.slice(redirect === first ? 1 : 0))
  const name = first.split("/").pop() ?? first
  if (WRAPPERS.has(name)) return runsLocally(rest.slice(rest.findIndex((word) => !/^-|^\d+[smhd]?$|^[A-Za-z_]\w*=/.test(word)) >>> 0))
  if (SHELLS.has(name) || name === "eval") {
    const inline = name === "eval" ? 0 : rest.findIndex((word) => /^-[a-z]*c[a-z]*$/.test(word))
    if (inline < 0) return true
    return simple(rest.slice(name === "eval" ? 0 : inline + 1).join(" ")).every(runsLocally)
  }
  if (name === "find") {
    const at = rest.findIndex((word) => word === "-exec" || word === "-execdir" || word === "-ok")
    return at < 0 || runsLocally(rest.slice(at + 1))
  }
  if (name === "git") return gitLocally(rest)
  if (LOCAL_PROGRAMS.has(name)) return true
  if (rest.some((word) => URL_ARG.test(word))) return false
  if (name === "npx" || name === "bunx" || name === "pnpx")
    return LOCAL_TOOLS_RUN.has(rest.find((word) => !word.startsWith("-")) ?? "")
  if (PACKAGES.has(name)) {
    if (rest.some((word) => INLINE.has(word) && word !== "-c" && word !== "-r")) return false
    const sub = rest.find((word) => !word.startsWith("-"))
    if (sub === "exec") return LOCAL_TOOLS_RUN.has(rest.slice(rest.indexOf("exec") + 1).find((word) => !word.startsWith("-")) ?? "")
    if (sub === "pm") return !["view", "whoami"].includes(rest[rest.indexOf("pm") + 1] ?? "")
    return sub === undefined || !REGISTRY.has(sub)
  }
  if (RUNTIMES.has(name)) {
    if (rest.some((word) => INLINE.has(word))) return false
    // `python -m pip download` fetches like `pip download` does.
    const module = rest.indexOf("-m")
    return module < 0 || !(rest[module + 1] === "pip" && ["download", "index", "search"].includes(rest[module + 2] ?? ""))
  }
  if (PYTHON_PACKAGES.has(name)) return !["download", "index", "search", "publish", "upload"].includes(rest[0] ?? "")
  if (name === "go") return rest[0] !== "get" && !rest.some((word) => /^[\w.-]+\.[a-z]{2,}\/\S*@/.test(word))
  if (name === "cargo") return !["search", "install", "info", "publish", "login"].includes(rest[0] ?? "")
  // A script or binary named by its path is the repository's own, unless it is one of the known fetchers.
  return first.includes("/") && !/^(?:curl|wget|gh|glab|ssh|scp|sftp|ftp|rsync|nc|telnet|http|https|xh|aria2c)$/.test(name)
}

function gitLocally(words: readonly string[]): boolean {
  const [first, ...rest] = words
  if (first === undefined) return true
  // A configuration override can turn any command into a fetch or a shell (`-c alias.x='!curl …'`).
  if (first === "-c" || first.startsWith("--config-env")) return false
  if (["-C", "--git-dir", "--work-tree", "--namespace"].includes(first)) return gitLocally(rest.slice(1))
  if (first.startsWith("-")) return gitLocally(rest)
  if (first === "remote") return ["-v", "--verbose", "get-url", "add", "remove", "rm", "rename", "set-url", undefined].includes(rest[0])
  if (first === "submodule") return rest[0] === "status"
  return GIT_LOCAL.has(first)
}

// A heredoc's body is data for the command that reads it, not commands of its own.
function withoutHeredocs(command: string) {
  return command.split("\n").reduce<{ lines: string[]; until?: string }>(
    (state, line) => {
      if (state.until !== undefined) return line.trim() === state.until ? { lines: state.lines } : state
      const heredoc = /<<-?\s*["']?([A-Za-z_][\w-]*)["']?/.exec(line)?.[1]
      return { lines: [...state.lines, line], ...(heredoc ? { until: heredoc } : {}) }
    },
    { lines: [] },
  ).lines.join("\n")
}

/**
 * The simple commands of a command line, each as its words: split at `;`, `&`, `|` and newlines outside quotes, with
 * `$(…)` and backticks as commands of their own (they run inside double quotes too), and comments dropped.
 */
function simple(line: string) {
  const out: string[][] = []
  // The quoting each open `$(` or backtick interrupted, restored when it closes.
  const open: { readonly quote: string | undefined; readonly tick: boolean }[] = []
  let words: string[] = []
  let word = ""
  let quote: string | undefined
  const end = () => {
    if (word) words.push(word)
    word = ""
  }
  const cut = () => {
    end()
    if (words.length) out.push(words)
    words = []
  }
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!
    const next = line[index + 1]
    if (quote === "'") {
      if (char === "'") quote = undefined
      else word += char
      continue
    }
    if (char === "\\") {
      if (next !== "\n") word += next ?? ""
      index++
      continue
    }
    if (char === "$" && next === "(") {
      cut()
      open.push({ quote, tick: false })
      quote = undefined
      index++
      continue
    }
    if (char === "`") {
      cut()
      if (open.at(-1)?.tick) quote = open.pop()!.quote
      else {
        open.push({ quote, tick: true })
        quote = undefined
      }
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = undefined
      else word += char
      continue
    }
    if (char === ")" && open.length && !open.at(-1)!.tick) {
      cut()
      quote = open.pop()!.quote
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === "#" && word === "") {
      const stop = line.indexOf("\n", index)
      index = stop < 0 ? line.length : stop - 1
      continue
    }
    // `2>&1` and `&>` are redirections; `&&`, `&` and `|` end a command.
    if (char === "&" && (word.endsWith(">") || word.endsWith("<") || next === ">")) {
      word += char
      continue
    }
    if (char === ";" || char === "&" || char === "|" || char === "\n" || char === "(" || char === ")") {
      cut()
      continue
    }
    if (char === " " || char === "\t") {
      end()
      continue
    }
    word += char
  }
  cut()
  return out
}
