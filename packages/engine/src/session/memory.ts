export * as SessionMemory from "./memory"

import { fileURLToPath } from "url"
import { SessionV1 } from "@vectordevai/core/v1/session"
import type { BrainSchema } from "@vectordevai/core/brain/schema"
import { attachedMemory } from "./instruction"

// What the session runtime and the memory tool read from a conversation to use and to grow Vector's memory: the user's
// own words (evidence for what they said), the checks that went from failing to passing (evidence for a lesson), the
// memory already in the conversation (never sent twice), and whether outside content came in (memory waits for the
// user then). All of it is read from the history, so it holds across restarts and is the same in every engine.

/** Metadata key of the synthetic part that carries a request message's recalled memory. */
export const RECALL = "vector.memory.recall"

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

/** What the user typed in a message, without Vector's synthetic notes or attached file contents. */
export function typed(message: SessionV1.WithParts) {
  return message.parts
    .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
    .join("\n")
    .trim()
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

/** The memory already in this conversation: recalled into a message, or attached to a read result. */
export function injected(messages: readonly SessionV1.WithParts[]) {
  const recalled = messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (part.type !== "text" || !part.synthetic) return []
      const value = part.metadata?.[RECALL]
      if (!value || typeof value !== "object" || !("ids" in value) || !Array.isArray(value.ids)) return []
      return value.ids.filter((id: unknown): id is string => typeof id === "string")
    }),
  )
  return new Set([...recalled, ...attachedMemory([...messages])])
}

/** Whether the message already carries its recall, so a later step of the same request never adds another. */
export function recalled(message: SessionV1.WithParts) {
  return message.parts.some((part) => part.type === "text" && part.synthetic && part.metadata?.[RECALL] !== undefined)
}

function normal(text: string) {
  return text.toLowerCase().replace(/[\s"'`]+/g, " ").trim()
}

/** Whether the user said this, word for word, in a message of this conversation. */
export function quoted(messages: readonly SessionV1.WithParts[], quote: string) {
  const wanted = normal(quote)
  // A word or two ("yes", "thanks") could be anyone's; evidence has to say something.
  if (wanted.length < 12) return false
  return messages.some((message) => message.info.role === "user" && normal(typed(message)).includes(wanted))
}

type Run = { readonly command: string; readonly exit: number | undefined }

function runs(messages: readonly SessionV1.WithParts[]): Run[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (part.type !== "tool" || part.tool !== "bash") return []
      if (part.state.status !== "completed" && part.state.status !== "error") return []
      const command = typeof part.state.input?.command === "string" ? part.state.input.command : undefined
      if (!command) return []
      const exit = part.state.status === "completed" ? part.state.metadata?.exit : 1
      return [{ command: normal(command), exit: typeof exit === "number" ? exit : undefined }]
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

/**
 * Whether this command passed in the conversation after the same check failed earlier in it: the outcome a lesson
 * about it is worth remembering for. A check that only ever passed proves nothing was learned.
 */
export function checked(messages: readonly SessionV1.WithParts[], command: string) {
  const wanted = normal(command)
  if (!wanted) return false
  const all = runs(messages)
  const passed = all.findLastIndex((run) => run.exit === 0 && (run.command === wanted || run.command.includes(wanted)))
  if (passed < 0) return false
  const target = check(all[passed]!.command)
  return all
    .slice(0, passed)
    .some((run) => run.exit !== undefined && run.exit !== 0 && check(run.command) === target)
}

/**
 * Why memory learned in this conversation has to wait for the user: it read the web, used the browser or Vector
 * Cloud, ran an MCP tool, or took a subagent's report. Memory poisoning works by planting text the agent later saves as
 * its own, so once outside content is in the history, every write is held for review.
 */
export function taint(messages: readonly SessionV1.WithParts[]): BrainSchema.Hold | undefined {
  const tools = messages.flatMap((message) => message.parts.flatMap((part) => (part.type === "tool" ? [part.tool] : [])))
  if (tools.some((tool) => tool === "webfetch" || tool === "websearch" || tool === "browser" || tool === "vector_cloud"))
    return "web"
  if (tools.some((tool) => tool === "task" || tool === "task_manage" || tool === "send_teammate_message"))
    return "subagent"
  if (tools.some((tool) => !LOCAL_TOOLS.has(tool))) return "mcp"
  return undefined
}

/** When the request message this step answers was sent: the per-message write cap counts from here. */
export function since(messages: readonly SessionV1.WithParts[]) {
  return messages.findLast((message) => message.info.role === "user" && typed(message))?.info.time.created ?? 0
}
