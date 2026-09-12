import { describe, expect, test } from "bun:test"
import {
  elapsedLabel,
  externalAgentMessages,
  externalAgentProgress,
  restartedConversation,
  type ExternalAgentTurn,
} from "./external-agent-transcript-model"

const turn = (role: ExternalAgentTurn["role"], resumed?: boolean): ExternalAgentTurn => ({
  id: `${role}-${resumed}`,
  role,
  text: "text",
  at: "2026-08-26T12:00:00.000Z",
  state: "done",
  resumed,
})

describe("external agent transcript", () => {
  test("prefers structured messages and never repeats the final summary", () => {
    const messages = [
      { id: "a", text: "First" },
      { id: "b", text: "Final" },
    ]
    expect(externalAgentMessages({ ...turn("agent"), text: "Final", messages })).toEqual(messages)
  })

  test("preserves legacy text while ignoring raw stream tails", () => {
    const legacy = {
      ...turn("agent"),
      text: "Legacy answer",
      streamTail: ['{"type":"command_execution","command":"secret"}'],
    }
    expect(externalAgentMessages(legacy)).toEqual([{ id: `${legacy.id}:reply`, text: "Legacy answer" }])
    expect(externalAgentMessages({ ...legacy, text: "", state: "running" })).toEqual([])
  })

  test("filters blank structured messages and falls back only when none remain", () => {
    const base = turn("agent")
    expect(
      externalAgentMessages({
        ...base,
        messages: [
          { id: "empty", text: "  " },
          { id: "message", text: "Hello" },
        ],
      }),
    ).toEqual([{ id: "message", text: "Hello" }])
    expect(externalAgentMessages({ ...base, messages: [] })).toEqual([{ id: `${base.id}:reply`, text: "text" }])
    expect(externalAgentMessages({ ...base, text: " ", messages: [{ id: "empty", text: " " }] })).toEqual([])
  })
  test("does not call the first response a restarted conversation", () => {
    const turns = [turn("user"), turn("agent", false)]
    expect(restartedConversation(turns, 1)).toBe(false)
  })

  test("labels a later response when its follow-up could not resume", () => {
    const turns = [turn("user"), turn("agent"), turn("user"), turn("agent", false)]
    expect(restartedConversation(turns, 3)).toBe(true)
  })

  test("does not label a successfully resumed follow-up", () => {
    const turns = [turn("user"), turn("agent"), turn("user"), turn("agent", true)]
    expect(restartedConversation(turns, 3)).toBe(false)
  })
})

describe("external agent liveness", () => {
  const live = (activity?: ExternalAgentTurn["activity"]): ExternalAgentTurn => ({
    ...turn("agent"),
    state: "running",
    activity,
  })

  test("an open reasoning phase reads as thinking", () => {
    expect(
      externalAgentProgress(live([{ id: "codex-turn", label: "Thinking", kind: "thinking", state: "running" }])),
    ).toEqual({ thinking: true, label: "Thinking" })
  })

  test("a finished reasoning phase leaves the agent working", () => {
    expect(
      externalAgentProgress(live([{ id: "codex-turn", label: "Thinking", kind: "thinking", state: "done" }])),
    ).toEqual({ thinking: false, label: undefined })
  })

  test("a running tool names the step and is not thinking", () => {
    expect(
      externalAgentProgress(
        live([
          { id: "phase", label: "Thinking", kind: "thinking", state: "running" },
          { id: "tool", label: "Running a command", kind: "tool", state: "running" },
        ]),
      ),
    ).toEqual({ thinking: false, label: "Running a command" })
  })

  test("a turn with no activity yet is working", () => {
    expect(externalAgentProgress(live())).toEqual({ thinking: false, label: undefined })
  })

  test("elapsed time reads like a stopwatch and never goes negative", () => {
    const at = "2026-09-12T12:00:00.000Z"
    const start = Date.parse(at)
    expect(elapsedLabel(at, start)).toBe("0s")
    expect(elapsedLabel(at, start + 59_999)).toBe("59s")
    expect(elapsedLabel(at, start + 65_000)).toBe("1m 05s")
    expect(elapsedLabel(at, start + 62 * 60_000)).toBe("1h 02m")
    expect(elapsedLabel(at, start - 5_000)).toBe("0s")
    expect(elapsedLabel("not a date", start)).toBe("")
  })
})
