import { realpathSync } from "node:fs"
import { isAbsolute, normalize, relative, sep } from "node:path"
import { ExternalAgent } from "@vectordevai/schema/external-agent"
import type { AgentChat } from "./parallel-workspace-turns"

/*
 * How a chat agent's headless output becomes Vector's chat: its messages and activity, its session id, the end of its
 * turn, the error it reported and what it cost. Each event family has one reader, chosen by the catalog's parser id:
 *
 * - claude, cursor: Claude Code's stream-json, and Cursor Agent's close copy of it.
 * - codex: `codex exec --json`, thread, turn and item events.
 * - qwen, amp: Claude Code's stream-json again, from Qwen Code (docs/users/features/headless.md) and Amp
 *   (ampcode.com/docs/cli/streaming-json), with differences per field noted on their reader.
 * - gemini: Gemini CLI's stream-json (docs/cli/headless.md): init, message, tool_use, tool_result, error, result.
 * - pi: pi's JSON event stream (packages/coding-agent/docs/json.md): a session header, then agent, turn, message and
 *   tool execution events.
 *
 * Every reader is an allowlist and never throws: a line that is not JSON, an event it does not know and a field of the
 * wrong type are skipped. Raw output, tool arguments, tool results and reasoning stay diagnostics. Only explicit
 * assistant text becomes chat, and the one argument that crosses is the path an edit or write call names, relative to
 * the workspace, so the renderer can follow the file being changed.
 */

export type AgentTurnFinish = "success" | "failure"

export function parseAgentJson(line: string) {
  const body = line.replace(/^\[(?:stdout|stderr)\]\s+/, "")
  if (!body.startsWith("{")) return undefined
  try {
    const value = JSON.parse(body)
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

export function textAt(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object") return undefined
  return keys
    .map((key) => (value as Record<string, unknown>)[key])
    .find((item): item is string => typeof item === "string" && item.trim().length > 0)
}

function jsonObject(value: unknown) {
  if (typeof value !== "string") return object(value)
  try {
    return object(JSON.parse(value))
  } catch {
    return {}
  }
}

function blocks(value: unknown) {
  return Array.isArray(value) ? value.map(object) : []
}

function joinedText(content: Record<string, unknown>[]) {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
}

const SECRET_VALUE_PATTERN =
  /((?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret)\s*["'=:\s]+\s*)([^\s"',}]+)/gi
const BEARER_PATTERN = /(bearer\s+)[a-z0-9._~+/=-]+/gi

export function redactAgentOutput(value: string) {
  return value.replace(SECRET_VALUE_PATTERN, "$1[redacted]").replace(BEARER_PATTERN, "$1[redacted]")
}

// The family of an agent's event stream. A reader follows the catalog's parser id, not the agent's tier, so a reader
// stays tested while its agent runs in the terminal (Amp); the runner refuses anything that is not chat first.
function parserOf(runtime: ExternalAgent.Id) {
  const parser = ExternalAgent.find(runtime)?.headless?.parser
  if (!parser) throw new Error(`"${String(runtime).slice(0, 40)}" has no event stream Vector can read.`)
  return parser
}

const CODEX_TURN_ACTIVITY = "codex-turn"
const MAX_ACTIVITY_FILES = 20
const CLAUDE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])

// A path an edit tool named, relative to the workspace with "/" separators.
// Undefined for anything that is not a string or would leave the workspace, so
// no path outside it ever reaches the renderer.
function workspaceFile(raw: unknown, roots: string[]) {
  if (typeof raw !== "string") return undefined
  const value = raw.trim()
  if (!value || value.length > 4_096 || value.includes("\0")) return undefined
  const candidates = isAbsolute(value) ? roots.map((root) => relative(root, value)) : [normalize(value)]
  for (const candidate of candidates) {
    if (isAbsolute(candidate)) continue
    const parts = candidate.split(sep).filter(Boolean)
    if (!parts.length || parts[0] === ".." || parts.every((part) => part === ".")) continue
    return parts.join("/")
  }
  return undefined
}

// The CLI may report paths under the canonical spelling of its cwd (macOS's
// /var is /private/var), so both spellings count as the workspace.
export function workspaceRoots(cwd: string) {
  try {
    const real = realpathSync.native(cwd)
    return real === cwd ? [cwd] : [cwd, real]
  } catch {
    return [cwd]
  }
}

function claudeEditedPaths(block: Record<string, unknown>) {
  if (!CLAUDE_EDIT_TOOLS.has(String(block.name))) return []
  const input = object(block.input)
  return [input.file_path, input.notebook_path]
}

// Cursor keys a call by its tool, e.g. {"editToolCall": {"args": {"path"}}} or
// {"writeToolCall": ...}. A generic call is {"function": {"name", "arguments"}}
// with JSON-encoded arguments. Only edit and write calls name a changed file.
function cursorEditedPaths(call: Record<string, unknown>) {
  return Object.entries(call).flatMap(([key, value]) => {
    const body = object(value)
    const generic = key === "function"
    if (!/edit|write/i.test(generic ? String(body.name ?? "") : key)) return []
    const args = generic ? jsonObject(body.arguments) : object(body.args)
    return ["path", "file_path", "filePath", "target_file", "targetFile"].map((name) => args[name])
  })
}

// The file an edit or write call names, for the agents whose file tools take a path argument: Qwen Code's edit and
// write_file (file_path), Amp's edit_file and create_file (path), Gemini CLI's replace and write_file (file_path), and
// pi's edit and write (path).
function editedFiles(name: string, input: Record<string, unknown>) {
  if (!/edit|write|replace|create_file/i.test(name)) return []
  return [input.file_path, input.path, input.filePath, input.notebook_path]
}

type Transcript = ReturnType<typeof transcript>

// The chat one run builds up: assistant messages by id, and one activity entry per tool call or thinking phase.
function transcript(roots: string[]) {
  const messages: AgentChat["messages"] = []
  const activity: AgentChat["activity"] = []
  const message = (id: string, text: string, append = false) => {
    if (!text) return
    const previous = messages.find((entry) => entry.id === id)
    const value = redactAgentOutput((append ? (previous?.text ?? "") : "") + text).slice(-200_000)
    if (previous) previous.text = value
    if (!previous) messages.push({ id, text: value })
    if (messages.length > 120) messages.shift()
  }
  const tool = (id: string, name: string, state: AgentChat["activity"][number]["state"], files: unknown[] = []) => {
    const kind = name === "reasoning" || name === "thinking" ? "thinking" : "tool"
    const label =
      kind === "thinking"
        ? "Thinking"
        : /read|search|grep|glob|list_directory|^ls$|^find$/i.test(name)
          ? "Reading repository"
          : /edit|write|patch|file_change|replace|create_file/i.test(name)
            ? "Updating files"
            : /shell|bash|command|exec/i.test(name)
              ? "Running a command"
              : "Using a tool"
    const index = activity.findIndex((item) => item.id === id)
    // A later event for the same call (codex item.completed, cursor "completed")
    // keeps the paths an earlier one named. New arrays only: snapshots share them.
    const known = [
      ...new Set([
        ...(activity[index]?.files ?? []),
        ...files.map((file) => workspaceFile(file, roots)).filter((file): file is string => Boolean(file)),
      ]),
    ].slice(0, MAX_ACTIVITY_FILES)
    const entry = { id, label, kind, state, ...(known.length ? { files: known } : {}) } as AgentChat["activity"][number]
    if (index < 0) activity.push(entry)
    if (index >= 0) activity[index] = entry
    if (activity.length > 60) activity.shift()
  }
  const settle = (id: string | undefined, state: AgentChat["activity"][number]["state"]) => {
    const entry = activity.find((item) => item.id === id)
    if (entry) entry.state = state
  }
  return { messages, activity, message, tool, settle }
}

export function createAgentChat(runtime: ExternalAgent.Id, roots: string[] = []) {
  const chat = transcript(roots)
  const read = reader(parserOf(runtime), chat)
  return (line: string): AgentChat => {
    read(parseAgentJson(line) ?? {})
    return {
      messages: chat.messages.map((entry) => ({ ...entry })),
      activity: chat.activity.map((entry) => ({ ...entry })),
    }
  }
}

function reader(parser: ExternalAgent.Parser, chat: Transcript) {
  if (parser === "codex") return codexReader(chat)
  if (parser === "claude" || parser === "cursor") return claudeReader(chat, parser)
  if (parser === "qwen" || parser === "amp") return claudeShapedReader(chat)
  if (parser === "gemini") return geminiReader(chat)
  if (parser === "pi") return piReader(chat)
  // Families without a reader belong to terminal agents, which never run headless.
  return () => undefined
}

function codexReader(chat: Transcript) {
  return (event: Record<string, unknown>) => {
    const item = object(event.item)
    // codex exec --json sends no text deltas: its first complete item came
    // 6.6 s in (codex-cli 0.154), while thread.started and turn.started land at
    // about 3 s and are the earliest real sign that the model is working.
    const turn = chat.activity.find((entry) => entry.id === CODEX_TURN_ACTIVITY)
    if (event.type === "thread.started" || event.type === "turn.started") {
      chat.tool(CODEX_TURN_ACTIVITY, "thinking", "running")
    } else if (turn && event.type === "turn.failed") {
      turn.state = "failed"
    } else if (
      turn?.state === "running" &&
      (String(event.type).startsWith("item.") || event.type === "turn.completed")
    ) {
      turn.state = "done"
    }
    if (!["item.started", "item.updated", "item.completed"].includes(String(event.type))) return
    const id = textAt(item, ["id"]) ?? "assistant-0"
    if (item.type === "agent_message") chat.message(id, textAt(item, ["text"]) ?? "")
    if (["command_execution", "file_change", "mcp_tool_call", "web_search", "reasoning"].includes(String(item.type))) {
      chat.tool(
        id,
        String(item.type),
        item.status === "failed" ? "failed" : event.type === "item.completed" ? "done" : "running",
        // Codex's file_change item lists every path its patch touches.
        item.type === "file_change" && Array.isArray(item.changes)
          ? item.changes.map((change) => object(change).path)
          : [],
      )
    }
  }
}

function claudeReader(chat: Transcript, parser: "claude" | "cursor") {
  let current = "assistant-0"
  // Cursor thinks in phases: a burst of deltas, then one "completed". One entry
  // per phase keeps a burst from pushing real tool calls out of the 60-entry cap.
  let thinkingRound = 0
  const streamedMessages = new Set<string>()
  const assistantBlocks = new Set<string>()
  return (event: Record<string, unknown>) => {
    const stream = object(event.event)
    if (event.type === "stream_event" && stream.type === "message_start")
      current = textAt(object(stream.message), ["id"]) ?? `assistant-${chat.messages.length}`
    if (event.type === "stream_event" && stream.type === "content_block_delta") {
      const delta = object(stream.delta)
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        streamedMessages.add(current)
        chat.message(current, delta.text, true)
      }
    }
    if (event.type === "stream_event" && stream.type === "content_block_start") {
      const block = object(stream.content_block)
      if (block.type === "text" && typeof block.text === "string" && block.text) {
        streamedMessages.add(current)
        chat.message(current, block.text, true)
      }
      // Tool execution starts with the complete assistant tool_use below;
      // content-block stop only means its arguments finished streaming.
      if (block.type === "thinking")
        chat.tool(`${current}-${stream.index}`, String(block.name ?? block.type), "running")
    }
    if (event.type === "stream_event" && stream.type === "content_block_stop")
      chat.settle(`${current}-${stream.index}`, "done")
    if (event.type === "assistant") {
      const body = object(event.message)
      const id = textAt(body, ["id"]) ?? current
      const content = blocks(body.content)
      const text = joinedText(content)
      // Claude emits one assistant envelope per completed content block,
      // sharing message.id. Its partial events already accumulated that block.
      const blockID = textAt(event, ["uuid"])
      if (parser !== "claude" || !streamedMessages.has(id)) {
        if (!blockID || !assistantBlocks.has(blockID)) chat.message(id, text, parser === "cursor" || Boolean(blockID))
      }
      if (blockID) assistantBlocks.add(blockID)
      content
        .filter((block) => block.type === "tool_use")
        .forEach((block) =>
          chat.tool(textAt(block, ["id"]) ?? `${id}-tool`, String(block.name), "running", claudeEditedPaths(block)),
        )
      current = id
    }
    // Cursor's top-level thinking events. The reasoning text never becomes
    // chat; only the fact that a phase is open does.
    if (event.type === "thinking") {
      chat.tool(`${current}-thinking-${thinkingRound}`, "thinking", event.subtype === "completed" ? "done" : "running")
      if (event.subtype === "completed") thinkingRound += 1
    }
    if (event.type === "tool_call") {
      const call = object(event.tool_call)
      chat.tool(
        textAt(event, ["call_id", "id"]) ?? "tool",
        Object.keys(call)[0] ?? "tool",
        event.subtype === "completed" ? "done" : "running",
        cursorEditedPaths(call),
      )
    }
    if (event.type === "user") settleToolResults(chat, event)
    if (event.type === "result" && event.is_error !== true && typeof event.result === "string") {
      // Result repeats the final assistant response, not a new message.
      if (parser === "cursor" || !chat.messages.length) chat.message(chat.messages.at(-1)?.id ?? current, event.result)
    }
  }
}

function settleToolResults(chat: Transcript, event: Record<string, unknown>) {
  blocks(object(event.message).content)
    .filter((block) => block.type === "tool_result")
    .forEach((block) => chat.settle(textAt(block, ["tool_use_id"]), block.is_error === true ? "failed" : "done"))
}

// Qwen Code and Amp print Claude Code's envelopes, but neither keys text the way Claude does. Qwen sends one
// message_start per model turn and then splits the turn into one assistant envelope per block type, each under a new
// id; Amp's envelopes carry no id at all and come without partial events. So text is kept by its place in the run:
// deltas stream into the open text slot, and the next assistant envelope that carries text replaces that slot with
// its complete text and closes it. A failed result carries its reason on `error` (Qwen: {message}, Amp: a string).
function claudeShapedReader(chat: Transcript) {
  let slot = 0
  return (event: Record<string, unknown>) => {
    if (event.type === "stream_event") {
      const stream = object(event.event)
      const delta = object(stream.delta)
      if (stream.type !== "content_block_delta") return
      if (delta.type === "thinking_delta") chat.tool(`thinking-${slot}`, "thinking", "running")
      if (delta.type !== "text_delta" || typeof delta.text !== "string") return
      chat.settle(`thinking-${slot}`, "done")
      chat.message(`text-${slot}`, delta.text, true)
      return
    }
    if (event.type === "assistant") {
      const content = blocks(object(event.message).content)
      if (content.some((block) => block.type === "thinking" || block.type === "redacted_thinking"))
        chat.tool(`thinking-${slot}`, "thinking", "done")
      const text = joinedText(content)
      if (text) {
        chat.settle(`thinking-${slot}`, "done")
        chat.message(`text-${slot}`, text)
        slot += 1
      }
      // A call without its id could never be settled, so it is not shown.
      content.forEach((block) => {
        const id = textAt(block, ["id"])
        if (block.type !== "tool_use" || !id) return
        const name = textAt(block, ["name"]) ?? "tool"
        chat.tool(id, name, "running", editedFiles(name, object(block.input)))
      })
      return
    }
    if (event.type === "user") settleToolResults(chat, event)
    // A run that printed only its result still shows the answer.
    if (event.type === "result" && event.is_error !== true && typeof event.result === "string" && !chat.messages.length)
      chat.message(`text-${slot}`, event.result)
  }
}

// Gemini CLI streams assistant text as `message` events with delta: true, one message per stretch of text between
// tool calls; a message without delta is taken as complete. tool_use opens a call by tool_id and tool_result settles
// it by status. Its `error` events are warnings the run survives, so they stay diagnostics.
function geminiReader(chat: Transcript) {
  let slot = 0
  let open = false
  return (event: Record<string, unknown>) => {
    if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") {
      if (event.delta === true) {
        chat.message(`text-${slot}`, event.content, true)
        open = true
        return
      }
      chat.message(`text-${slot}`, event.content)
      slot += 1
      open = false
      return
    }
    const id = textAt(event, ["tool_id"])
    if (event.type === "tool_use" && id) {
      if (open) slot += 1
      open = false
      const name = textAt(event, ["tool_name"]) ?? "tool"
      chat.tool(id, name, "running", editedFiles(name, object(event.parameters)))
      return
    }
    if (event.type === "tool_result") chat.settle(id, event.status === "error" ? "failed" : "done")
  }
}

// pi streams one assistant message at a time: message_update carries deltas only, and message_end carries the
// authoritative message, which replaces what streamed. Tool calls appear as toolcall blocks while the model writes
// them, then run between tool_execution_start and tool_execution_end.
function piReader(chat: Transcript) {
  let slot = 0
  return (event: Record<string, unknown>) => {
    if (event.type === "message_update") {
      const update = object(event.assistantMessageEvent)
      if (update.type === "text_delta" && typeof update.delta === "string") {
        chat.settle(`thinking-${slot}`, "done")
        chat.message(`text-${slot}`, update.delta, true)
      }
      if (update.type === "thinking_start" || update.type === "thinking_delta")
        chat.tool(`thinking-${slot}`, "thinking", "running")
      if (update.type === "thinking_end") chat.tool(`thinking-${slot}`, "thinking", "done")
      const call = update.type === "toolcall_end" ? object(update.toolCall) : update
      const id = textAt(call, ["id"])
      if ((update.type === "toolcall_start" || update.type === "toolcall_end") && id) {
        const name = textAt(call, ["name", "toolName"]) ?? "tool"
        chat.tool(id, name, "running", editedFiles(name, object(call.arguments)))
      }
      return
    }
    if (event.type === "message_end") {
      const message = object(event.message)
      if (message.role !== "assistant") return
      chat.settle(`thinking-${slot}`, "done")
      const text = joinedText(blocks(message.content))
      if (!text) return
      chat.message(`text-${slot}`, text)
      slot += 1
      return
    }
    const id = textAt(event, ["toolCallId"])
    const name = textAt(event, ["toolName"]) ?? "tool"
    if (event.type === "tool_execution_start" && id)
      chat.tool(id, name, "running", editedFiles(name, object(event.args)))
    if (event.type === "tool_execution_end" && id) chat.tool(id, name, event.isError === true ? "failed" : "done")
  }
}

export function activityFromAgentLine(line: string) {
  const event = parseAgentJson(line)
  if (!event) return line
  const type = typeof event.type === "string" ? event.type : "event"
  const item = event.item && typeof event.item === "object" ? event.item : undefined
  const message =
    textAt(event, ["result", "message", "summary", "text"]) ??
    textAt(item, ["text", "message", "command", "path", "name"])
  return message ? `${type}: ${message}` : type.replace(/[._-]+/g, " ")
}

export function summaryFromAgentLine(line: string) {
  const event = parseAgentJson(line)
  if (!event) return undefined
  if (event.type === "result") return textAt(event, ["result"])
  if (event.type === "item.completed" && object(event.item).type === "agent_message")
    return textAt(event.item, ["text"])
  return undefined
}

// Codex puts the id on thread.started as thread_id, Claude Code, Qwen Code,
// Gemini CLI and Amp on their first event as session_id, and Cursor's envelope
// mirrors Claude's but its docs call the value a chatId. The keys do not
// collide, so branching on runtime would buy nothing. Top-level only, matching
// textAt — a nested id is a different protocol version, better treated as
// absent than guessed at. pi is the exception: its id sits on the session
// header ({"type":"session","id":…}), and every later record has an `id` of
// its own, so only that header counts.
export function sessionFromAgentLine(line: string, runtime?: ExternalAgent.Id) {
  const event = parseAgentJson(line)
  if (runtime && parserOf(runtime) === "pi") return event?.type === "session" ? textAt(event, ["id"]) : undefined
  return textAt(event, ["session_id", "thread_id", "sessionId", "threadId", "chat_id", "chatId"])
}

// The protocol's own end-of-turn event, which can come long before the process
// exits: codex-cli 0.154 prints turn.completed and keeps running for about 11 s.
// Codex's top-level {"type":"error"} is not an end. Codex also prints errors it
// recovers from, such as a reconnect notice, and a fatal one is still followed
// by turn.failed or an exit. Claude Code, Cursor, Qwen Code and Amp end on
// `result` (is_error on failure), Gemini CLI on `result` (status "error" on
// failure), and pi on agent_settled, once it has no retry or queued work left.
export function agentTurnFinished(runtime: ExternalAgent.Id, line: string): AgentTurnFinish | undefined {
  const event = parseAgentJson(line)
  if (!event) return undefined
  const parser = parserOf(runtime)
  if (parser === "codex") {
    if (event.type === "turn.completed") return "success"
    return event.type === "turn.failed" ? "failure" : undefined
  }
  if (parser === "pi") {
    if (event.type !== "agent_settled") return undefined
    return event.aborted === true ? "failure" : "success"
  }
  if (event.type !== "result") return undefined
  if (parser === "gemini") return event.status === "error" ? "failure" : "success"
  return event.is_error === true ? "failure" : "success"
}

// The failure a run's own events reported, whatever its exit code said; `fallback` stands in for a report without
// words. Claude Code, Cursor and Codex mark it is_error on any event (Codex's turn.failed carries error.message), Qwen
// Code and Amp on their result, Gemini CLI with a result of status "error", and pi on its last assistant message
// (stopReason "error") or a retry that finally failed.
export function reportedAgentError(runtime: ExternalAgent.Id, output: string[], fallback: string) {
  const parser = parserOf(runtime)
  const events = output.map(parseAgentJson).filter((event): event is Record<string, unknown> => Boolean(event))
  if (parser === "gemini") {
    const failed = events.findLast((event) => event.type === "result" && event.status === "error")
    return failed ? (textAt(object(failed.error), ["message"]) ?? fallback) : undefined
  }
  if (parser === "pi") {
    const retry = events.findLast((event) => event.type === "auto_retry_end" && event.success === false)
    if (retry) return textAt(retry, ["finalError"]) ?? fallback
    const last = events.findLast((event) => event.type === "message_end" && object(event.message).role === "assistant")
    const message = object(last?.message)
    if (message.stopReason !== "error" && message.stopReason !== "aborted") return undefined
    return textAt(message, ["errorMessage"]) ?? fallback
  }
  return events
    .map((event) => {
      if (parser === "codex" && event.type === "turn.failed")
        return textAt(object(event.error), ["message"]) ?? fallback
      // Amp's system error ends a run before its result says so.
      if (parser === "amp" && event.type === "system" && /^error_/.test(String(event.subtype)))
        return textAt(event, ["error"]) ?? fallback
      if (event.is_error !== true) return undefined
      return (
        textAt(event, ["result", "error", "message", "summary"]) ?? textAt(object(event.error), ["message"]) ?? fallback
      )
    })
    .find((text): text is string => Boolean(text))
}

// What a run cost as the CLI reported it: the total on Claude Code's result
// (total_cost_usd), or for pi the sum of what each assistant message cost.
// One reader per run, since pi's total has to be added up.
export function costReader(runtime: ExternalAgent.Id) {
  const pi = parserOf(runtime) === "pi"
  let total = 0
  return (line: string) => {
    const event = parseAgentJson(line)
    if (!pi) {
      const value = event?.total_cost_usd ?? event?.cost_usd
      return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(4)}` : undefined
    }
    const message = object(event?.message)
    const cost = object(object(message.usage).cost).total
    if (event?.type !== "message_end" || message.role !== "assistant") return undefined
    if (typeof cost !== "number" || !Number.isFinite(cost)) return undefined
    total += cost
    return `$${total.toFixed(4)}`
  }
}
