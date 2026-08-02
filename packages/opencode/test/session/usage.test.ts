import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { summarizeUsage } from "@/session/session"

describe("session usage", () => {
  test("aggregates real assistant usage into daily activity and streaks", () => {
    const today = new Date()
    today.setHours(12, 0, 0, 0)
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    const earlier = new Date(today)
    earlier.setDate(earlier.getDate() - 4)

    const result = summarizeUsage([
      assistant(today.getTime(), 100, 0.02, 5_000),
      assistant(yesterday.getTime(), 50, 0.01, 2_000),
      assistant(earlier.getTime(), 25, 0.005, 1_000),
    ])

    expect(result.lifetimeTokens).toBe(175)
    expect(result.lifetimeCost).toBeCloseTo(0.035)
    expect(result.peakTokens).toBe(100)
    expect(result.longestTaskMs).toBe(5_000)
    expect(result.currentStreak).toBe(2)
    expect(result.longestStreak).toBe(2)
    expect(result.completedChats).toBe(3)
    expect(result.conversations).toBe(1)
    expect(result.activeDays).toBe(3)
    expect(result.averageTokensPerChat).toBe(58)
    expect(result.favoriteModels[0]).toMatchObject({
      providerID: "test-provider",
      modelID: "test-model",
      percentage: 100,
    })
    expect(result.effortLevels[0]).toMatchObject({ id: "default", label: "Default", percentage: 100 })
    expect(result.days).toHaveLength(3)
  })

  test("returns an empty summary before the first model response", () => {
    expect(summarizeUsage([])).toEqual({
      lifetimeTokens: 0,
      lifetimeCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      peakTokens: 0,
      longestTaskMs: 0,
      longestTaskTokens: 0,
      averageTaskMs: 0,
      currentStreak: 0,
      longestStreak: 0,
      completedChats: 0,
      conversations: 0,
      activeDays: 0,
      averageTokensPerChat: 0,
      modelResponses: 0,
      favoriteModels: [],
      effortLevels: [],
      days: [],
    })
  })

  test("ranks model and effort preferences by token share", () => {
    const now = Date.now()
    const result = summarizeUsage([
      assistant(now, 600, 0.06, 1_000, { providerID: "anthropic", modelID: "claude-opus-fast", variant: "xhigh" }),
      assistant(now + 1, 300, 0.03, 1_000, { providerID: "openai", modelID: "gpt-5", variant: "medium" }),
      assistant(now + 2, 100, 0.01, 1_000, { providerID: "openai", modelID: "gpt-5", variant: "medium" }),
    ])

    expect(result.favoriteModels).toEqual([
      { providerID: "anthropic", modelID: "claude-opus", tokens: 600, responses: 1, percentage: 60 },
      { providerID: "openai", modelID: "gpt-5", tokens: 400, responses: 2, percentage: 40 },
    ])
    expect(result.effortLevels).toEqual([
      { id: "max", label: "Max", tokens: 600, responses: 1, percentage: 60 },
      { id: "balanced", label: "Balanced", tokens: 400, responses: 2, percentage: 40 },
    ])
    expect(result.days[0]?.tasks).toBe(3)
  })

  // Regression: Session.usage() reads message bodies from the `data` column, which does NOT
  // contain `id`/`sessionID` (those are separate columns). Decoding the raw blob against
  // SessionV1.Info therefore fails and every message is silently dropped, collapsing the
  // whole usage screen to zeros. usage() must merge the columns back before decoding.
  describe("stored-row decode boundary", () => {
    // Shape as persisted in MessageTable.data — no id/sessionID keys.
    const stored = {
      role: "assistant",
      parentID: "msg_parent0001",
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp/vector", root: "/tmp/vector" },
      cost: 0,
      tokens: { total: 8139, input: 8102, output: 23, reasoning: 14, cache: { read: 0, write: 0 } },
      modelID: "anthropic/claude-sonnet-4-5",
      providerID: "anthropic",
      time: { created: Date.now(), completed: Date.now() + 2000 },
      finish: "stop",
    }
    const decode = Schema.decodeUnknownOption(SessionV1.Info)

    test("raw data blob fails to decode without the id/sessionID columns", () => {
      expect(Option.isNone(decode(stored))).toBe(true)
    })

    test("merging id/sessionID from columns decodes and aggregates", () => {
      const decoded = decode({
        ...stored,
        id: "msg_f206a72ca001jl6vbP0871GTzN",
        sessionID: "ses_0dfacf31bffeW0dXr7RumHkEF4",
      })
      expect(Option.isSome(decoded)).toBe(true)
      expect(summarizeUsage(Option.isSome(decoded) ? [decoded.value] : []).lifetimeTokens).toBe(8139)
    })
  })
})

function assistant(
  created: number,
  tokens: number,
  cost: number,
  duration: number,
  options?: { providerID?: string; modelID?: string; variant?: string },
) {
  return {
    id: `message-${created}`,
    sessionID: "session-usage",
    role: "assistant",
    time: { created, completed: created + duration },
    parentID: `parent-${created}`,
    modelID: options?.modelID ?? "test-model",
    providerID: options?.providerID ?? "test-provider",
    variant: options?.variant,
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp/vector", root: "/tmp/vector" },
    cost,
    tokens: { total: tokens, input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as typeof SessionV1.Assistant.Type
}
