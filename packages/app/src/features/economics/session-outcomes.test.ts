import { describe, expect, test } from "bun:test"
import { outcomeFromSession } from "./session-outcomes"

const usage = { input: 1_000, output: 300, reasoning: 0, cache: { read: 0, write: 0 } }

function session(overrides: Partial<Parameters<typeof outcomeFromSession>[0]> = {}) {
  return outcomeFromSession({
    sessionID: "s1",
    projectId: "/repo",
    messages: [
      { info: { id: "m0", role: "user" } },
      {
        info: {
          id: "m1",
          role: "assistant",
          providerID: "anthropic",
          modelID: "claude-sonnet-5",
          cost: 0.02,
          tokens: usage,
          time: { created: 1_000, completed: 6_000 },
        },
      },
    ],
    parts: { m0: [{ type: "text", text: "fix the login form styling" } as never] },
    ...overrides,
  })
}

describe("outcomeFromSession", () => {
  test("records the provider, model, measured cost, and latency", () => {
    const outcome = session()!
    expect(outcome.provider).toBe("anthropic")
    expect(outcome.model).toBe("claude-sonnet-5")
    expect(outcome.costUsd).toBeCloseTo(0.02, 10)
    expect(outcome.usage?.input).toBe(1_000)
    expect(outcome.latencyMs).toBe(5_000)
  })

  test("is idempotent per session so repeated idle events record once", () => {
    expect(session()!.id).toBe(session()!.id)
    expect(session()!.id).toContain("s1")
  })

  test("categorises from the first user message", () => {
    expect(session()!.category).toBeTruthy()
  })

  test("returns undefined when nothing reached a provider", () => {
    expect(session({ messages: [{ info: { id: "m0", role: "user" } }] })).toBeUndefined()
  })

  test("returns undefined when usage was never reported", () => {
    expect(
      session({
        messages: [{ info: { id: "m1", role: "assistant", providerID: "x", modelID: "y", cost: 0 } }],
      }),
    ).toBeUndefined()
  })

  test("counts distinct edited files, not tool calls", () => {
    const outcome = session({
      parts: {
        m0: [{ type: "text", text: "do it" } as never],
        m1: [
          { type: "tool", tool: "edit", state: { input: { filePath: "a.ts" } } },
          { type: "tool", tool: "edit", state: { input: { filePath: "a.ts" } } },
          { type: "tool", tool: "write", state: { input: { filePath: "b.ts" } } },
          { type: "tool", tool: "read", state: { input: { filePath: "c.ts" } } },
        ],
      },
    })!
    expect(outcome.changedFiles).toBe(2)
  })

  test("tolerates a session with no parts at all", () => {
    const outcome = session({ parts: {} })!
    expect(outcome.changedFiles).toBe(0)
    expect(outcome.category).toBeTruthy()
  })
})
