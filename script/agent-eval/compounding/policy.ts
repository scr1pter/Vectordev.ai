// The scripted model. It is a pure function of the request it is answering: what it decides next depends only on what
// that request carries (the system prompt, the user's message, the memory Vector added, the tool results so far). It
// works the way a careful but forgetful model does: it reads the files a task names, makes the change, runs the tests
// and the check, recovers from the errors it sees, and saves what it learned when Vector offers memory. Where a task
// needs a fact, it gets it right only if the fact's marker is somewhere in the request; otherwise it makes the mistake
// a model without that fact makes. It never reads the disk, the brain or anything outside the request.

import { join } from "node:path"
import type { Call } from "./model-server"
import { fact, type FactID, type Files, type Task } from "./tasks"

/** A request as the scripted model reads it. */
export type Seen = {
  /** Everything the model was given, in order, without its own tool calls: one entry per point it decided at. */
  readonly before: readonly string[]
  /** What Vector's memory added at each point: recall, digest, file notes, document pointers, memory tool results. */
  readonly brain: readonly string[]
  /** The calls the model already made in this request's conversation, with their results. */
  readonly calls: readonly { readonly call: Call; readonly result: string }[]
  readonly tools: readonly string[]
}

export type Options = {
  /** The repository's directory, for the absolute paths the file tools take. */
  readonly dir: string
  /**
   * The mutation control: everything Vector's memory added is deleted from the request before the model reads it, so
   * the brain still works and still costs tokens, but the model cannot see what it brought.
   */
  readonly blind?: boolean
  /** Text of each PDF the request attaches, by its base64 data, extracted before the model reads the request. */
  readonly documents?: ReadonlyMap<string, string>
}

// What Vector's memory puts in a request, wherever it sits. The blind control deletes exactly these.
const BRAIN_SPANS = [
  /<vector_memory_recall>[\s\S]*?<\/vector_memory_recall>/g,
  /<vector_memory>[\s\S]*?<\/vector_memory>/g,
  /Vector's memory for [^\n]*:\n(?:- [^\n]*(?:\n|$))*/g,
  /^Documents linked to [^\n]*$/gm,
  /^Linked requirements: [^\n]*$/gm,
  /<document_passage[\s\S]*?<\/document_passage>/g,
]

/** What the brain added to a text, span by span. */
export function brainSpans(text: string) {
  return BRAIN_SPANS.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[0]))
}

function withoutBrain(text: string) {
  return BRAIN_SPANS.reduce((rest, pattern) => rest.replace(pattern, ""), text)
}

/** Reads a Messages request the way the scripted model sees it. */
export function perceive(body: Record<string, unknown>, options: Pick<Options, "blind" | "documents"> = {}): Seen {
  const system = Array.isArray(body.system)
    ? body.system.map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : "")).join("\n")
    : typeof body.system === "string"
      ? body.system
      : ""
  const messages = Array.isArray(body.messages) ? (body.messages as { role: string; content: unknown }[]) : []
  const tools = Array.isArray(body.tools) ? body.tools.map((tool) => String((tool as { name?: unknown }).name ?? "")) : []
  const names = new Map<string, string>()
  const results = new Map<string, string>()
  const uses: { id: string; call: Call }[] = []
  // The text before each of the model's own turns, and what the brain put in it.
  const before: string[] = []
  const brain: string[] = []
  const seen: string[] = [system]
  const memory: string[] = []
  for (const message of messages) {
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : []
    if (message.role === "assistant") {
      const text = seen.join("\n")
      before.push(options.blind ? withoutBrain(text) : text)
      brain.push(options.blind ? "" : [...brainSpans(text), ...memory].join("\n"))
      for (const block of blocks as Record<string, unknown>[]) {
        if (block.type === "tool_use") {
          names.set(String(block.id), String(block.name))
          uses.push({ id: String(block.id), call: { name: String(block.name), input: (block.input ?? {}) as Record<string, unknown> } })
        }
      }
      continue
    }
    for (const block of blocks as Record<string, unknown>[]) {
      if (block.type === "tool_result") {
        const text = flatten(block.content, options.documents)
        results.set(String(block.tool_use_id), text)
        // A memory tool result is the brain answering; the blind control deletes it too.
        if (names.get(String(block.tool_use_id)) === "memory") {
          memory.push(text)
          if (options.blind) continue
        }
        seen.push(text)
        continue
      }
      seen.push(flatten(block, options.documents))
    }
  }
  const text = seen.join("\n")
  before.push(options.blind ? withoutBrain(text) : text)
  brain.push(options.blind ? "" : [...brainSpans(text), ...memory].join("\n"))
  return {
    before,
    brain,
    calls: uses.map((use) => ({ call: use.call, result: results.get(use.id) ?? "" })),
    tools,
  }
}

function flatten(value: unknown, documents?: ReadonlyMap<string, string>): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map((item) => flatten(item, documents)).join("\n")
  if (!value || typeof value !== "object") return ""
  const block = value as Record<string, unknown>
  if (block.type === "document" || block.type === "image") {
    const source = block.source as { data?: unknown } | undefined
    return typeof source?.data === "string" ? (documents?.get(source.data) ?? "") : ""
  }
  if ("text" in block) return flatten(block.text, documents)
  if ("content" in block) return flatten(block.content, documents)
  return ""
}

/** Base64 PDFs a request attaches, for the server to read before the model decides. */
export function attachments(body: Record<string, unknown>) {
  const found = new Set<string>()
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk)
    if (!value || typeof value !== "object") return
    const block = value as Record<string, unknown>
    const source = block.source as { data?: unknown; media_type?: unknown } | undefined
    if (block.type === "document" && typeof source?.data === "string") found.add(source.data)
    Object.values(block).forEach(walk)
  }
  walk(body.messages)
  return [...found]
}

/** The scripted model's next call for a request. */
export function decide(task: Task, start: Files, body: Record<string, unknown>, options: Options): Call {
  const seen = perceive(body, options)
  const view = { at: 0 }
  const steps = work(task, start, seen, view, options.dir)
  for (const call of steps) {
    if (view.at === seen.calls.length) return call
    const made = seen.calls[view.at]!.call
    if (JSON.stringify(made) !== JSON.stringify(call))
      throw new Error(`The conversation left the script at call ${view.at + 1}: made ${JSON.stringify(made)}, script says ${JSON.stringify(call)}`)
    view.at += 1
  }
  return { text: "Done." }
}

/** Whether a request shows the model a fact, at a point in its conversation. */
export function knows(seen: Seen, at: number, id: FactID) {
  return fact(id).marker.test(seen.before[at] ?? "")
}

// The work for one task, as calls. `view.at` is how many calls the conversation already holds when the generator
// resumes, so every decision reads the request as it stood when the model made it.
function* work(task: Task, start: Files, seen: Seen, view: { at: number }, dir: string): Generator<Call, void, void> {
  const knowsNow = (id: FactID) => knows(seen, view.at, id)
  const last = () => seen.calls[view.at - 1]?.result ?? ""
  const read: string[] = []
  const fetched = new Set<string>()
  const discovered: { fact: FactID }[] = []
  const pm = () => (knowsNow("pnpm") ? "pnpm" : "npm")

  // Opens what a document pointer or a spec guard names, when the task still lacks a fact it needs.
  function* follow(): Generator<Call, void, void> {
    const ids = [...last().matchAll(/^(?:Documents linked to [^\n]*|Linked requirements: [^\n]*)$/gm)]
      .flatMap((line) => [...line[0].matchAll(/\[(r[0-9a-z]{4,})\]/g)].map((match) => match[1]!))
      .filter((id) => !fetched.has(id))
    if (ids.length === 0 || task.needs.every((id) => knowsNow(id))) return
    for (const id of ids.slice(0, 2)) {
      fetched.add(id)
      yield { name: "memory", input: { action: "get", id } }
    }
  }

  for (const path of task.reads) {
    read.push(path)
    yield { name: "read", input: { filePath: join(dir, path) } }
    yield* follow()
  }
  // Commands run before the changes, which a lesson's evidence may come from too.
  const investigated: { command: string; failed: boolean }[] = []
  for (const step of task.investigate ?? []) {
    if (step.read) {
      read.push(step.read)
      yield { name: "read", input: { filePath: join(dir, step.read) } }
      continue
    }
    yield { name: "bash", input: { command: step.command!, description: "Run the check the user named" } }
    investigated.push({ command: step.command!, failed: failed(last()) })
  }
  if (task.dependency) {
    const command = pm() === "pnpm" ? `pnpm add ${task.dependency}` : `npm install ${task.dependency}`
    yield { name: "bash", input: { command, description: `Add ${task.dependency}` } }
  }
  // Each change is decided when it is made, from what the request shows at that point.
  const changes = task.changes(start, knowsNow)
  for (const change of changes) {
    yield "content" in change
      ? { name: "write", input: { filePath: join(dir, change.path), content: change.content } }
      : { name: "edit", input: { filePath: join(dir, change.path), oldString: change.from, newString: change.to } }
    yield* follow()
  }
  // A guard or pointer that brought a missing fact in time is acted on: the changes are made again as now known.
  const again = task.changes(start, knowsNow)
  for (const [index, change] of again.entries()) {
    const before = changes[index]!
    if (JSON.stringify(before) === JSON.stringify(change)) continue
    yield "content" in change
      ? { name: "write", input: { filePath: join(dir, change.path), content: change.content } }
      : { name: "edit", input: { filePath: join(dir, change.path), oldString: (before as { to: string }).to, newString: change.to } }
  }

  // A model that knows the route table is generated regenerates it before the check can trip on it.
  if (changes.some((change) => change.path === "src/routes.ts") && knowsNow("routes"))
    yield { name: "bash", input: { command: "pnpm gen", description: "Regenerate the route table" } }

  // Every bash command run here and whether it failed: a check that failed and then passed is a lesson's evidence.
  const ran = [...investigated]
  const shell = (command: string, description: string): Call => ({ name: "bash", input: { command, description } })
  const checks = [
    () => `${pm()} test`,
    () => `${pm()} run check`,
    ...(task.verify ?? []).map((command) => () => command),
    // The flaky-test lesson says CI runs the suite on a slow clock; a model that knows it runs that too.
    ...(task.needs.includes("clock") && !task.verify ? [() => (knowsNow("clock") ? "pnpm run test:ci" : undefined)] : []),
  ]
  for (const next of checks) {
    const first = next()
    if (!first) continue
    yield shell(first, "Verify the change")
    ran.push({ command: first, failed: failed(last()) })
    for (const _ of [1, 2, 3]) {
      const fix = failed(last()) ? recovery(last()) : undefined
      if (!fix) break
      if (fix.fact === "pnpm" && !read.includes("CONTRIBUTING.md")) {
        read.push("CONTRIBUTING.md")
        yield { name: "read", input: { filePath: join(dir, "CONTRIBUTING.md") } }
      }
      for (const command of fix.commands) yield shell(command, fix.fact === "pnpm" ? "Install with pnpm" : "Regenerate the route table")
      discovered.push({ fact: fix.fact })
      const rerun = next() ?? first
      yield shell(rerun, "Verify the change again")
      ran.push({ command: rerun, failed: failed(last()) })
    }
  }
  const script = (command: string) => command.replace(/^(?:npm|pnpm)(?: run)? /, "")
  const recovered = ran.findLast((item, at) => !item.failed && ran.slice(0, at).some((other) => other.failed && script(other.command) === script(item.command)))

  // The fixes for the errors the check prints, by what the error says.
  function recovery(output: string): { fact: FactID; commands: string[] } | undefined {
    if (/package-lock\.json found/.test(output))
      return { fact: "pnpm", commands: ["rm package-lock.json", task.dependency ? `pnpm add ${task.dependency}` : "pnpm install"] }
    if (/routes\.gen\.ts is stale/.test(output)) return { fact: "routes", commands: ["pnpm gen"] }
    return undefined
  }

  // What the task taught, saved when Vector offers memory and memory did not already bring it.
  const learned = [
    ...task.teaches,
    ...discovered.filter((item, at) => !task.teaches.some((taught) => taught.fact === item.fact) && discovered.findIndex((other) => other.fact === item.fact) === at),
  ].map((item) => ({ fact: item.fact, quote: "quote" in item ? item.quote : undefined, command: recovered?.command }))
  if (seen.tools.includes("memory")) {
    for (const item of learned) {
      const memory = fact(item.fact).memory
      // Memory that already holds it brought it into this request; saving it again would add nothing.
      if (!memory || (seen.brain[0] ?? "").includes(memory.text.slice(0, 48))) continue
      yield {
        name: "memory",
        input: {
          action: "add",
          kind: memory.kind,
          text: memory.text,
          ...(item.quote ? { quote: item.quote } : item.command ? { command: item.command } : {}),
        },
      }
    }
  }

  // The answer cites the memory lines and cards it relied on, as Vector asks.
  const used = task.needs.filter((id) => knowsNow(id))
  const cited = [...new Set((seen.brain[view.at] ?? "").split("\n").flatMap((line) => {
    const id = /\[([mr][0-9a-z]{4,})\]/.exec(line)?.[1]
    return id && used.some((need) => fact(need).marker.test(line)) ? [id] : []
  }))]
  yield { text: `Done: ${task.title.charAt(0).toLowerCase()}${task.title.slice(1)}.${cited.length ? ` Relied on ${cited.map((id) => `[${id}]`).join(", ")}.` : ""}` }
}

function failed(output: string) {
  return /Command exited with code [1-9]/.test(output)
}
