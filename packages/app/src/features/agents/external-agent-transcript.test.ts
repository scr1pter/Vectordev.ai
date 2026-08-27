import { describe, expect, test } from "bun:test"
import { restartedConversation, type ExternalAgentTurn } from "./external-agent-transcript"

const turn = (role: ExternalAgentTurn["role"], resumed?: boolean): ExternalAgentTurn => ({
  id: `${role}-${resumed}`,
  role,
  text: "text",
  at: "2026-08-26T12:00:00.000Z",
  state: "done",
  resumed,
})

describe("external agent transcript", () => {
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
