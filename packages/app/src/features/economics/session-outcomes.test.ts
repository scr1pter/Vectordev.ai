import { describe, expect, test } from "bun:test"
import { categoryFromSession, outcomeFromSession } from "./session-outcomes"

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
    // Every response had a price, so even a 0 here would mean free rather than unknown.
    expect(outcome.costPriced).toBe(true)
    expect(outcome.usage?.input).toBe(1_000)
    expect(outcome.latencyMs).toBe(5_000)
  })

  test("counts what the session's subagents spent as part of its cost", () => {
    expect(session({ subagents: { subagentCost: 0.5 } })!.costUsd).toBeCloseTo(0.52, 10)
    // A subagent step with no listed price leaves the task's cost unknown, not short.
    const unpriced = session({ subagents: { subagentCost: 0.5, subagentUnpricedSteps: 1 } })!
    expect(unpriced.costUsd).toBeUndefined()
    expect(unpriced.costPriced).toBeUndefined()
  })

  test("measures latency from this session's own replies, not history a fork copied in", () => {
    const outcome = session({
      messages: [
        { info: { id: "m0", role: "user" } },
        {
          info: {
            id: "old",
            role: "assistant",
            providerID: "anthropic",
            modelID: "claude-sonnet-5",
            cost: 0,
            forked: true,
            tokens: usage,
            time: { created: 1_000, completed: 2_000 },
          },
        },
        {
          info: {
            id: "m1",
            role: "assistant",
            providerID: "anthropic",
            modelID: "claude-sonnet-5",
            cost: 0.02,
            tokens: usage,
            time: { created: 3_600_000, completed: 3_660_000 },
          },
        },
      ],
    })!
    expect(outcome.latencyMs).toBe(60_000)
  })

  test("is idempotent per session so repeated idle events record once", () => {
    expect(session()!.id).toBe(session()!.id)
    expect(session()!.id).toContain("s1")
  })

  test("idle time between user turns does not count as model execution time", () => {
    const outcome = session({
      messages: [
        {
          info: {
            role: "assistant",
            providerID: "anthropic",
            modelID: "sonnet",
            cost: 0.01,
            tokens: usage,
            time: { created: 1_000, completed: 6_000 },
          },
        },
        {
          info: {
            role: "assistant",
            providerID: "anthropic",
            modelID: "sonnet",
            cost: 0.01,
            tokens: usage,
            time: { created: 86_401_000, completed: 86_407_000 },
          },
        },
      ],
    })
    expect(outcome?.latencyMs).toBe(11_000)
    expect(outcome?.latencyMeasured).toBe(true)
  })

  test("missing completion timing never makes an interrupted run appear instantaneous", () => {
    const outcome = session({
      messages: [
        {
          info: {
            role: "assistant",
            providerID: "anthropic",
            modelID: "sonnet",
            cost: 0.01,
            tokens: usage,
            time: { created: 1_000 },
          },
        },
      ],
    })
    expect(outcome?.latencyMeasured).toBe(false)
  })

  test("categorises from the first user message", () => {
    expect(session()!.category).toBeTruthy()
    const messages = [{ info: { id: "m0", role: "user" } }, { info: { id: "m1", role: "user" } }]
    expect(
      categoryFromSession(messages, {
        m0: [{ type: "text", text: "fix the login error" }],
        m1: [{ type: "text", text: "write docs" }],
      }),
    ).toBe("bug-fix")
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

  test("a model switch cannot train a recommendation for only the final model", () => {
    expect(
      session({
        messages: [
          { info: { role: "assistant", providerID: "openai", modelID: "large", cost: 2, tokens: usage } },
          { info: { role: "assistant", providerID: "openai", modelID: "small", cost: 0.01, tokens: usage } },
        ],
      }),
    ).toBeUndefined()
  })

  test("invalid subagent spend remains unknown rather than corrupting the ranking", () => {
    for (const subagentCost of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(session({ subagents: { subagentCost } })?.costUsd).toBeUndefined()
      expect(session({ subagents: { subagentCost } })?.costPriced).toBeUndefined()
    }
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
