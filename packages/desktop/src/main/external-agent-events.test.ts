import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import {
  agentTurnFinished,
  costReader,
  createAgentChat,
  reportedAgentError,
  sessionFromAgentLine,
} from "./external-agent-events"
import { agentOutcome, runExternalCodingAgent, runtimeArguments } from "./external-agents"

// Every fixture below is written from the vendor's own published examples and schemas; the source is named on each.
// Where a documented example elides a value ("...") a plausible one is filled in, and only the fields the vendor
// documents are used. Strings marked PRIVATE stand for tool arguments, tool output and reasoning, which must never
// reach the chat.

const root = await mkdtemp(join(tmpdir(), "vector-agent-events-"))
const workspace = join(root, "workspace")
await mkdir(workspace, { recursive: true })
afterAll(() => rm(root, { recursive: true, force: true }))

const lines = (events: object[]) => events.map((event) => JSON.stringify(event))
const replay = (runtime: Parameters<typeof createAgentChat>[0], events: object[], roots = [workspace]) => {
  const parse = createAgentChat(runtime, roots)
  return lines(events).map((line) => parse(line))
}

// Gemini CLI: the "Example output" of docs/cli/headless.md (google-gemini/gemini-cli at 26f050ff10), verbatim.
const GEMINI_DOCUMENTED = [
  { type: "init", timestamp: "2025-10-10T12:00:00.000Z", session_id: "abc123", model: "gemini-2.0-flash-exp" },
  { type: "message", role: "user", content: "List files in current directory", timestamp: "2025-10-10T12:00:01.000Z" },
  {
    type: "tool_use",
    tool_name: "Bash",
    tool_id: "bash-123",
    parameters: { command: "ls -la" },
    timestamp: "2025-10-10T12:00:02.000Z",
  },
  {
    type: "tool_result",
    tool_id: "bash-123",
    status: "success",
    output: "file1.txt\nfile2.txt",
    timestamp: "2025-10-10T12:00:03.000Z",
  },
  {
    type: "message",
    role: "assistant",
    content: "Here are the files...",
    delta: true,
    timestamp: "2025-10-10T12:00:04.000Z",
  },
  {
    type: "result",
    status: "success",
    stats: { total_tokens: 250, input_tokens: 50, output_tokens: 200, duration_ms: 3000, tool_calls: 1 },
    timestamp: "2025-10-10T12:00:05.000Z",
  },
]

// Gemini CLI: a run that edits a file, with every field as packages/core/src/output/types.ts defines it (InitEvent,
// MessageEvent with delta, ToolUseEvent, ToolResultEvent with error, ErrorEvent with severity, ResultEvent), and the
// file tools of docs/tools/file-system.md (write_file and replace take file_path).
const at = "2026-10-23T12:00:00.000Z"
const GEMINI_EDIT = [
  { type: "init", timestamp: at, session_id: "6f1d2a64-6d2b-4d55-9e3e-0d1f8f0b7c11", model: "gemini-3-pro" },
  { type: "message", role: "user", content: "PRIVATE prompt", timestamp: at },
  { type: "message", role: "assistant", content: "I'll fix ", delta: true, timestamp: at },
  { type: "message", role: "assistant", content: "the test.", delta: true, timestamp: at },
  {
    type: "tool_use",
    tool_name: "replace",
    tool_id: "replace-1",
    parameters: { file_path: join(workspace, "src", "sum.ts"), old_string: "PRIVATE", new_string: "PRIVATE" },
    timestamp: at,
  },
  { type: "tool_result", tool_id: "replace-1", status: "success", output: "PRIVATE OUTPUT", timestamp: at },
  {
    type: "tool_use",
    tool_name: "write_file",
    tool_id: "write-1",
    parameters: { file_path: "/etc/PRIVATE-outside", content: "PRIVATE" },
    timestamp: at,
  },
  {
    type: "tool_result",
    tool_id: "write-1",
    status: "error",
    error: { type: "invalid_tool_params", message: "PRIVATE path outside the workspace" },
    timestamp: at,
  },
  { type: "error", severity: "warning", message: "Loop detected, stopping execution", timestamp: at },
  { type: "message", role: "assistant", content: "Fixed sum.ts.", delta: true, timestamp: at },
  { type: "result", status: "success", stats: { total_tokens: 1, tool_calls: 2 }, timestamp: at },
]

// Qwen Code: the shapes of packages/cli/src/nonInteractive/types.ts (CLISystemMessage, CLIPartialAssistantMessage,
// CLIAssistantMessage, CLIUserMessage, CLIResultMessage) in the order io/StreamJsonOutputAdapter.ts writes them with
// --include-partial-messages: one message_start per model turn, then one assistant envelope per block type, each
// under a new id. The system subtype "session_start" is the one docs/users/features/headless.md shows.
const QWEN_SESSION = "123e4567-e89b-12d3-a456-426614174000"
const qwenStream = (event: object) => ({
  type: "stream_event",
  uuid: crypto.randomUUID(),
  session_id: QWEN_SESSION,
  parent_tool_use_id: null,
  event,
})
const qwenAssistant = (id: string, content: object[]) => ({
  type: "assistant",
  uuid: id,
  session_id: QWEN_SESSION,
  parent_tool_use_id: null,
  message: { id, type: "message", role: "assistant", model: "qwen3-coder-plus", content, usage: {} },
})
const QWEN_EDIT = [
  { type: "system", subtype: "session_start", uuid: "s0", session_id: QWEN_SESSION, model: "qwen3-coder-plus" },
  qwenStream({
    type: "message_start",
    message: { id: "m1", role: "assistant", model: "qwen3-coder-plus", content: [] },
  }),
  qwenStream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
  qwenStream({
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "PRIVATE reasoning" },
  }),
  qwenStream({ type: "content_block_stop", index: 0 }),
  qwenAssistant("m1", [{ type: "thinking", thinking: "PRIVATE reasoning" }]),
  qwenStream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  qwenStream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I'll update " } }),
  qwenStream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "the file." } }),
  qwenStream({ type: "content_block_stop", index: 0 }),
  qwenAssistant("m2", [{ type: "text", text: "I'll update the file." }]),
  qwenStream({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"file_path":"PRIVATE' },
  }),
  qwenAssistant("m3", [
    {
      type: "tool_use",
      id: "call_1",
      name: "edit",
      input: { file_path: join(workspace, "src", "app.ts"), old_string: "PRIVATE", new_string: "PRIVATE" },
    },
  ]),
  qwenStream({ type: "message_stop" }),
  {
    type: "user",
    session_id: QWEN_SESSION,
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "PRIVATE OUTPUT" }] },
  },
  qwenStream({
    type: "message_start",
    message: { id: "m4", role: "assistant", model: "qwen3-coder-plus", content: [] },
  }),
  qwenStream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }),
  qwenAssistant("m4", [{ type: "text", text: "Done." }]),
  qwenStream({ type: "message_stop" }),
  {
    type: "result",
    subtype: "success",
    uuid: "r",
    session_id: QWEN_SESSION,
    is_error: false,
    duration_ms: 1234,
    duration_api_ms: 1000,
    num_turns: 2,
    result: "Done.",
    usage: { input_tokens: 10, output_tokens: 5 },
    permission_denials: [],
  },
]

// Amp: the "Tool usage example" of ampcode.com/docs/cli/streaming-json (lastModified 2026-10-23). The page wraps a few
// long lines mid-word ("todo_rea d", "end_tu rn", a split session id); those breaks are removed, nothing else changed.
const AMP_SESSION = "T-d2fc4acc-dd1d-497f-9609-ed0da22a7c95"
const ampUsage = (input: number, created: number, read: number, output: number) => ({
  input_tokens: input,
  cache_creation_input_tokens: created,
  cache_read_input_tokens: read,
  output_tokens: output,
  max_tokens: 968000,
  service_tier: "standard",
})
const AMP_DOCUMENTED = [
  {
    type: "system",
    subtype: "init",
    cwd: "/Users/orb/project",
    session_id: AMP_SESSION,
    tools: ["Bash", "create_file", "edit_file", "glob", "Grep", "Read", "todo_read", "todo_write", "web_search"],
    mcp_servers: [{ name: "postgres", status: "connected" }],
  },
  {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "list files using a tool" }] },
    parent_tool_use_id: null,
    session_id: AMP_SESSION,
  },
  {
    type: "assistant",
    message: {
      type: "message",
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_019cyniPYrSgaJitUSMyxyNV", name: "read", input: { path: "/Users/orb/project" } },
      ],
      stop_reason: "tool_use",
      usage: ampUsage(10, 13150, 0, 111),
    },
    parent_tool_use_id: null,
    session_id: AMP_SESSION,
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_019cyniPYrSgaJitUSMyxyNV",
          content: '["index.js","README.md"] ',
          is_error: false,
        },
      ],
    },
    parent_tool_use_id: null,
    session_id: AMP_SESSION,
  },
  {
    type: "assistant",
    message: {
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Two files: index.js and README.md" }],
      stop_reason: "end_turn",
      usage: ampUsage(7, 133, 13150, 13),
    },
    parent_tool_use_id: null,
    session_id: AMP_SESSION,
  },
  {
    type: "result",
    subtype: "success",
    duration_ms: 7363,
    is_error: false,
    num_turns: 2,
    result: "Two files: index.js and README.md",
    session_id: AMP_SESSION,
  },
]

// pi: the "Event sequence" and "Tool execution events" examples of packages/coding-agent/docs/json.md
// (earendil-works/pi), with the elided message fields filled in from docs/message-types.md (AssistantMessage, Usage,
// ToolCall) and the edit tool's `path` argument from src/core/tools/edit.ts.
const PI_SESSION = "0f6e1c52-3b0e-4f7a-9d55-6a2a0e1b9c3d"
const piUsage = (total: number) => ({
  input: 100,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 101,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
})
const piAssistant = (content: object[], stopReason: string, total: number, extra: object = {}) => ({
  role: "assistant",
  content,
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  usage: piUsage(total),
  stopReason,
  timestamp: 1733234402000,
  ...extra,
})
const piUpdate = (assistantMessageEvent: object) => ({
  type: "message_update",
  usage: piUsage(0),
  assistantMessageEvent,
})
const PI_EDIT = [
  { type: "session", version: 3, id: PI_SESSION, timestamp: "2024-12-03T14:00:00.000Z", cwd: "/path" },
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_start", message: { role: "user", content: "Review this repository", timestamp: 1733234401000 } },
  { type: "message_end", message: { role: "user", content: "Review this repository", timestamp: 1733234401000 } },
  { type: "message_start", message: piAssistant([], "pending", 0) },
  piUpdate({ type: "thinking_start", contentIndex: 0 }),
  piUpdate({ type: "thinking_delta", contentIndex: 0, delta: "PRIVATE reasoning" }),
  piUpdate({ type: "thinking_end", contentIndex: 0, content: "PRIVATE reasoning" }),
  piUpdate({ type: "text_start", contentIndex: 1 }),
  piUpdate({ type: "text_delta", contentIndex: 1, delta: "Hello " }),
  piUpdate({ type: "text_delta", contentIndex: 1, delta: "world" }),
  piUpdate({ type: "text_end", contentIndex: 1, content: "Hello world" }),
  piUpdate({ type: "toolcall_start", contentIndex: 2, id: "call_abc123", toolName: "bash" }),
  piUpdate({ type: "toolcall_delta", contentIndex: 2, delta: '{"command":"PRIVATE' }),
  piUpdate({
    type: "toolcall_end",
    contentIndex: 2,
    toolCall: { type: "toolCall", id: "call_abc123", name: "bash", arguments: { command: "ls -la" } },
  }),
  {
    type: "message_end",
    message: piAssistant(
      [
        { type: "thinking", thinking: "PRIVATE reasoning" },
        { type: "text", text: "Hello world" },
        { type: "toolCall", id: "call_abc123", name: "bash", arguments: { command: "ls -la" } },
      ],
      "toolUse",
      0.0012,
    ),
  },
  { type: "tool_execution_start", toolCallId: "call_abc123", toolName: "bash", args: { command: "ls -la" } },
  {
    type: "tool_execution_update",
    toolCallId: "call_abc123",
    toolName: "bash",
    args: { command: "ls -la" },
    partialResult: { content: [{ type: "text", text: "PRIVATE partial output" }], details: {} },
  },
  {
    type: "tool_execution_end",
    toolCallId: "call_abc123",
    toolName: "bash",
    result: { content: [{ type: "text", text: "PRIVATE complete output" }], details: {} },
    isError: false,
  },
  { type: "turn_end", message: piAssistant([], "toolUse", 0.0012), toolResults: [] },
  { type: "turn_start" },
  { type: "message_start", message: piAssistant([], "pending", 0) },
  piUpdate({
    type: "toolcall_end",
    contentIndex: 0,
    toolCall: {
      type: "toolCall",
      id: "call_edit",
      name: "edit",
      arguments: { path: "src/a.ts", edits: [{ oldText: "PRIVATE", newText: "PRIVATE" }] },
    },
  }),
  {
    type: "message_end",
    message: piAssistant(
      [{ type: "toolCall", id: "call_edit", name: "edit", arguments: { path: "src/a.ts", edits: [] } }],
      "toolUse",
      0.003,
    ),
  },
  { type: "tool_execution_start", toolCallId: "call_edit", toolName: "edit", args: { path: "src/a.ts" } },
  { type: "tool_execution_end", toolCallId: "call_edit", toolName: "edit", result: { content: [] }, isError: false },
  { type: "message_start", message: piAssistant([], "pending", 0) },
  piUpdate({ type: "text_delta", contentIndex: 0, delta: "Edited src/a.ts." }),
  { type: "message_end", message: piAssistant([{ type: "text", text: "Edited src/a.ts." }], "stop", 0.0004) },
  { type: "turn_end", message: piAssistant([], "stop", 0), toolResults: [] },
  { type: "agent_end", messages: [], willRetry: false },
  { type: "agent_settled", aborted: false },
]

describe("Gemini CLI stream-json", () => {
  test("the documented example becomes one answer and one finished command, without the tool's words", () => {
    const chat = replay("gemini", GEMINI_DOCUMENTED).at(-1)!
    expect(chat.messages).toEqual([{ id: "text-0", text: "Here are the files..." }])
    expect(chat.activity).toEqual([{ id: "bash-123", label: "Running a command", kind: "tool", state: "done" }])
    expect(JSON.stringify(chat)).not.toContain("ls -la")
    expect(JSON.stringify(chat)).not.toContain("file1.txt")
    expect(JSON.stringify(chat)).not.toContain("List files")
  })

  test("deltas build one message per stretch of text, and edits name only workspace files", () => {
    const snapshots = replay("gemini", GEMINI_EDIT)
    const chat = snapshots.at(-1)!
    expect(chat.messages).toEqual([
      { id: "text-0", text: "I'll fix the test." },
      { id: "text-1", text: "Fixed sum.ts." },
    ])
    expect(snapshots.some((snapshot) => snapshot.messages[0]?.text === "I'll fix ")).toBe(true)
    expect(chat.activity).toEqual([
      { id: "replace-1", label: "Updating files", kind: "tool", state: "done", files: ["src/sum.ts"] },
      { id: "write-1", label: "Updating files", kind: "tool", state: "failed" },
    ])
    expect(JSON.stringify(chat)).not.toContain("PRIVATE")
  })

  test("its session id, end of turn and reported failure", () => {
    const [init, , , , , result] = lines(GEMINI_DOCUMENTED)
    expect(sessionFromAgentLine(init!, "gemini")).toBe("abc123")
    expect(sessionFromAgentLine('{"type":"init","sessionId":"camel-1","model":"m"}', "gemini")).toBe("camel-1")
    expect(
      lines(GEMINI_EDIT)
        .map((line) => agentTurnFinished("gemini", line))
        .filter(Boolean),
    ).toEqual(["success"])
    expect(agentTurnFinished("gemini", result!)).toBe("success")
    // The result errors/utils.ts writes for a fatal error in stream-json mode.
    const failed = JSON.stringify({
      type: "result",
      timestamp: at,
      status: "error",
      error: { type: "FatalAuthenticationError", message: "Quota exceeded for this account" },
      stats: { total_tokens: 0 },
    })
    expect(agentTurnFinished("gemini", failed)).toBe("failure")
    expect(reportedAgentError("gemini", [`[stdout] ${failed}`], "fallback")).toBe("Quota exceeded for this account")
    // Warnings the run survives are not failures.
    expect(reportedAgentError("gemini", lines(GEMINI_EDIT), "fallback")).toBeUndefined()
    expect(agentOutcome("gemini", 0, lines(GEMINI_EDIT))).toEqual({ exitCode: 0 })
    expect(agentOutcome("gemini", 1, [`[stdout] ${failed}`]).error).toBe("Quota exceeded for this account")
  })

  test("a Gemini CLI with no sign-in names the command that opens its own sign-in", () => {
    // validateNonInterActiveAuth.ts's words when no auth method is set, as its stream-json result carries them.
    const unset = JSON.stringify({
      type: "result",
      status: "error",
      error: {
        type: "Error",
        message:
          "Please set an Auth method in your /home/u/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA",
      },
    })
    const outcome = agentOutcome("gemini", 41, [`[stdout] ${unset}`])
    expect(outcome.error).toContain("Gemini CLI is installed but not signed in")
    expect(outcome.error).toContain(
      "Run `gemini` in a terminal to sign in. Choose how to sign in when Gemini CLI starts",
    )
  })
})

describe("Qwen Code stream-json", () => {
  test("text split across envelopes under new ids appears once, in order, with the edit's workspace file", () => {
    const snapshots = replay("qwen", QWEN_EDIT)
    const chat = snapshots.at(-1)!
    expect(chat.messages).toEqual([
      { id: "text-0", text: "I'll update the file." },
      { id: "text-1", text: "Done." },
    ])
    expect(snapshots.some((snapshot) => snapshot.messages[0]?.text === "I'll update ")).toBe(true)
    expect(chat.activity).toEqual([
      { id: "thinking-0", label: "Thinking", kind: "thinking", state: "done" },
      { id: "call_1", label: "Updating files", kind: "tool", state: "done", files: ["src/app.ts"] },
    ])
    expect(JSON.stringify(chat)).not.toContain("PRIVATE")
  })

  test("the documented run without partial messages shows its answer once", () => {
    // docs/users/features/headless.md, "JSON Output" example, as stream-json lines.
    const chat = replay("qwen", [
      { type: "system", subtype: "session_start", uuid: "u", session_id: "s", model: "qwen3-coder-plus" },
      qwenAssistant("a", [{ type: "text", text: "The capital of France is Paris." }]),
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "The capital of France is Paris.",
        session_id: "s",
      },
    ]).at(-1)!
    expect(chat.messages).toEqual([{ id: "text-0", text: "The capital of France is Paris." }])
  })

  test("its session id, end of turn and the reason a failed result gives", () => {
    expect(sessionFromAgentLine(lines(QWEN_EDIT)[0]!, "qwen")).toBe(QWEN_SESSION)
    expect(
      lines(QWEN_EDIT)
        .map((line) => agentTurnFinished("qwen", line))
        .filter(Boolean),
    ).toEqual(["success"])
    // CLIResultMessageError: no result text, the reason on error.message.
    const failed = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      uuid: "r",
      session_id: QWEN_SESSION,
      is_error: true,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      usage: {},
      permission_denials: [],
      error: { type: "api_error", message: "Model stream ended without a finish reason" },
    })
    expect(agentTurnFinished("qwen", failed)).toBe("failure")
    expect(agentOutcome("qwen", 1, [`[stdout] ${failed}`]).error).toBe("Model stream ended without a finish reason")
    expect(agentOutcome("qwen", 0, lines(QWEN_EDIT))).toEqual({ exitCode: 0 })
    const signedOut = agentOutcome("qwen", 1, ["[stderr] Error: 401 Unauthorized"])
    expect(signedOut.error).toContain("Run `qwen` in a terminal to sign in. Type /auth inside Qwen Code, then")
  })
})

describe("Amp stream-json", () => {
  test("the documented tool run becomes its answer and one finished read", () => {
    const chat = replay("amp", AMP_DOCUMENTED).at(-1)!
    expect(chat.messages).toEqual([{ id: "text-0", text: "Two files: index.js and README.md" }])
    expect(chat.activity).toEqual([
      { id: "toolu_019cyniPYrSgaJitUSMyxyNV", label: "Reading repository", kind: "tool", state: "done" },
    ])
    // Neither the read's path nor the user's own words cross.
    expect(JSON.stringify(chat)).not.toContain("/Users/orb/project")
    expect(JSON.stringify(chat)).not.toContain("list files using a tool")
  })

  test("envelopes without ids never overwrite each other", () => {
    // The page's three-message --stream-json-input example: "4", "12" and "17" are three answers.
    const answer = (text: string) => ({
      type: "assistant",
      message: { type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" },
      parent_tool_use_id: null,
      session_id: "T-addfb7a4-61d9-41e1-890b-7330aa54087a",
    })
    const chat = replay("amp", [answer("4"), answer("12"), answer("17")]).at(-1)!
    expect(chat.messages.map((message) => message.text)).toEqual(["4", "12", "17"])
  })

  test("edit_file and create_file name the workspace file they change", () => {
    const chat = replay("amp", [
      {
        type: "assistant",
        message: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "e1",
              name: "edit_file",
              input: { path: join(workspace, "index.js"), old_str: "PRIVATE" },
            },
            { type: "tool_use", id: "c1", name: "create_file", input: { path: "docs/new.md", content: "PRIVATE" } },
          ],
          stop_reason: "tool_use",
        },
        parent_tool_use_id: null,
        session_id: AMP_SESSION,
      },
    ]).at(-1)!
    expect(chat.activity).toEqual([
      { id: "e1", label: "Updating files", kind: "tool", state: "running", files: ["index.js"] },
      { id: "c1", label: "Updating files", kind: "tool", state: "running", files: ["docs/new.md"] },
    ])
    expect(JSON.stringify(chat)).not.toContain("PRIVATE")
  })

  test("its thread id, end of turn and the error string of a failed run", () => {
    expect(sessionFromAgentLine(lines(AMP_DOCUMENTED)[0]!, "amp")).toBe(AMP_SESSION)
    expect(
      lines(AMP_DOCUMENTED)
        .map((line) => agentTurnFinished("amp", line))
        .filter(Boolean),
    ).toEqual(["success"])
    // The schema's failed result and system error: `error` is a string.
    const failed = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      duration_ms: 10,
      is_error: true,
      num_turns: 1,
      error: "Out of credits",
      session_id: AMP_SESSION,
    })
    expect(agentTurnFinished("amp", failed)).toBe("failure")
    expect(agentOutcome("amp", 1, [`[stdout] ${failed}`]).error).toBe("Out of credits")
    const system = JSON.stringify({
      type: "system",
      subtype: "error_max_turns",
      error: "Reached the turn limit",
      session_id: AMP_SESSION,
    })
    expect(reportedAgentError("amp", [`[stdout] ${system}`, `[stdout] ${failed}`], "fallback")).toBe(
      "Reached the turn limit",
    )
    expect(agentOutcome("amp", 0, lines(AMP_DOCUMENTED))).toEqual({ exitCode: 0 })
  })
})

describe("pi JSON events", () => {
  test("streamed text is replaced by each final message, and tool calls run from start to end", () => {
    const snapshots = replay("pi", PI_EDIT)
    const chat = snapshots.at(-1)!
    expect(chat.messages).toEqual([
      { id: "text-0", text: "Hello world" },
      { id: "text-1", text: "Edited src/a.ts." },
    ])
    expect(snapshots.some((snapshot) => snapshot.messages[0]?.text === "Hello ")).toBe(true)
    expect(chat.activity).toEqual([
      { id: "thinking-0", label: "Thinking", kind: "thinking", state: "done" },
      { id: "call_abc123", label: "Running a command", kind: "tool", state: "done" },
      { id: "call_edit", label: "Updating files", kind: "tool", state: "done", files: ["src/a.ts"] },
    ])
    expect(JSON.stringify(chat)).not.toContain("PRIVATE")
  })

  test("only the session header names the session, and the turn ends once pi settles", () => {
    const all = lines(PI_EDIT)
    expect(sessionFromAgentLine(all[0]!, "pi")).toBe(PI_SESSION)
    // Later records carry ids of their own, which are not the session.
    expect(
      all
        .slice(1)
        .map((line) => sessionFromAgentLine(line, "pi"))
        .filter(Boolean),
    ).toEqual([])
    expect(all.map((line) => agentTurnFinished("pi", line)).filter(Boolean)).toEqual(["success"])
    expect(agentTurnFinished("pi", '{"type":"agent_settled","aborted":true}')).toBe("failure")
    expect(agentTurnFinished("pi", '{"type":"agent_end","messages":[],"willRetry":true}')).toBeUndefined()
  })

  test("a failed last message or a retry that gave up is the run's error, and a recovered one is not", () => {
    const failedMessage = {
      type: "message_end",
      message: piAssistant([], "error", 0, { errorMessage: "529 overloaded" }),
    }
    const recovered = [
      failedMessage,
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "529 overloaded" },
      { type: "message_end", message: piAssistant([{ type: "text", text: "Done" }], "stop", 0) },
      { type: "auto_retry_end", success: true, attempt: 2 },
      { type: "agent_settled", aborted: false },
    ]
    expect(reportedAgentError("pi", lines(recovered), "fallback")).toBeUndefined()
    expect(reportedAgentError("pi", lines([failedMessage, { type: "agent_settled", aborted: false }]), "f")).toBe(
      "529 overloaded",
    )
    const gaveUp = [
      failedMessage,
      { type: "auto_retry_end", success: false, attempt: 3, finalError: "Still overloaded" },
    ]
    expect(agentOutcome("pi", 0, lines(gaveUp)).error).toBe("Still overloaded")
    const unauthorized = {
      type: "message_end",
      message: piAssistant([], "error", 0, { errorMessage: "401 Unauthorized" }),
    }
    expect(agentOutcome("pi", 0, lines([unauthorized])).error).toContain("Type /login inside pi to connect a provider")
  })

  test("its cost is the sum of what each assistant message cost", () => {
    const read = costReader("pi")
    const costs = lines(PI_EDIT)
      .map((line) => read(line))
      .filter(Boolean)
    expect(costs.at(-1)).toBe("$0.0046")
    // Claude Code's total stays a total, read from its result alone.
    const claude = costReader("claude-code")
    expect(claude('{"type":"result","total_cost_usd":0.5}')).toBe("$0.5000")
    expect(claude(lines(PI_EDIT).at(-1)!)).toBeUndefined()
  })
})

describe("every reader is an allowlist", () => {
  for (const runtime of ["gemini", "qwen", "amp", "pi"] as const) {
    test(`${runtime} ignores lines that are not its events and never throws`, () => {
      const parse = createAgentChat(runtime, [workspace])
      const before = parse("")
      for (const line of [
        '{"broken":',
        "CLI warning PRIVATE",
        '{"type":"future","text":"PRIVATE"}',
        '{"type":"message","role":"assistant","content":42}',
        '{"type":"assistant","message":{"content":"PRIVATE not an array"}}',
        '{"type":"message_update","assistantMessageEvent":"PRIVATE"}',
        '{"type":"tool_use","tool_name":7,"parameters":"PRIVATE"}',
        '{"type":"tool_execution_end","toolCallId":null}',
        "[1,2,3]",
        "null",
      ])
        expect(parse(line)).toEqual(before)
    })
  }
})

describe("the new chat agents through a real local process", () => {
  async function fakeCli(name: string, cli: string, body: string) {
    const directory = join(root, "cli", name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, cli), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(directory, "argv")}"\n${body}\n`)
    await chmod(join(directory, cli), 0o755)
    return {
      env: { HOME: root, PATH: `${directory}:/usr/bin:/bin` },
      argv: async () => (await Bun.file(join(directory, "argv")).text()).trimEnd().split("\n"),
    }
  }
  const print = (events: object[]) =>
    lines(events)
      .map((line) => `printf '%s\\n' '${line.replaceAll("'", "'\\''")}'`)
      .join("\n")

  const runs = [
    { runtime: "gemini" as const, cli: "gemini", events: GEMINI_EDIT, session: "6f1d2a64-6d2b-4d55-9e3e-0d1f8f0b7c11" },
    { runtime: "qwen" as const, cli: "qwen", events: QWEN_EDIT, session: QWEN_SESSION },
    { runtime: "amp" as const, cli: "amp", events: AMP_DOCUMENTED, session: AMP_SESSION },
    { runtime: "pi" as const, cli: "pi", events: PI_EDIT, session: PI_SESSION },
  ]
  for (const run of runs) {
    test(`${run.runtime} streams into chat and reports its session, summary and success`, async () => {
      const cli = await fakeCli(run.runtime, run.cli, print(run.events))
      const chats: ReturnType<ReturnType<typeof createAgentChat>>[] = []
      const result = await runExternalCodingAgent({
        runtime: run.runtime,
        cwd: workspace,
        prompt: "fixture only",
        env: cli.env,
        onChat: (chat) => chats.push(chat),
      })
      expect(result.exitCode).toBe(0)
      expect(result.error).toBeUndefined()
      expect(result.sessionId).toBe(run.session)
      expect(result.summary).toBe(chats.at(-1)!.messages.at(-1)!.text)
      expect(JSON.stringify(chats)).not.toContain("PRIVATE")
      expect(await cli.argv()).toEqual(runtimeArguments(run.runtime, workspace, "fixture only"))

      await runExternalCodingAgent({
        runtime: run.runtime,
        cwd: workspace,
        prompt: "next",
        resumeSessionId: run.session,
        env: cli.env,
      })
      expect(await cli.argv()).toContain(run.session)
    }, 20_000)
  }

  test("a pi that lingers after agent_settled is stopped and the turn still succeeds", async () => {
    const cli = await fakeCli("pi-linger", "pi", `${print(PI_EDIT)}\nsleep 30`)
    const startedAt = Date.now()
    const result = await runExternalCodingAgent({
      runtime: "pi",
      cwd: workspace,
      prompt: "fixture only",
      env: cli.env,
      finishGraceMs: 20,
      killGraceMs: 20,
    })
    expect(result.exitCode).toBe(0)
    expect(result.actualCost).toBe("$0.0046")
    expect(Date.now() - startedAt).toBeLessThan(10_000)
  }, 20_000)

  test("a session Gemini CLI or Qwen Code no longer has is a refused resume, so Vector re-briefs", async () => {
    // sessionUtils.ts (Gemini CLI) and config/config.ts (Qwen Code) word it this way.
    for (const [runtime, said] of [
      ["gemini", 'Invalid session identifier "gone".'],
      [
        "qwen",
        "No saved session found with ID gone. Run `qwen --resume` without an ID to choose from existing sessions.",
      ],
    ] as const) {
      const cli = await fakeCli(`${runtime}-gone`, runtime, `echo '${said.replaceAll("'", "'\\''")}' >&2\nexit 1`)
      const result = await runExternalCodingAgent({
        runtime,
        cwd: workspace,
        prompt: "next",
        resumeSessionId: "gone",
        env: cli.env,
      })
      expect({ runtime, resumeRejected: result.resumeRejected }).toEqual({ runtime, resumeRejected: true })
    }
  }, 20_000)

  test("through a Windows command script, Gemini CLI, Qwen Code and Amp read the prompt from stdin", () => {
    const prompt = "line one\nline two"
    for (const runtime of ["gemini", "qwen", "amp"] as const) {
      const argv = runtimeArguments(runtime, workspace, prompt, undefined, true)
      expect(argv).not.toContain(prompt)
      expect(argv).not.toContain("-p")
    }
    expect(() => runtimeArguments("pi", workspace, prompt, undefined, true)).toThrow("argv only")
  })
})
