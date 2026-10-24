import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { ExternalAgent } from "@vectordevai/schema/external-agent"

import {
  agentCandidatePaths,
  agentCommands,
  commandLine,
  launchAgentTerminal,
  listAgentModels,
  modelsFromOutput,
  signedInFromCredentialCount,
  terminalLaunch,
  agentEnvironment,
  agentOutcome,
  detectExternalAgents,
  executableNames,
  externalModelValue,
  modelRejected,
  resolveAgentPath,
  runCli,
  runExternalCodingAgent,
  runsThroughCmd,
  signedInFromProbe,
  runtimeArguments,
  shimmedCommand,
  windowsTaskkillArguments,
} from "./external-agents"
import { agentTurnFinished, createAgentChat, sessionFromAgentLine } from "./external-agent-events"

// A real executable in a real directory: the bug being guarded is a CLI that
// exists but is invisible to a GUI-launched app, so nothing here may be faked.
const root = await mkdtemp(join(tmpdir(), "vector-external-agents-"))

async function installFakeCli(directory: string, name: string) {
  await mkdir(directory, { recursive: true })
  const path = join(directory, name)
  await writeFile(path, "#!/bin/sh\necho 1.2.3\n")
  await chmod(path, 0o755)
  return path
}

afterAll(() => rm(root, { recursive: true, force: true }))

describe("structured external chat", () => {
  // Captured from a real cursor-agent 2026.09.02 run that created one file; only
  // the temp folder and ids were replaced.
  test("a real Cursor edit reports the workspace file it changed", () => {
    const workspace = "/tmp/vector-edit-fixture"
    const call = "call-9845249b-5284-42fc-9750-b52ca19c12bf-0\nfc_b37b40b1-8f25-90f5-bb75-d7e148aa9824_0"
    const editToolCall = { args: { path: `${workspace}/hello.txt`, streamContent: "hi\n" } }
    const parse = createAgentChat("cursor", [workspace])
    parse(
      JSON.stringify({
        type: "tool_call",
        subtype: "started",
        call_id: call,
        tool_call: { editToolCall, hookAdditionalContexts: [], toolCallId: call },
      }),
    )
    const chat = parse(
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: call,
        tool_call: {
          editToolCall: {
            ...editToolCall,
            result: { success: { path: `${workspace}/hello.txt`, linesAdded: 1, linesRemoved: 0 } },
          },
          hookAdditionalContexts: [],
          toolCallId: call,
        },
      }),
    )
    expect(chat.activity.find((entry) => entry.kind === "tool")).toMatchObject({ state: "done", files: ["hello.txt"] })
  })

  test("Claude completed block envelopes never overwrite earlier streamed text in the same message", () => {
    const parse = createAgentChat("claude-code")
    parse(JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id: "msg" } } }))
    for (const [index, text] of ["First paragraph. ", "Second paragraph."].entries()) {
      parse(
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
        }),
      )
      parse(JSON.stringify({ type: "stream_event", event: { type: "content_block_stop", index } }))
      parse(
        JSON.stringify({
          type: "assistant",
          uuid: `block-${index}`,
          message: { id: "msg", content: [{ type: "text", text }] },
        }),
      )
    }
    expect(parse('{"type":"result","result":"Second paragraph."}').messages).toEqual([
      { id: "msg", text: "First paragraph. Second paragraph." },
    ])
    expect(parse('{"type":"result","is_error":true,"result":"failed"}').messages[0]?.text).toBe(
      "First paragraph. Second paragraph.",
    )
  })

  test("Claude non-partial block envelopes append once by UUID", () => {
    const parse = createAgentChat("claude-code")
    const first = JSON.stringify({
      type: "assistant",
      uuid: "first",
      message: { id: "msg", content: [{ type: "text", text: "ha" }] },
    })
    parse(first)
    parse(first)
    expect(
      parse(
        JSON.stringify({
          type: "assistant",
          uuid: "second",
          message: { id: "msg", content: [{ type: "text", text: "ha" }] },
        }),
      ).messages[0]?.text,
    ).toBe("haha")
  })
  test("Cursor complete-block streaming preserves repeated text through retries, queries and error results", () => {
    const parse = createAgentChat("cursor")
    const block = (text: string) =>
      parse(
        JSON.stringify({
          type: "assistant",
          timestamp_ms: 1,
          session_id: "fixture",
          message: { role: "assistant", content: [{ type: "text", text }] },
        }),
      )
    expect(block("ha").messages[0]?.text).toBe("ha")
    parse(JSON.stringify({ type: "retry", subtype: "starting" }))
    expect(block("ha").messages[0]?.text).toBe("haha")
    parse(JSON.stringify({ type: "interaction_query", subtype: "request", query: { private: "PRIVATE" } }))
    expect(block("!").messages[0]?.text).toBe("haha!")
    const failed = parse(JSON.stringify({ type: "result", is_error: true, result: "PRIVATE runtime error" }))
    expect(failed.messages[0]?.text).toBe("haha!")
    expect(JSON.stringify(failed)).not.toContain("PRIVATE")
    expect(parse(JSON.stringify({ type: "result", result: "haha!" })).messages).toEqual(failed.messages)
    for (const session of [undefined, "resume-id"])
      expect(runtimeArguments("cursor", "/w", "test", session)).not.toContain("--stream-partial-output")
  })

  test("Cursor result-only output still becomes chat", () => {
    expect(createAgentChat("cursor")('{"type":"result","result":"Done"}').messages).toEqual([
      { id: "assistant-0", text: "Done" },
    ])
  })

  test("Cursor failed and stopped local processes preserve every emitted complete block", async () => {
    for (const stopped of [false, true]) {
      const directory = join(root, `cursor-${stopped ? "stopped" : "failed"}`)
      await mkdir(directory, { recursive: true })
      const path = join(directory, "cursor-agent")
      const block = JSON.stringify({
        type: "assistant",
        timestamp_ms: 1,
        message: { content: [{ type: "text", text: "ha" }] },
      })
      await writeFile(
        path,
        `#!/bin/sh\nprintf '%s\\n' '${block}' '{"type":"retry","subtype":"starting"}' '${block}'\n${stopped ? "sleep 30" : 'printf \'%s\\n\' \'{"type":"result","is_error":true,"result":"fixture failure"}\'; exit 1'}\n`,
      )
      await chmod(path, 0o755)
      const controller = new AbortController()
      const chats: ReturnType<ReturnType<typeof createAgentChat>>[] = []
      const result = await runExternalCodingAgent({
        runtime: "cursor",
        cwd: root,
        prompt: "fixture only",
        signal: controller.signal,
        killGraceMs: 10,
        // A safety net for a regression only: the stopped case ends on abort.
        // A 1 s limit here raced a slow first exec of the fresh script on CI,
        // which resolved as a timeout (124) and skipped every packaging job.
        timeoutMs: 15_000,
        env: { HOME: root, PATH: `${directory}:/usr/bin:/bin` },
        onChat: (chat) => {
          chats.push(chat)
          if (stopped && chat.messages[0]?.text === "haha") controller.abort()
        },
      })
      expect(result.exitCode).toBe(stopped ? 130 : 1)
      expect(chats.at(-1)?.messages[0]?.text).toBe("haha")
    }
  }, 40_000)
  const fixtures = [
    {
      runtime: "codex" as const,
      cli: "codex",
      events: [
        { type: "item.started", item: { id: "tool", type: "command_execution", command: "PRIVATE ARGUMENT" } },
        {
          type: "item.completed",
          item: { id: "tool", type: "command_execution", status: "completed", aggregated_output: "PRIVATE OUTPUT" },
        },
        { type: "item.updated", item: { id: "answer", type: "agent_message", text: "Hello " } },
        { type: "item.completed", item: { id: "answer", type: "agent_message", text: "Hello world" } },
      ],
    },
    {
      runtime: "claude-code" as const,
      cli: "claude",
      events: [
        { type: "stream_event", event: { type: "message_start", message: { id: "answer" } } },
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } } },
        {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "PRIVATE ARGUMENT" } },
        },
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "world" } } },
        { type: "assistant", message: { id: "answer", content: [{ type: "text", text: "Hello world" }] } },
        { type: "result", result: "Hello world" },
      ],
    },
    {
      runtime: "cursor" as const,
      cli: "cursor-agent",
      events: [
        { type: "assistant", timestamp_ms: 1, message: { content: [{ type: "text", text: "Hello " }] } },
        { type: "assistant", timestamp_ms: 2, message: { content: [{ type: "text", text: "world" }] } },
        {
          type: "tool_call",
          subtype: "started",
          call_id: "tool",
          tool_call: { shellToolCall: { args: "PRIVATE ARGUMENT" } },
        },
        {
          type: "tool_call",
          subtype: "completed",
          call_id: "tool",
          tool_call: { shellToolCall: { result: "PRIVATE OUTPUT" } },
        },
        { type: "result", result: "Hello world" },
      ],
    },
  ]
  for (const fixture of fixtures) {
    test(`${fixture.runtime} normalizes streaming text without duplicate finals or protocol leakage`, () => {
      const parse = createAgentChat(fixture.runtime)
      const snapshots = fixture.events.map((event) => parse(JSON.stringify(event)))
      const chat = snapshots.at(-1)!
      expect(chat.messages.map((message) => message.text)).toEqual(["Hello world"])
      expect(JSON.stringify(chat)).not.toContain("PRIVATE")
      expect(snapshots.some((snapshot) => snapshot.messages.some((message) => message.text === "Hello "))).toBe(true)
      for (const line of ['{"broken":', '{"type":"future","text":"PRIVATE"}', "CLI warning PRIVATE"]) {
        expect(parse(line)).toEqual(chat)
      }
    })
    test(`${fixture.runtime} streams a real local process into chat and retains raw diagnostics`, async () => {
      const directory = join(root, `chat-${fixture.cli}`)
      await mkdir(directory, { recursive: true })
      const path = join(directory, fixture.cli)
      const lines = fixture.events.map((event) => JSON.stringify(event)).concat('{"broken":', "CLI warning PRIVATE")
      await writeFile(
        path,
        `#!/bin/sh\n${lines.map((line) => `printf '%s\\n' '${line.replaceAll("'", "'\\''")}'`).join("\n")}\n`,
      )
      await chmod(path, 0o755)
      const chats: ReturnType<ReturnType<typeof createAgentChat>>[] = []
      const result = await runExternalCodingAgent({
        runtime: fixture.runtime,
        cwd: root,
        prompt: "fixture only",
        env: { HOME: root, PATH: `${directory}:/usr/bin:/bin` },
        onChat: (chat) => chats.push(chat),
      })
      expect(result.exitCode).toBe(0)
      expect(chats.at(-1)?.messages.map((message) => message.text)).toEqual(["Hello world"])
      expect(result.output.some((line) => line.includes("CLI warning PRIVATE"))).toBe(true)
      expect(JSON.stringify(chats)).not.toContain("PRIVATE")
    })
  }
})

// Real event shapes, captured 2026-09-12 from the installed CLIs run with the
// exact argv runtimeArguments builds: codex-cli 0.154.0-alpha.6.2 (the one the
// ChatGPT app ships), cursor-agent 2026.09.02-c22c1a3, and Claude Code 2.1.215
// signed out. Long envelopes are trimmed, but every type, subtype and key is real.
const sessionId = "f1f41862-f9cb-448e-9734-ca84962c5db8"
const captured = {
  codex: [
    { type: "thread.started", thread_id: "01a09712-e58b-73a1-b808-3287c1c0ab54" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "OK" } },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 16492,
        cached_input_tokens: 12928,
        cache_write_input_tokens: 0,
        output_tokens: 5,
        reasoning_output_tokens: 0,
      },
    },
  ],
  cursor: [
    {
      type: "system",
      subtype: "init",
      apiKeySource: "login",
      cwd: "/private/var/folders/fixture",
      session_id: sessionId,
      model: "Auto",
      permissionMode: "default",
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "Reply with the single word OK. Do not use any tools." }],
      },
      session_id: sessionId,
    },
    ...["The user requested a", " single-word response", ' of "OK" without using', " any tools."].map(
      (text, index) => ({
        type: "thinking",
        subtype: "delta",
        text,
        session_id: sessionId,
        timestamp_ms: 1789240998983 + index,
      }),
    ),
    { type: "thinking", subtype: "completed", session_id: sessionId, timestamp_ms: 1789240998987 },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "OK" }] },
      session_id: sessionId,
    },
    {
      type: "result",
      subtype: "success",
      duration_ms: 4177,
      duration_api_ms: 4177,
      is_error: false,
      result: "OK",
      session_id: sessionId,
      request_id: "8526a6f6-5672-47f3-adf9-26ad9fab8557",
      usage: { inputTokens: 4691, outputTokens: 33, cacheReadTokens: 9728, cacheWriteTokens: 0 },
    },
  ],
  claudeSignedOut: [
    {
      type: "system",
      subtype: "init",
      cwd: "/private/var/folders/fixture",
      session_id: "4235e1e7-0234-49f4-83e0-9c8cc827c840",
      tools: ["Task", "Bash", "Edit", "Read", "Write"],
      mcp_servers: [],
      model: "claude-opus-4-8[1m]",
      permissionMode: "acceptEdits",
      apiKeySource: "none",
      claude_code_version: "2.1.215",
      uuid: "bf5d108c-9dbc-4cc0-a3d2-1eda25d7c5ab",
    },
    {
      type: "system",
      subtype: "status",
      status: "requesting",
      uuid: "b99dfb72-7a20-4fc8-b304-29e20c16972b",
      session_id: "4235e1e7-0234-49f4-83e0-9c8cc827c840",
    },
    {
      type: "assistant",
      message: {
        id: "a614bfbd-f087-4961-ba49-cfac37f06c2c",
        model: "<synthetic>",
        role: "assistant",
        stop_reason: "stop_sequence",
        type: "message",
        content: [{ type: "text", text: "Not logged in · Please run /login" }],
      },
      parent_tool_use_id: null,
      session_id: "4235e1e7-0234-49f4-83e0-9c8cc827c840",
      uuid: "3a2d3514-92d2-4b6a-aad1-6607c463eee3",
      error: "authentication_failed",
    },
    {
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: null,
      duration_ms: 42,
      num_turns: 1,
      result: "Not logged in · Please run /login",
      stop_reason: "stop_sequence",
      session_id: "4235e1e7-0234-49f4-83e0-9c8cc827c840",
      total_cost_usd: 0,
      terminal_reason: "api_error",
      uuid: "18161e21-f58a-4ab8-92e4-a7463f330fb7",
    },
  ],
}
const jsonLines = (events: object[]) => events.map((event) => JSON.stringify(event))
const printLines = (events: object[]) =>
  jsonLines(events)
    .map((line) => `printf '%s\\n' '${line.replaceAll("'", "'\\''")}'`)
    .join("\n")

describe("the event shapes the installed CLIs print today", () => {
  test("codex shows it is thinking from turn.started, long before its first complete item", () => {
    const parse = createAgentChat("codex")
    const snapshots = jsonLines(captured.codex).map((line) => parse(line))
    expect(snapshots[1]?.messages).toEqual([])
    expect(snapshots[1]?.activity).toEqual([
      { id: "codex-turn", label: "Thinking", kind: "thinking", state: "running" },
    ])
    expect(snapshots.at(-1)?.messages).toEqual([{ id: "item_0", text: "OK" }])
    expect(snapshots.at(-1)?.activity.map((entry) => entry.state)).toEqual(["done"])
    expect(jsonLines(captured.codex).map((line) => agentTurnFinished("codex", line))).toEqual([
      undefined,
      undefined,
      undefined,
      "success",
    ])
  })

  test("cursor shows one thinking phase before its text and never the reasoning itself", () => {
    const parse = createAgentChat("cursor")
    const snapshots = jsonLines(captured.cursor).map((line) => parse(line))
    const firstText = snapshots.findIndex((chat) => chat.messages.length > 0)
    expect(
      snapshots
        .slice(0, firstText)
        .some((chat) => chat.activity.some((entry) => entry.kind === "thinking" && entry.state === "running")),
    ).toBe(true)
    expect(snapshots.at(-1)).toEqual({
      messages: [{ id: "assistant-0", text: "OK" }],
      activity: [{ id: "assistant-0-thinking-0", label: "Thinking", kind: "thinking", state: "done" }],
    })
    for (const privateText of ["requested", "single-word", "Reply with the single word"]) {
      expect(JSON.stringify(snapshots)).not.toContain(privateText)
    }
    expect(
      jsonLines(captured.cursor)
        .map((line) => agentTurnFinished("cursor", line))
        .filter(Boolean),
    ).toEqual(["success"])
  })

  test("a signed-out Claude Code turn ends on its error result and names the sign-in command", () => {
    const lines = jsonLines(captured.claudeSignedOut)
    const parse = createAgentChat("claude-code")
    expect(
      lines
        .map((line) => parse(line))
        .at(-1)
        ?.messages.map((message) => message.text),
    ).toEqual(["Not logged in · Please run /login"])
    expect(lines.map((line) => agentTurnFinished("claude-code", line)).filter(Boolean)).toEqual(["failure"])
    const outcome = agentOutcome(
      "claude-code",
      1,
      lines.map((line) => `[stdout] ${line}`),
    )
    expect(outcome.exitCode).toBe(1)
    expect(outcome.error).toContain("not signed in")
    // The agent's own login command, which exits when sign-in is done.
    expect(outcome.error).toContain("`claude auth login`")
  })

  test("only each protocol's own final event ends a turn", () => {
    // Codex also prints top-level errors it recovers from, such as a reconnect
    // notice, so only turn.completed and turn.failed end its turn.
    expect(agentTurnFinished("codex", '{"type":"error","message":"Reconnecting... 1/5"}')).toBeUndefined()
    expect(agentTurnFinished("codex", '{"type":"turn.failed","error":{"message":"boom"}}')).toBe("failure")
    expect(agentTurnFinished("codex", '{"type":"result","result":"not codex"}')).toBeUndefined()
    expect(agentTurnFinished("cursor", '{"type":"result","is_error":true,"result":"x"}')).toBe("failure")
    expect(agentTurnFinished("cursor", '{"type":"turn.completed"}')).toBeUndefined()
    expect(agentTurnFinished("claude-code", '[stdout] {"type":"result","result":"x"}')).toBe("success")
    expect(agentTurnFinished("claude-code", "result")).toBeUndefined()
  })

  test("a codex turn.failed reports codex's own message", () => {
    const outcome = agentOutcome("codex", 1, [
      '[stdout] {"type":"turn.failed","error":{"message":"stream disconnected before completion"}}',
    ])
    expect(outcome).toEqual({ exitCode: 1, error: "stream disconnected before completion" })
  })

  test("edit calls name the workspace file they change, never its contents", () => {
    const workspace = join(root, "follow-workspace")
    const claude = createAgentChat("claude-code", [workspace])
    const claudeChat = claude(
      JSON.stringify({
        type: "assistant",
        uuid: "edit-block",
        message: {
          id: "msg",
          content: [
            {
              type: "tool_use",
              id: "edit",
              name: "Edit",
              input: {
                file_path: join(workspace, "src", "a.ts"),
                old_string: "PRIVATE OLD",
                new_string: "PRIVATE NEW",
              },
            },
            {
              type: "tool_use",
              id: "notebook",
              name: "NotebookEdit",
              input: { notebook_path: join(workspace, "n.ipynb"), new_source: "PRIVATE" },
            },
            { type: "tool_use", id: "outside", name: "Write", input: { file_path: "/etc/hosts", content: "PRIVATE" } },
            { type: "tool_use", id: "read", name: "Read", input: { file_path: join(workspace, "README.md") } },
          ],
        },
      }),
    )
    expect(claudeChat.activity.map((entry) => [entry.id, entry.files])).toEqual([
      ["edit", ["src/a.ts"]],
      ["notebook", ["n.ipynb"]],
      ["outside", undefined],
      ["read", undefined],
    ])

    const codex = createAgentChat("codex", [workspace])
    const change = (path: string) => ({ path, kind: "update" })
    codex(
      JSON.stringify({
        type: "item.started",
        item: {
          id: "patch",
          type: "file_change",
          changes: [change(join(workspace, "src", "b.ts"))],
          status: "in_progress",
        },
      }),
    )
    const codexChat = codex(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "patch",
          type: "file_change",
          changes: [change(join(workspace, "src", "b.ts")), change(join(workspace, "..", "escape.ts"))],
          status: "completed",
        },
      }),
    )
    expect(codexChat.activity).toEqual([
      { id: "patch", label: "Updating files", kind: "tool", state: "done", files: ["src/b.ts"] },
    ])

    const cursor = createAgentChat("cursor", [workspace])
    const call = (id: string, subtype: string, tool_call: object) =>
      cursor(JSON.stringify({ type: "tool_call", subtype, call_id: id, tool_call, session_id: sessionId }))
    call("write", "started", { writeToolCall: { args: { path: "summary.txt", fileText: "PRIVATE" } } })
    call("edit", "started", {
      editToolCall: { args: { path: join(workspace, "src", "c.ts"), streamContent: "PRIVATE" } },
    })
    call("generic", "started", {
      function: { name: "edit_file", arguments: JSON.stringify({ target_file: "../outside.ts", code: "PRIVATE" }) },
    })
    call("read", "started", { readToolCall: { args: { path: "README.md" } } })
    const cursorChat = call("write", "completed", {
      writeToolCall: {
        args: { path: "summary.txt" },
        result: { success: { path: join(workspace, "summary.txt"), linesCreated: 1 } },
      },
    })
    expect(cursorChat.activity.map((entry) => [entry.id, entry.state, entry.files])).toEqual([
      ["write", "done", ["summary.txt"]],
      ["edit", "running", ["src/c.ts"]],
      ["generic", "running", undefined],
      ["read", "running", undefined],
    ])
    expect(JSON.stringify([claudeChat, codexChat, cursorChat])).not.toContain("PRIVATE")
  })
})

describe("finishing a turn on the protocol's final event", () => {
  async function fakeCli(name: string, cli: string, body: string) {
    const directory = join(root, "finish", name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, cli), `#!/bin/sh\n${body}\n`)
    await chmod(join(directory, cli), 0o755)
    return { directory, env: { HOME: root, PATH: `${directory}:/usr/bin:/bin` } }
  }

  // Measured from the final event, not from spawn: the first exec of a fresh
  // script can be slow on CI, which is what made the Cursor test above flaky.
  // `sleep 30` would hold the run for 30 s if it still waited for the exit.
  const finalEventClock = () => {
    let at = 0
    return {
      onEvent: (event: { stream: string; text: string }) => {
        if (at || event.stream !== "stdout") return
        if (/"type":"(?:turn\.completed|turn\.failed|result)"/.test(event.text)) at = Date.now()
      },
      sinceFinal: () => (at ? Date.now() - at : Number.POSITIVE_INFINITY),
    }
  }

  test("a codex turn that lingers after turn.completed resolves on the event, and the CLI is gone", async () => {
    const { directory, env } = await fakeCli(
      "codex-linger",
      "codex",
      `echo $$ > pid\n${printLines(captured.codex)}\nsleep 30`,
    )
    const clock = finalEventClock()
    const chats: ReturnType<ReturnType<typeof createAgentChat>>[] = []
    const result = await runExternalCodingAgent({
      runtime: "codex",
      cwd: directory,
      prompt: "fixture only",
      env,
      finishGraceMs: 50,
      killGraceMs: 50,
      onEvent: clock.onEvent,
      onChat: (chat) => chats.push(chat),
    })
    expect(clock.sinceFinal()).toBeLessThan(5_000)
    expect(result.exitCode).toBe(0)
    expect(result.error).toBeUndefined()
    expect(result.summary).toBe("OK")
    expect(result.sessionId).toBe("01a09712-e58b-73a1-b808-3287c1c0ab54")
    expect(chats.at(-1)?.messages).toEqual([{ id: "item_0", text: "OK" }])
    const firstText = chats.findIndex((chat) => chat.messages.length > 0)
    expect(
      chats
        .slice(0, firstText)
        .some((chat) => chat.activity.some((entry) => entry.label === "Thinking" && entry.state === "running")),
    ).toBe(true)
    // The run resolves only on close, after Node has reaped the CLI.
    const pid = Number((await Bun.file(join(directory, "pid")).text()).trim())
    expect(() => process.kill(pid, 0)).toThrow()
  }, 20_000)

  test("pi's chat run starts without ANTHROPIC_OAUTH_TOKEN, by any spelling, and keeps the rest of the environment", async () => {
    // The fake records only whether each variable is set, never its value.
    const { directory, env } = await fakeCli(
      "pi-env",
      "pi",
      [
        `case "$1" in --version) echo "0.74.1"; exit 0;; esac`,
        `for name in ANTHROPIC_OAUTH_TOKEN anthropic_oauth_token ANTHROPIC_API_KEY FIXTURE_KEEP; do`,
        `  printenv "$name" > /dev/null && echo "$name" >> seen`,
        `done`,
        printLines([
          { type: "session", id: "pi-session" },
          { type: "agent_settled", aborted: false },
        ]),
      ].join("\n"),
    )
    const result = await runExternalCodingAgent({
      runtime: "pi",
      cwd: directory,
      prompt: "fixture only",
      env: {
        ...env,
        ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-fixture",
        anthropic_oauth_token: "sk-ant-oat-fixture",
        ANTHROPIC_API_KEY: "fixture-api-key",
        FIXTURE_KEEP: "1",
      },
      finishGraceMs: 50,
      killGraceMs: 50,
    })
    expect(result.exitCode).toBe(0)
    expect((await Bun.file(join(directory, "seen")).text()).trim().split("\n")).toEqual([
      "ANTHROPIC_API_KEY",
      "FIXTURE_KEEP",
    ])
  }, 20_000)

  test("a codex turn.failed ends the run as a failure with codex's own message", async () => {
    const { env } = await fakeCli(
      "codex-failed",
      "codex",
      `${printLines([
        { type: "thread.started", thread_id: "t-failed" },
        { type: "turn.started" },
        { type: "turn.failed", error: { message: "stream disconnected before completion: fixture outage" } },
      ])}\nsleep 30`,
    )
    const clock = finalEventClock()
    const result = await runExternalCodingAgent({
      runtime: "codex",
      cwd: root,
      prompt: "fixture only",
      env,
      finishGraceMs: 50,
      killGraceMs: 50,
      onEvent: clock.onEvent,
    })
    expect(clock.sinceFinal()).toBeLessThan(5_000)
    expect(result.exitCode).toBe(1)
    expect(result.error).toBe("stream disconnected before completion: fixture outage")
  }, 20_000)

  test("a cursor error result ends the run as a failure with its message", async () => {
    const { env } = await fakeCli(
      "cursor-failed",
      "cursor-agent",
      `${printLines([
        { type: "system", subtype: "init", session_id: sessionId },
        { type: "result", subtype: "error", is_error: true, result: "fixture quota exceeded", session_id: sessionId },
      ])}\nsleep 30`,
    )
    const clock = finalEventClock()
    const result = await runExternalCodingAgent({
      runtime: "cursor",
      cwd: root,
      prompt: "fixture only",
      env,
      finishGraceMs: 50,
      killGraceMs: 50,
      onEvent: clock.onEvent,
    })
    expect(clock.sinceFinal()).toBeLessThan(5_000)
    expect(result.exitCode).toBe(1)
    expect(result.error).toBe("fixture quota exceeded")
  }, 20_000)

  test("output the CLI prints while it is being stopped is still drained, and that stop is not a failure", async () => {
    // The TERM trap writes only after Vector signals the finished CLI, so this
    // line exists only if stdout and stderr are read until close. It also exits
    // 143, which must not turn a successful turn into a failed one.
    const { env } = await fakeCli(
      "claude-drain",
      "claude",
      [
        `trap 'printf "%s\\n" "late diagnostics" >&2; exit 143' TERM`,
        printLines([
          { type: "system", subtype: "init", session_id: "c1" },
          { type: "result", subtype: "success", is_error: false, result: "Done", session_id: "c1" },
        ]),
        "sleep 30",
      ].join("\n"),
    )
    const result = await runExternalCodingAgent({
      runtime: "claude-code",
      cwd: root,
      prompt: "fixture only",
      env,
      finishGraceMs: 50,
      killGraceMs: 5_000,
    })
    expect(result.exitCode).toBe(0)
    expect(result.summary).toBe("Done")
    expect(result.output).toContain("[stderr] late diagnostics")
  }, 20_000)

  test("the captured signed-out Claude Code run fails with sign-in guidance", async () => {
    const { env } = await fakeCli("claude-signed-out", "claude", `${printLines(captured.claudeSignedOut)}\nexit 1`)
    const result = await runExternalCodingAgent({ runtime: "claude-code", cwd: root, prompt: "fixture only", env })
    expect(result.exitCode).toBe(1)
    expect(result.error).toContain("Claude Code is installed but not signed in")
    expect(result.sessionId).toBe("4235e1e7-0234-49f4-83e0-9c8cc827c840")
  }, 20_000)
})

describe("external agent resolution", () => {
  test("a CLI invisible under the bare GUI PATH is found once its directory is on PATH", async () => {
    const path = await installFakeCli(join(root, "opt", "toolbox", "bin"), "faux-agent")
    // What a Finder-launched macOS app inherits.
    const guiEnvironment = { HOME: root, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }

    expect(await resolveAgentPath("faux-agent", guiEnvironment, "darwin")).toBeUndefined()
    expect(
      await resolveAgentPath(
        "faux-agent",
        { ...guiEnvironment, PATH: `${join(root, "opt", "toolbox", "bin")}:/bin` },
        "darwin",
      ),
    ).toBe(path)
  })

  test("finds a CLI installed under a version manager that is off PATH", async () => {
    const nvm = await installFakeCli(join(root, ".nvm", "versions", "node", "v22.14.0", "bin"), "nvm-agent")
    const mise = await installFakeCli(join(root, ".local", "share", "mise", "shims"), "mise-agent")
    const pnpm = await installFakeCli(join(root, "Library", "pnpm"), "pnpm-agent")
    const environment = { HOME: root, PATH: "/usr/bin:/bin" }

    expect(await resolveAgentPath("nvm-agent", environment, "darwin")).toBe(nvm)
    expect(await resolveAgentPath("mise-agent", environment, "darwin")).toBe(mise)
    expect(await resolveAgentPath("pnpm-agent", environment, "darwin")).toBe(pnpm)
  })

  test("a missing CLI resolves to undefined instead of throwing", async () => {
    expect(
      await resolveAgentPath("vector-agent-that-does-not-exist", { HOME: root, PATH: root }, "darwin"),
    ).toBeUndefined()
  })

  test("a non-executable file with the right name is not a CLI", async () => {
    const directory = join(root, "not-executable")
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "inert-agent"), "not executable\n")
    await chmod(join(directory, "inert-agent"), 0o644)

    expect(await resolveAgentPath("inert-agent", { HOME: root, PATH: directory }, "darwin")).toBeUndefined()
  })

  test("Windows candidates cover the .cmd/.exe/.ps1 shims npm installs", async () => {
    const paths = (
      await agentCandidatePaths(
        "claude",
        {
          USERPROFILE: "C:\\Users\\dev",
          APPDATA: "C:\\Users\\dev\\AppData\\Roaming",
          LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
          PATH: "C:\\Windows\\System32;C:\\Users\\dev\\tools",
        },
        "win32",
      )
    ).map((path) => path.replace(/\\/g, "/"))

    expect(paths.some((path) => path.endsWith("AppData/Roaming/npm/claude.cmd"))).toBe(true)
    expect(paths.some((path) => path.endsWith("AppData/Roaming/npm/claude.exe"))).toBe(true)
    expect(paths.some((path) => path.endsWith("AppData/Roaming/npm/claude.ps1"))).toBe(true)
    // The Windows PATH is split on ";", not the host platform's separator.
    expect(paths.some((path) => path.endsWith("C:/Windows/System32/claude.exe"))).toBe(true)
    expect(paths.some((path) => path.endsWith("C:/Users/dev/tools/claude.cmd"))).toBe(true)
    expect(paths.some((path) => path.endsWith("AppData/Local/Volta/bin/claude.exe"))).toBe(true)
  })

  test("a directory named like the CLI is not mistaken for the CLI", async () => {
    // access(X_OK) succeeds on directories, so a folder called `code` sitting on
    // PATH would be reported installed and then fail to spawn.
    const bin = join(root, "shadow", "bin")
    await mkdir(join(bin, "code"), { recursive: true })

    expect(await resolveAgentPath("code", { HOME: root, PATH: bin }, "darwin")).toBeUndefined()
  })

  test("a real CLI still wins when a same-named directory is searched first", async () => {
    const shadow = join(root, "shadow-order", "first")
    await mkdir(join(shadow, "shadowed-agent"), { recursive: true })
    const real = await installFakeCli(join(root, "shadow-order", "second"), "shadowed-agent")

    expect(
      await resolveAgentPath(
        "shadowed-agent",
        { HOME: root, PATH: `${shadow}:${join(root, "shadow-order", "second")}` },
        "darwin",
      ),
    ).toBe(real)
  })

  test("Cursor's bundled `code` does not answer for VS Code", async () => {
    // Cursor ships `code` and `cursor` in the same bundle directory. Only the
    // `code` lookup must skip it, or a Cursor-only machine reports VS Code
    // installed at Cursor's version.
    const paths = await agentCandidatePaths("code", { HOME: root, PATH: "/usr/bin" }, "darwin")
    expect(paths.some((path) => path.includes("Cursor.app"))).toBe(false)
    expect(paths).toContain("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")

    const cursor = await agentCandidatePaths("cursor", { HOME: root, PATH: "/usr/bin" }, "darwin")
    expect(cursor).toContain("/Applications/Cursor.app/Contents/Resources/app/bin/cursor")
  })

  test("executable names prefer what Node can spawn directly", () => {
    expect(executableNames("claude", "win32")).toEqual([
      "claude.exe",
      "claude.cmd",
      "claude.bat",
      "claude.ps1",
      "claude",
    ])
    expect(executableNames("claude", "darwin")).toEqual(["claude"])
  })
})

describe("agent environment", () => {
  test("the login shell is probed once and its PATH is unioned with the app's", () => {
    const first = agentEnvironment()
    const second = agentEnvironment()

    // Same object: detectExternalAgents runs on every renderer re-render, and
    // loadShellEnv blocks the main process while the login shell starts.
    expect(second).toBe(first)
    const resolved = (first.PATH ?? "").split(":")
    for (const directory of (process.env.PATH ?? "").split(":").filter(Boolean)) {
      expect(resolved).toContain(directory)
    }
  })
})

describe("launching a resolved CLI", () => {
  test("a Windows .cmd shim goes through cmd.exe, which is what Node can run", () => {
    const launch = shimmedCommand("C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd", ["-p", 'say "hi"'], "win32")

    expect(launch.command.toLowerCase()).toContain("cmd.exe")
    expect(launch.windowsVerbatimArguments).toBe(true)
    // Verbatim arguments mean cmd.exe sees exactly this string, so the embedded
    // quotes of a prompt have to be doubled rather than escaped.
    expect(launch.args).toEqual([
      "/d",
      "/s",
      "/c",
      '""C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd" "-p" "say ""hi""""',
    ])
  })

  test("everything Node can spawn itself is left alone", () => {
    expect(shimmedCommand("C:\\Users\\dev\\.local\\bin\\claude.exe", ["-p", "hi"], "win32")).toEqual({
      command: "C:\\Users\\dev\\.local\\bin\\claude.exe",
      args: ["-p", "hi"],
      windowsVerbatimArguments: false,
    })
    expect(shimmedCommand("/Users/dev/.local/bin/claude", ["-p", "hi"], "darwin")).toEqual({
      command: "/Users/dev/.local/bin/claude",
      args: ["-p", "hi"],
      windowsVerbatimArguments: false,
    })
  })

  test("only a Windows .cmd or .bat file needs cmd.exe", () => {
    expect(runsThroughCmd("C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.CMD", "win32")).toBe(true)
    expect(runsThroughCmd("C:\\Program Files\\nodejs\\npx.bat", "win32")).toBe(true)
    expect(runsThroughCmd("C:\\Users\\dev\\.local\\bin\\claude.exe", "win32")).toBe(false)
    expect(runsThroughCmd("/usr/local/bin/claude.cmd", "darwin")).toBe(false)
  })

  // Node throws a spawn it refuses (EINVAL for a .cmd, EFTYPE for a .ps1 on Windows) synchronously. Detection probed
  // VS Code's code.cmd that way, the throw rejected the whole detection, and the renderer retried it in a loop.
  test("a probe whose spawn throws is a failed run, not an exception", async () => {
    const result = await runCli("/bin/echo", ["not\0valid"], 1_000)
    expect(result.failed).toBe(true)
  })

  // cmd.exe ends the command line at the first line feed, even inside quotes. Through claude.cmd the multi-line
  // Parallel Workspace prompt arrived cut to its first line, without --output-format or --permission-mode.
  test("through a Windows .cmd shim, Claude Code and Codex take the prompt on stdin", () => {
    const prompt = "You are Vector's Parallel Workspace engineering agent.\n\nTask:\nFix %PATH% handling"
    const shim = "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd"
    for (const resume of [undefined, "sid-4"]) {
      const claude = runtimeArguments("claude-code", "C:\\w", prompt, resume, true)
      expect(claude).not.toContain(prompt)
      expect(claude[claude.indexOf("-p") + 1]).toBe("--output-format")
      expect(claude).toContain("stream-json")
      expect(claude[claude.indexOf("--permission-mode") + 1]).toBe("acceptEdits")
      if (resume) expect(claude[claude.indexOf("--resume") + 1]).toBe(resume)

      const codex = runtimeArguments("codex", "C:\\w", prompt, resume, true)
      expect(codex).not.toContain(prompt)
      expect(codex.at(-1)).toBe("-")

      for (const args of [claude, codex]) {
        expect(shimmedCommand(shim, args, "win32").args.join(" ")).not.toMatch(/[\r\n%]/)
      }
    }
  })

  test("Windows process cleanup always targets the entire child tree", () => {
    expect(windowsTaskkillArguments(42, false)).toEqual(["/pid", "42", "/T"])
    expect(windowsTaskkillArguments(42, true)).toEqual(["/pid", "42", "/T", "/F"])
  })
})

describe("external agent run outcome", () => {
  // Real Claude Code 2.1.215 output: it exits 0 and reports the failure in the
  // result event, so the exit code alone says the run succeeded.
  const notLoggedIn =
    '[stdout] {"type":"result","subtype":"success","is_error":true,"duration_ms":91,"num_turns":0,"result":"Not logged in · Please run /login","session_id":"a1","total_cost_usd":0}'

  test("is_error in the result event is a failure even when the CLI exits 0", () => {
    const outcome = agentOutcome("claude-code", 0, [
      '[stdout] {"type":"result","subtype":"success","is_error":true,"result":"Tool use was denied by the user"}',
    ])

    expect(outcome.exitCode).toBe(1)
    expect(outcome.error).toBe("Tool use was denied by the user")
  })

  test("an authentication failure names the sign-in command", () => {
    const outcome = agentOutcome("claude-code", 0, [notLoggedIn])

    expect(outcome.exitCode).toBe(1)
    expect(outcome.error).toContain("not signed in")
    expect(outcome.error).toContain("Not logged in · Please run /login")
    // The agent's own login command, which exits when sign-in is done.
    expect(outcome.error).toContain("`claude auth login`")
    expect(outcome.error).not.toContain("not installed")
  })

  test("a signed-out CLI that only writes to stderr still names the sign-in command", () => {
    const outcome = agentOutcome("cursor", 1, ["[stderr] Error: Unauthorized. Run cursor-agent login to continue."])

    expect(outcome.exitCode).toBe(1)
    expect(outcome.error).toContain("`cursor-agent login`")
  })

  test("codex sign-in guidance uses the Codex command", () => {
    const outcome = agentOutcome("codex", 1, ['[stderr] {"type":"error","is_error":true,"message":"Not logged in"}'])

    expect(outcome.error).toContain("`codex login`")
  })

  test("a clean run stays a success and a plain crash keeps its exit code", () => {
    expect(
      agentOutcome("claude-code", 0, [
        '[stdout] {"type":"result","subtype":"success","is_error":false,"result":"Done"}',
      ]),
    ).toEqual({
      exitCode: 0,
    })

    const crashed = agentOutcome("claude-code", 2, ["[stderr] TypeError: cannot read property of undefined"])
    expect(crashed.exitCode).toBe(2)
    expect(crashed.error).toBe("Claude Code exited with code 2.")
  })

  test("a tool call that failed mid-run does not fail the whole run", () => {
    // Claude Code puts a failed tool's is_error inside message.content[], not at
    // the top level of the event — only the final result event speaks for the
    // run. Matching is_error anywhere would fail every run containing a grep
    // that found nothing.
    const outcome = agentOutcome("claude-code", 0, [
      '[stdout] {"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"No files found","is_error":true}]},"parent_tool_use_id":null,"session_id":"a1"}',
      '[stdout] {"type":"result","subtype":"success","is_error":false,"result":"Renamed the helper","total_cost_usd":0.03}',
    ])

    expect(outcome).toEqual({ exitCode: 0 })
  })

  test("a normal edit that mentions unauthorized is not mistaken for a sign-out", () => {
    const outcome = agentOutcome("claude-code", 0, [
      '[stdout] {"type":"assistant","message":{"content":"Added a 401 Unauthorized branch to the router"}}',
      '[stdout] {"type":"result","subtype":"success","is_error":false,"result":"Added the branch"}',
    ])

    expect(outcome).toEqual({ exitCode: 0 })
  })
})

describe("external agent resume argv", () => {
  // The regression lock that protects the one path verified working end to end:
  // a fresh Codex run. Any drift here changes what every first turn spawns.
  test("fresh argv is unchanged for every runtime when there is no session to resume", () => {
    expect(runtimeArguments("codex", "/w", "do it")).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/w",
      "do it",
    ])
    expect(runtimeArguments("claude-code", "/w", "do it")).toEqual([
      "-p",
      "do it",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "acceptEdits",
    ])
    expect(runtimeArguments("cursor", "/w", "do it")).toEqual([
      "-p",
      "--trust",
      "--force",
      "--output-format",
      "stream-json",
      "do it",
    ])
  })

  test("codex resume drops --sandbox and -C, and puts options before the session id", () => {
    const args = runtimeArguments("codex", "/w", "next", "sid-1")
    expect(args).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="workspace-write"',
      "sid-1",
      "next",
    ])
    // `codex exec resume` rejects both outright rather than ignoring them.
    expect(args).not.toContain("--sandbox")
    expect(args).not.toContain("-C")
    expect(args.indexOf("sid-1")).toBeGreaterThan(args.indexOf("--skip-git-repo-check"))
    expect(args.at(-1)).toBe("next")
  })

  test("claude --resume is followed immediately by the id so it cannot swallow the prompt", () => {
    const args = runtimeArguments("claude-code", "/w", "next", "sid-2")
    // --resume takes an OPTIONAL value: any gap and it consumes the prompt and
    // opens the interactive picker instead of running headless.
    expect(args[args.indexOf("--resume") + 1]).toBe("sid-2")
    expect(args).toContain("-p")
    expect(args[args.indexOf("-p") + 1]).toBe("next")
  })

  test("cursor resume carries the previous chat id and trust flag", () => {
    const args = runtimeArguments("cursor", "/w", "next", "sid-3")
    expect(args[args.indexOf("--resume") + 1]).toBe("sid-3")
    expect(args).toContain("--trust")
    expect(args.at(-1)).toBe("next")
  })
})

describe("session id extraction", () => {
  test("reads the id each runtime actually emits", () => {
    expect(sessionFromAgentLine('{"type":"thread.started","thread_id":"t1"}')).toBe("t1")
    expect(sessionFromAgentLine('{"type":"system","subtype":"init","session_id":"a1"}')).toBe("a1")
    expect(sessionFromAgentLine('[stdout] {"type":"thread.started","thread_id":"t2"}')).toBe("t2")
    expect(sessionFromAgentLine('[stdout] {"type":"system","subtype":"init","session_id":"a2"}')).toBe("a2")
  })

  test("ignores non-JSON banners and nested ids", () => {
    expect(sessionFromAgentLine("Reading additional input from stdin...")).toBeUndefined()
    // Top-level only: a nested id is a different protocol version, and guessing
    // at it would resume the wrong conversation.
    expect(sessionFromAgentLine('{"msg":{"session_id":"x"}}')).toBeUndefined()
  })

  test("survives secret redaction of a sibling field", () => {
    // redactAgentOutput rewrites the authorization value in place; the id must
    // still parse out of the line afterwards.
    expect(sessionFromAgentLine('{"session_id":"keep-me","authorization":"[redacted]"}')).toBe("keep-me")
  })
})

describe("capturing a session id from a live run", () => {
  async function installStreamingCli(name: string, body: string) {
    const directory = join(root, "stream", name)
    await mkdir(directory, { recursive: true })
    const path = join(directory, name)
    await writeFile(path, body)
    await chmod(path, 0o755)
    return directory
  }

  test("the id survives even after the 240-line output ring has evicted it", async () => {
    // The exact production failure a post-hoc scan of result.output would ship:
    // codex emits thread.started once, on line 1, and every real run is longer
    // than the ring.
    const directory = await installStreamingCli(
      "codex",
      '#!/bin/sh\necho \'{"type":"thread.started","thread_id":"first"}\'\ni=0\nwhile [ $i -lt 400 ]; do echo \'{"type":"item.completed"}\'; i=$((i+1)); done\n',
    )
    const result = await runExternalCodingAgent({
      runtime: "codex",
      cwd: root,
      prompt: "go",
      env: { HOME: root, PATH: `${directory}:/usr/bin:/bin` },
    })
    expect(result.sessionId).toBe("first")
    expect(result.output.length).toBe(240)
  })

  test("the first id wins and onSessionId fires exactly once", async () => {
    const directory = await installStreamingCli(
      "codex",
      '#!/bin/sh\necho \'{"session_id":"one"}\'\necho \'{"session_id":"two"}\'\n',
    )
    const seen: string[] = []
    const result = await runExternalCodingAgent({
      runtime: "codex",
      cwd: root,
      prompt: "go",
      env: { HOME: root, PATH: `${directory}:/usr/bin:/bin` },
      onSessionId: (id) => seen.push(id),
    })
    expect(result.sessionId).toBe("one")
    expect(seen).toEqual(["one"])
  })

  test("a refused resume is reported as resumeRejected, not as a failed task", async () => {
    const directory = await installStreamingCli(
      "codex",
      "#!/bin/sh\necho \"error: unexpected argument '--resume' found\" >&2\nexit 2\n",
    )
    const env = { HOME: root, PATH: `${directory}:/usr/bin:/bin` }
    const refused = await runExternalCodingAgent({
      runtime: "codex",
      cwd: root,
      prompt: "go",
      resumeSessionId: "sid",
      env,
    })
    expect(refused.resumeRejected).toBe(true)
    // Without a resume id the same output is an ordinary failure: an "unknown
    // option" inside agent output must never downgrade a working conversation.
    const plain = await runExternalCodingAgent({ runtime: "codex", cwd: root, prompt: "go", env })
    expect(plain.resumeRejected).toBeFalsy()
  })

  test("a wedged CLI is force-killed after the run timeout", async () => {
    const directory = await installStreamingCli("codex", "#!/bin/sh\ntrap '' TERM\nwhile true; do sleep 1; done\n")
    const startedAt = Date.now()
    const result = await runExternalCodingAgent({
      runtime: "codex",
      cwd: root,
      prompt: "go",
      env: { HOME: root, PATH: `${directory}:/usr/bin:/bin` },
      timeoutMs: 30,
      killGraceMs: 30,
    })
    expect(result.exitCode).toBe(124)
    expect(result.error).toContain("run limit")
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })
})

describe("reading sign-in state from an auth probe", () => {
  test("claude auth status reports through its JSON flag", () => {
    expect(signedInFromProbe('{\n  "loggedIn": false,\n  "authMethod": "none"\n}')).toBe(false)
    expect(signedInFromProbe('{\n  "loggedIn": true,\n  "authMethod": "oauth"\n}')).toBe(true)
  })

  test("codex login status reports through its sentence", () => {
    expect(signedInFromProbe("Logged in using ChatGPT")).toBe(true)
    // The negative test has to win: "not logged in" contains "logged in".
    expect(signedInFromProbe("Not logged in")).toBe(false)
    expect(signedInFromProbe("Not logged in · Please run /login")).toBe(false)
  })

  test("cursor status reports its verified authentication state", () => {
    expect(signedInFromProbe("✓ Logged in as developer@example.com")).toBe(true)
    expect(signedInFromProbe("Not logged in")).toBe(false)
  })

  test("an unreadable probe is unknown rather than signed out", () => {
    // A picker that wrongly claims a working CLI is signed out is worse than one
    // that says nothing, so anything unrecognised stays undefined.
    expect(signedInFromProbe("")).toBeUndefined()
    expect(signedInFromProbe("some unrelated banner text")).toBeUndefined()
  })
})

describe("external agent detection through the env seam", () => {
  // Every agent is looked up in a fake HOME and a PATH of one fake folder. An injected environment never searches the
  // machine's own folders (/opt/homebrew/bin, /usr/local/bin and the rest), so no real CLI on the test host is ever
  // spawned and no real account is ever probed. The fakes use shell built-ins only, so they need nothing else on PATH.
  async function fakeAgents(name: string, scripts: Record<string, string>) {
    const directory = join(root, "detect", name)
    await mkdir(directory, { recursive: true })
    for (const [cli, body] of Object.entries(scripts)) {
      await writeFile(join(directory, cli), `#!/bin/sh\n${body}\n`)
      await chmod(join(directory, cli), 0o755)
    }
    return { directory, env: { HOME: join(root, "detect", `${name}-home`), PATH: directory } }
  }
  // What detection found sits in the fake folder, whatever the test host has installed.
  const onlyFakes = (agents: Awaited<ReturnType<typeof detectExternalAgents>>, directory: string) => {
    for (const agent of agents.filter((agent) => agent.path))
      expect({ id: agent.id, inside: agent.path!.startsWith(`${directory}/`) }).toEqual({ id: agent.id, inside: true })
  }

  test("an injected environment searches only its own PATH and HOME, never the machine's folders", async () => {
    const env = { HOME: join(root, "detect", "machine-home"), PATH: join(root, "detect", "machine-path") }
    for (const platform of ["darwin", "linux"] as const) {
      const machine = await agentCandidatePaths("codex", env, platform)
      const injected = await agentCandidatePaths("codex", env, platform, false)
      expect(machine).toContain("/opt/homebrew/bin/codex")
      for (const path of injected)
        expect({ path, inside: path.startsWith(`${env.HOME}/`) || path.startsWith(`${env.PATH}/`) }).toEqual({
          path,
          inside: true,
        })
      expect(injected).toContain(join(env.HOME, ".local", "bin", "codex"))
    }
    expect(await agentCandidatePaths("codex", env, "darwin")).toContain(
      "/Applications/ChatGPT.app/Contents/Resources/codex",
    )
    // Without a HOME of its own, an injected environment has only its PATH.
    expect(await agentCandidatePaths("codex", { PATH: env.PATH }, "linux", false)).toEqual([join(env.PATH, "codex")])
  })

  test("reports every catalog agent in order, then VS Code, without throwing", async () => {
    const { directory, env } = await fakeAgents("none", {})
    const agents = await detectExternalAgents({ env, platform: "linux" })
    onlyFakes(agents, directory)
    expect(agents.map((agent) => agent.id)).toEqual([...ExternalAgent.catalog.map((agent) => agent.id), "vscode"])
    for (const agent of agents) {
      expect(agent).toMatchObject({ installed: false, state: "not-installed" })
      expect(agent.path).toBeUndefined()
      expect(agent.version).toBeUndefined()
    }
  })

  test("a status probe decides ready or signed out, and an agent without one stays unknown", async () => {
    const { directory, env } = await fakeAgents("states", {
      claude: `case "$1" in --version) echo "2.1.215 (Claude Code)";; auth) echo '{"loggedIn": false, "authMethod": "none"}'; exit 1;; esac`,
      codex: `case "$1" in --version) echo "codex-cli 0.164.0";; login) echo "Logged in using ChatGPT";; esac`,
      kilo: `case "$1" in --version) echo "7.8.17";; auth) printf 'Credentials\\n\\n0 credentials\\n';; esac`,
      // Any call other than --version leaves a mark: Gemini CLI documents no status command, so none may run.
      gemini: `[ "$1" = "--version" ] && echo "0.65.0" && exit 0; : > "${join(root, "detect", "gemini-probed")}"`,
    })
    const agents = await detectExternalAgents({ env, platform: "linux" })
    onlyFakes(agents, directory)
    const by = (id: string) => agents.find((agent) => agent.id === id)!
    expect(by("claude-code")).toMatchObject({ state: "signed-out", signedIn: false, version: "2.1.215 (Claude Code)" })
    expect(by("claude-code").path).toBe(join(directory, "claude"))
    expect(by("codex")).toMatchObject({ state: "ready", signedIn: true, tier: "chat" })
    expect(by("kilo")).toMatchObject({ state: "signed-out", signedIn: false, tier: "terminal" })
    expect(by("gemini")).toMatchObject({ state: "unknown", installed: true, version: "0.65.0" })
    expect(by("gemini").signedIn).toBeUndefined()
    expect(await Bun.file(join(root, "detect", "gemini-probed")).exists()).toBe(false)
  })

  test("Cursor's generic `agent` counts only with Cursor's own version", async () => {
    const cursor = await fakeAgents("cursor-agent-name", {
      agent: `case "$1" in --version) echo "2026.09.02-c22c1a3";; status) echo "✓ Logged in as developer@example.com";; esac`,
    })
    expect(
      (await detectExternalAgents({ env: cursor.env, platform: "linux" })).find((a) => a.id === "cursor"),
    ).toMatchObject({ state: "ready", cli: "agent", path: join(cursor.directory, "agent") })
    const other = await fakeAgents("other-agent-name", { agent: `echo "agent 1.4.0"` })
    expect(
      (await detectExternalAgents({ env: other.env, platform: "linux" })).find((a) => a.id === "cursor"),
    ).toMatchObject({ state: "not-installed", installed: false })
  })

  test("the database migration tool that is also called goose is not the goose agent", async () => {
    const migrations = await fakeAgents("pressly-goose", { goose: `echo "goose version: v3.24.1"` })
    expect(
      (await detectExternalAgents({ env: migrations.env, platform: "linux" })).find((a) => a.id === "goose")?.state,
    ).toBe("not-installed")
    const agent = await fakeAgents("block-goose", { goose: `echo "1.9.0"` })
    expect(
      (await detectExternalAgents({ env: agent.env, platform: "linux" })).find((a) => a.id === "goose")?.state,
    ).toBe("unknown")
  })

  test("a terminal-only agent never reaches a headless spawn", async () => {
    const { env } = await fakeAgents("terminal-only", { kilo: `echo should-not-run` })
    await expect(runExternalCodingAgent({ runtime: "kilo" as never, cwd: root, prompt: "x", env })).rejects.toThrow(
      "runs in Vector's terminal only",
    )
  })
})

describe("reading sign-in state from a credential total", () => {
  test("only the total is read, and keys from the environment keep it unknown", () => {
    expect(signedInFromCredentialCount("Credentials\n  Anthropic oauth\n\n1 credentials")).toBe(true)
    expect(signedInFromCredentialCount("Credentials\n\n0 credentials")).toBe(false)
    expect(signedInFromCredentialCount("0 credentials\nEnvironment\n  OpenAI\n1 environment variable")).toBeUndefined()
    expect(signedInFromCredentialCount("")).toBeUndefined()
    expect(signedInFromCredentialCount("unrelated banner")).toBeUndefined()
  })
})

describe("listing an agent's models through the desktop", () => {
  async function fakeCli(name: string, cli: string, body: string) {
    const directory = join(root, "models", name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, cli), `#!/bin/sh\n${body}\n`)
    await chmod(join(directory, cli), 0o755)
    return { HOME: join(root, "models", `${name}-home`), PATH: `${directory}:/usr/bin:/bin` }
  }

  test("Cursor's own listing becomes rows, without colour codes or its current/default marks", async () => {
    // The shape cursor-agent 2026.09.02 prints for `agent models`, colour codes included.
    const env = await fakeCli(
      "cursor-live",
      "cursor-agent",
      `[ "$1" = models ] || exit 2
printf '\\033[2mAvailable models\\033[22m\\n\\n'
printf '\\033[32mauto\\033[39m \\033[2m- Auto\\033[22m\\033[2m (current, default)\\033[22m\\n'
printf '\\033[36mcomposer-2.5\\033[39m \\033[2m- Composer 2.5\\033[22m\\n'
printf "\\033[36mclaude-opus-4-8[context=1m]\\033[39m \\033[2m- Opus 4.8 1M\\033[22m\\n\\n"
printf 'Tip: use --model <id> to switch.\\n'`,
    )
    expect(await listAgentModels("cursor", { env, platform: "linux" })).toEqual({
      id: "cursor",
      source: "live",
      models: [
        { id: "auto", name: "Auto" },
        { id: "composer-2.5", name: "Composer 2.5" },
        { id: "claude-opus-4-8[context=1m]", name: "Opus 4.8 1M" },
      ],
    })
  })

  test("a failed, silent or slow listing falls back to the catalog's list with the reason", async () => {
    const failed = await fakeCli("cursor-failed", "cursor-agent", `echo "Not logged in" >&2; exit 1`)
    const slow = await fakeCli("cursor-slow", "cursor-agent", `sleep 5`)
    const catalog = ExternalAgent.find("cursor")!.models
    for (const env of [failed, slow]) {
      const list = await listAgentModels("cursor", { env, platform: "linux", timeoutMs: 300 })
      expect(list.source).toBe("catalog")
      expect(list.models).toEqual(catalog.kind === "live" ? catalog.fallback : [])
      expect(list.error).toContain("did not list its models")
    }
    const missing = await listAgentModels("codex", {
      env: { HOME: root, PATH: join(root, "nowhere") },
      platform: "linux",
    })
    expect(missing).toMatchObject({ source: "catalog", error: "Codex is not installed." })
  }, 20_000)

  test("JSON listings are read too, and fixed or absent lists never spawn anything", async () => {
    const env = await fakeCli(
      "codex-json",
      "codex",
      `echo '{"models":[{"slug":"gpt-5.5","display_name":"GPT-5.5"},{"slug":"--not-a-model"},"gpt-6-sol"]}'`,
    )
    expect((await listAgentModels("codex", { env, platform: "linux" })).models).toEqual([
      { id: "gpt-5.5", name: "GPT-5.5" },
      { id: "gpt-6-sol", name: "gpt-6-sol" },
    ])
    expect(await listAgentModels("gemini", { env })).toMatchObject({
      source: "catalog",
      models: [{ id: "auto" }, { id: "pro" }, { id: "flash" }, { id: "flash-lite" }],
    })
    expect(await listAgentModels("kimi", { env })).toEqual({ id: "kimi", source: "none", models: [] })
    await expect(listAgentModels("../../etc", { env })).rejects.toThrow("Choose an agent from the list.")
  })

  test("headings, tips and words without a model's shape are never read as models", () => {
    expect(
      modelsFromOutput("Models\nLoading...\nanthropic/claude-sonnet-5\nopenai/gpt-5.5\n--flag\nTip: run it", "lines"),
    ).toEqual([
      { id: "anthropic/claude-sonnet-5", name: "anthropic/claude-sonnet-5" },
      { id: "openai/gpt-5.5", name: "openai/gpt-5.5" },
    ])
  })
})

describe("commands for the built-in terminal", () => {
  async function fakeCli(name: string, cli: string) {
    const directory = join(root, "terminal", name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, cli), `#!/bin/sh\necho 1.0.0\n`)
    await chmod(join(directory, cli), 0o755)
    return { directory, env: { HOME: join(root, "terminal", `${name}-home`), PATH: `${directory}:/usr/bin:/bin` } }
  }

  test("install shows this platform's official commands, ready to run in an empty setup folder", async () => {
    const { env } = await fakeCli("none", "unrelated")
    const commands = await agentCommands("claude-code", { env, platform: "darwin", directory: join(root, "setup") })
    expect(commands.install.map((option) => option.id)).toEqual(["script", "homebrew"])
    const script = commands.install[0]!
    expect(script.command).toBe("curl -fsSL https://claude.ai/install.sh | bash")
    expect(script.launch).toMatchObject({
      title: "Install Claude Code",
      display: script.command,
      command: "/bin/sh",
      cwd: join(root, "setup"),
    })
    expect(script.launch.args[0]).toBe("-c")
    expect(script.launch.args[1]!.split("\n")[0]).toBe(script.command)
    expect(script.launch.env).toEqual({ PATH: env.PATH })
    // Not installed yet, so there is nothing to sign in with.
    expect(commands.signIn).toBeUndefined()

    const windows = await agentCommands("claude-code", { env, platform: "win32", directory: join(root, "setup") })
    expect(windows.install.map((option) => option.id)).toEqual(["powershell", "winget"])
    expect(windows.install[0]!.launch).toMatchObject({ command: "powershell.exe", env: {} })
    expect(windows.install[0]!.launch.args.slice(0, 2)).toEqual(["-NoProfile", "-EncodedCommand"])
    // Base64 carries no quote for the Windows command line to rewrite, so a vendor line with its own nested double
    // quotes reaches PowerShell as written.
    const codex = await agentCommands("codex", { env, platform: "win32", directory: join(root, "setup") })
    const powershell = codex.install.find((option) => option.id === "powershell")!
    expect(powershell.launch.args[2]).toMatch(/^[A-Za-z0-9+/]+=*$/)
    const encoded = Buffer.from(powershell.launch.args[2]!, "base64").toString("utf16le").split("\n")
    expect(encoded[0]).toBe('powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"')
    expect(encoded.at(-1)).toBe("exit $code")
  })

  test("sign-in runs the installed command it found, and an interactive one carries its hint", async () => {
    const claude = await fakeCli("claude", "claude")
    const signIn = (await agentCommands("claude-code", { env: claude.env, platform: "linux", directory: root })).signIn!
    expect(signIn).toMatchObject({ display: "claude auth login", interactive: false })
    expect(signIn.launch.args[1]!.split("\n")[0]).toBe(`'${join(claude.directory, "claude")}' 'auth' 'login'`)

    const copilot = await fakeCli("copilot", "copilot")
    const interactive = (await agentCommands("copilot", { env: copilot.env, platform: "linux", directory: root }))
      .signIn!
    expect(interactive).toMatchObject({
      display: "copilot",
      interactive: true,
      hint: "Type /login inside GitHub Copilot CLI, then follow its steps.",
    })
  })

  test("the terminal stays open on the command's exit status until Enter", async () => {
    const launch = terminalLaunch({
      title: "t",
      display: "false",
      line: "false",
      cwd: root,
      env: {},
      platform: "linux",
    })
    const child = Bun.spawn([launch.command, ...launch.args], { stdin: "pipe", stdout: "pipe" })
    child.stdin.write("\n")
    child.stdin.end()
    expect(await child.exited).toBe(1)
    expect(await new Response(child.stdout).text()).toContain("Exited with code 1. Press Enter to close this terminal.")
  })

  test("every word of a command line reaches the program as itself", async () => {
    const directory = join(root, "terminal", "it's here")
    await mkdir(directory, { recursive: true })
    const path = join(directory, "echo-args")
    await writeFile(path, `#!/bin/sh\nfor a in "$@"; do printf '[%s]' "$a"; done\n`)
    await chmod(path, 0o755)
    const line = commandLine(path, ["--model", "it's [1m]", "$HOME"], "linux")
    const child = Bun.spawn(["/bin/sh", "-c", line], { stdout: "pipe" })
    expect(await new Response(child.stdout).text()).toBe("[--model][it's [1m]][$HOME]")
    expect(commandLine("C:\\Program Files\\x.exe", ["it's"], "win32")).toBe("& 'C:\\Program Files\\x.exe' 'it''s'")
  })

  test("a terminal-tier launch prepares the isolated workspace and opens the agent there on its model", async () => {
    const gemini = await fakeCli("gemini", "gemini")
    const prepared: string[] = []
    const prepare = async (projectPath: string) => {
      prepared.push(projectPath)
      return { path: join(root, "isolated"), isolation: "copy" as const }
    }
    const result = await launchAgentTerminal(
      { id: "gemini", projectPath: "/repo", model: "pro" },
      { env: gemini.env, platform: "linux", prepare },
    )
    expect(prepared).toEqual(["/repo"])
    expect(result.workspace).toEqual({ path: join(root, "isolated"), isolation: "copy" })
    expect(result.launch).toMatchObject({ title: "Gemini CLI", display: "gemini -m pro", cwd: join(root, "isolated") })
    expect(result.launch.args[1]!.split("\n")[0]).toBe(`'${join(gemini.directory, "gemini")}' '-m' 'pro'`)

    // Nothing is prepared for a launch that cannot start.
    const kimi = await fakeCli("kimi", "kimi")
    await expect(
      launchAgentTerminal({ id: "kimi", projectPath: "/repo", model: "x" }, { env: kimi.env, prepare }),
    ).rejects.toThrow("has no model setting")
    await expect(
      launchAgentTerminal({ id: "gemini", projectPath: "/repo", model: "a b" }, { env: gemini.env, prepare }),
    ).rejects.toThrow("is not a model name")
    await expect(
      launchAgentTerminal({ id: "junie", projectPath: "/repo" }, { env: gemini.env, prepare }),
    ).rejects.toThrow("is not installed")
    expect(prepared).toEqual(["/repo"])
  })
})

describe("choosing the model an external CLI runs", () => {
  // Each CLI's own flag, always before the prompt or session id that ends the
  // argv: a flag after codex's prompt or cursor's prompt would be read as part
  // of the task instead.
  test("each runtime receives its own model flag on a fresh turn", () => {
    const claude = runtimeArguments("claude-code", "/w", "do it", undefined, false, "opus")
    expect(claude.slice(-2)).toEqual(["--model", "opus"])
    expect(claude[claude.indexOf("-p") + 1]).toBe("do it")

    expect(runtimeArguments("codex", "/w", "do it", undefined, false, "gpt-5.5")).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.5",
      "-C",
      "/w",
      "do it",
    ])

    expect(runtimeArguments("cursor", "/w", "do it", undefined, false, "composer-2.5")).toEqual([
      "-p",
      "--trust",
      "--force",
      "--output-format",
      "stream-json",
      "--model",
      "composer-2.5",
      "do it",
    ])
  })

  test("a resumed turn carries the model too, without disturbing resume's argv rules", () => {
    const claude = runtimeArguments("claude-code", "/w", "next", "sid-2", false, "claude-opus-5-5")
    expect(claude[claude.indexOf("--resume") + 1]).toBe("sid-2")
    expect(claude[claude.indexOf("--model") + 1]).toBe("claude-opus-5-5")

    // `codex exec resume` takes the model as the same -c override the sandbox
    // already uses there, and still never --sandbox or -C.
    const codex = runtimeArguments("codex", "/w", "next", "sid-1", false, "gpt-5.5")
    expect(codex).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'model="gpt-5.5"',
      "sid-1",
      "next",
    ])

    const cursor = runtimeArguments("cursor", "/w", "next", "sid-3", false, "auto")
    expect(cursor[cursor.indexOf("--resume") + 1]).toBe("sid-3")
    expect(cursor[cursor.indexOf("--model") + 1]).toBe("auto")
    expect(cursor.at(-1)).toBe("next")
  })

  test("the model flag survives the Windows stdin prompt form", () => {
    const claude = runtimeArguments("claude-code", "C:\\w", "line one\nline two", undefined, true, "sonnet")
    expect(claude).not.toContain("line one\nline two")
    expect(claude[claude.indexOf("--model") + 1]).toBe("sonnet")
    const codex = runtimeArguments("codex", "C:\\w", "line one\nline two", undefined, true, "gpt-5.5")
    expect(codex.at(-1)).toBe("-")
    expect(codex[codex.indexOf("--model") + 1]).toBe("gpt-5.5")
  })

  test("only a plain model name reaches a CLI", () => {
    expect(externalModelValue(undefined)).toBeUndefined()
    expect(externalModelValue("  ")).toBeUndefined()
    expect(externalModelValue(" opus ")).toBe("opus")
    expect(externalModelValue("claude-opus-5-5")).toBe("claude-opus-5-5")
    expect(externalModelValue("sonnet[1m]")).toBe("sonnet[1m]")
    expect(externalModelValue("claude-opus-4-8[context=1m,effort=high,fast=false]")).toBe(
      "claude-opus-4-8[context=1m,effort=high,fast=false]",
    )
    // A flag, a TOML quote, a shell or cmd.exe metacharacter, or a space.
    for (const value of ["--dangerously-skip-permissions", 'gpt"5', "gpt-5 && calc", "gpt%PATH%", "a b", "x^y"]) {
      expect(() => externalModelValue(value)).toThrow("is not a model name")
    }
    expect(() => externalModelValue(5)).toThrow("Choose a model")
  })

  test("a CLI that refuses the model is quoted, and the refusal is recognised for each runtime", () => {
    // Cursor names the problem on stderr only; without the model the old
    // generic sentence stays, which the crash test above locks.
    const cursor = agentOutcome(
      "cursor",
      1,
      ["[stderr] Cannot use this model: nope. Available models: auto, composer-2.5"],
      "nope",
    )
    expect(cursor.error).toBe("Cursor CLI: Cannot use this model: nope. Available models: auto, composer-2.5")
    expect(modelRejected("nope", cursor)).toBe(true)

    const claude = agentOutcome(
      "claude-code",
      0,
      [
        '[stdout] {"type":"result","subtype":"success","is_error":true,"result":"There\'s an issue with the selected model (claude-nope). It may not exist or you may not have access to it. Run --model to pick a different model."}',
      ],
      "claude-nope",
    )
    expect(claude.error).toContain("issue with the selected model (claude-nope)")
    expect(modelRejected("claude-nope", claude)).toBe(true)

    const codex = agentOutcome(
      "codex",
      1,
      [
        '[stdout] {"type":"turn.failed","error":{"message":"The \'gpt-nope\' model is not supported when using Codex with a ChatGPT account."}}',
      ],
      "gpt-nope",
    )
    expect(codex.error).toContain("model is not supported")
    expect(modelRejected("gpt-nope", codex)).toBe(true)

    // The same words are not a refused model when Vector passed none, or when
    // the run succeeded.
    expect(modelRejected(undefined, codex)).toBe(false)
    expect(modelRejected("gpt-5.5", { exitCode: 0 })).toBe(false)
    expect(modelRejected("gpt-5.5", { exitCode: 1, error: "Codex exited with code 1." })).toBe(false)
  })

  async function argvCli(name: string, cli: string, body: string) {
    const directory = join(root, "model", name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, cli), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(directory, "argv")}"\n${body}\n`)
    await chmod(join(directory, cli), 0o755)
    return { directory, env: { HOME: root, PATH: `${directory}:/usr/bin:/bin` } }
  }

  const finals = {
    "claude-code": { type: "result", subtype: "success", is_error: false, result: "Done", session_id: "c1" },
    codex: { type: "turn.completed" },
    cursor: { type: "result", subtype: "success", is_error: false, result: "Done", session_id: "c1" },
  } as const
  const clis = { "claude-code": "claude", codex: "codex", cursor: "cursor-agent" } as const

  for (const runtime of ["claude-code", "codex", "cursor"] as const) {
    test(`a live ${runtime} process is spawned with the chosen model, and with no flag by default`, async () => {
      const { directory, env } = await argvCli(`${runtime}-flag`, clis[runtime], printLines([finals[runtime]]))
      const argv = async () => (await Bun.file(join(directory, "argv")).text()).trim().split("\n")

      await runExternalCodingAgent({ runtime, cwd: root, prompt: "fixture only", env, model: "fixture-model" })
      const chosen = await argv()
      expect(chosen[chosen.indexOf("--model") + 1]).toBe("fixture-model")

      await runExternalCodingAgent({ runtime, cwd: root, prompt: "fixture only", env })
      expect(await argv()).not.toContain("--model")
    }, 20_000)
  }

  test("a live CLI that refuses the model reports its own words and modelRejected", async () => {
    const { env } = await argvCli(
      "cursor-refused",
      "cursor-agent",
      "echo 'Cannot use this model: fixture-nope. Run cursor-agent models to see what you can use.' >&2\nexit 1",
    )
    const result = await runExternalCodingAgent({
      runtime: "cursor",
      cwd: root,
      prompt: "fixture only",
      env,
      model: "fixture-nope",
    })
    expect(result.exitCode).toBe(1)
    expect(result.error).toBe(
      "Cursor CLI: Cannot use this model: fixture-nope. Run cursor-agent models to see what you can use.",
    )
    expect(result.modelRejected).toBe(true)
  }, 20_000)

  test("an unsafe model value never spawns the CLI", async () => {
    const { directory, env } = await argvCli("claude-unsafe", "claude", printLines([finals["claude-code"]]))
    await expect(
      runExternalCodingAgent({ runtime: "claude-code", cwd: root, prompt: "x", env, model: "--permission-mode" }),
    ).rejects.toThrow("is not a model name")
    expect(await Bun.file(join(directory, "argv")).exists()).toBe(false)
  })
})
