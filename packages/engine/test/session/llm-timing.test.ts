import { expect, test } from "bun:test"
import { LLMTiming } from "../../src/session/llm/timing"

test("records first milestones and quiet intervals without retaining model content", () => {
  const clock = { now: 100 }
  const timing = LLMTiming.create(() => clock.now)
  clock.now = 120
  timing.ready()
  clock.now = 150
  timing.observe({ type: "step-start" })
  clock.now = 200
  timing.observe({ type: "reasoning-delta" })
  clock.now = 220
  timing.observe({ type: "text-delta" })
  clock.now = 1_220
  timing.observe({ type: "tool-input-start" })
  clock.now = 1_230
  timing.observe({ type: "tool-input-delta" })
  clock.now = 1_240
  timing.observe({ type: "tool-call" })
  clock.now = 1_300
  timing.observe({ type: "finish" })
  clock.now = 1_310
  expect(timing.summary("success")).toEqual({
    setupMs: 20,
    firstEventMs: 50,
    firstContentMs: 100,
    firstToolInputMs: 1_120,
    firstToolCallMs: 1_140,
    lastEventMs: 1_200,
    longestEventGapMs: 1_000,
    events: 7,
    terminal: "finished",
    elapsedMs: 1_210,
    outcome: "success",
    usageSource: undefined,
    usageSteps: 0,
    usageReportedSteps: 0,
    usageHasInputOutput: false,
  })
})

test("includes a quiet tail when a response is interrupted", () => {
  const clock = { now: 0 }
  const timing = LLMTiming.create(() => clock.now)
  clock.now = 10
  timing.observe({ type: "step-start" })
  clock.now = 2_000
  expect(timing.summary("interrupted")).toMatchObject({
    firstEventMs: 10,
    firstContentMs: undefined,
    longestEventGapMs: 1_990,
    elapsedMs: 2_000,
    outcome: "interrupted",
    terminal: undefined,
  })
})

test("setup failure has no invented first response milestone", () => {
  const clock = { now: 0 }
  const timing = LLMTiming.create(() => clock.now)
  clock.now = 80
  expect(timing.summary("failure")).toMatchObject({
    setupMs: undefined,
    firstEventMs: undefined,
    events: 0,
    elapsedMs: 80,
    longestEventGapMs: 80,
  })
})

test("provider errors remain visible when the adapter later emits finish", () => {
  const timing = LLMTiming.create()
  timing.observe({ type: "provider-error" })
  timing.observe({ type: "finish" })
  expect(timing.summary("success").terminal).toBe("provider-error")
})

test("terminal usage replaces step totals and excludes payload metadata", () => {
  const timing = LLMTiming.create()
  timing.observe({ type: "step-finish", usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 80 } })
  timing.observe({ type: "step-finish", usage: { inputTokens: 200, outputTokens: 20, cacheReadInputTokens: 150 } })
  timing.observe({
    type: "finish",
    usage: {
      inputTokens: 300,
      outputTokens: 30,
      reasoningTokens: 12,
      cacheReadInputTokens: 230,
      cacheWriteInputTokens: 0,
      totalTokens: 330,
      providerMetadata: { openai: { privateText: "must not appear" } },
    },
  })
  const summary = timing.summary("success")
  expect(summary).toMatchObject({
    usageInputTokens: 300,
    usageOutputTokens: 30,
    usageReasoningTokens: 12,
    usageCacheReadTokens: 230,
    usageCacheWriteTokens: 0,
    usageTotalTokens: 330,
    usageSource: "finish",
    usageSteps: 2,
    usageReportedSteps: 2,
    usageHasInputOutput: true,
  })
  expect(JSON.stringify(summary)).not.toContain("must not appear")
  expect(JSON.stringify(summary)).not.toContain("providerMetadata")
})

test("interrupted steps retain complete counts without inventing partial fields", () => {
  const timing = LLMTiming.create()
  timing.observe({
    type: "step-finish",
    usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 80, cacheWriteInputTokens: 20 },
  })
  timing.observe({ type: "step-finish", usage: { inputTokens: 200, outputTokens: 20, cacheReadInputTokens: 150 } })
  expect(timing.summary("interrupted")).toMatchObject({
    usageInputTokens: 300,
    usageOutputTokens: 30,
    usageCacheReadTokens: 230,
    usageSource: "steps",
    usageSteps: 2,
    usageHasInputOutput: true,
  })
  expect(timing.summary("interrupted")).not.toHaveProperty("usageCacheWriteTokens")
})

test("a missing step prevents later usage from masquerading as a total", () => {
  const timing = LLMTiming.create()
  timing.observe({ type: "step-finish" })
  timing.observe({ type: "step-finish", usage: { inputTokens: 200, outputTokens: 20, cacheWriteInputTokens: 0 } })
  timing.observe({ type: "finish" })
  expect(timing.summary("success")).toMatchObject({ usageSteps: 2, usageReportedSteps: 1, usageHasInputOutput: false })
  expect(timing.summary("success")).not.toHaveProperty("usageInputTokens")
  expect(timing.summary("success")).not.toHaveProperty("usageCacheWriteTokens")
})

test("invalid usage counts are omitted rather than serialized as billable totals", () => {
  const timing = LLMTiming.create()
  timing.observe({
    type: "finish",
    usage: { inputTokens: Infinity, outputTokens: -1, cacheReadInputTokens: NaN, cacheWriteInputTokens: 0.5 },
  })
  expect(timing.summary("success")).toMatchObject({ usageHasInputOutput: false })
  expect(timing.summary("success")).not.toHaveProperty("usageInputTokens")
  expect(timing.summary("success")).not.toHaveProperty("usageOutputTokens")
  expect(timing.summary("success")).not.toHaveProperty("usageCacheReadTokens")
  expect(timing.summary("success")).not.toHaveProperty("usageCacheWriteTokens")
})
