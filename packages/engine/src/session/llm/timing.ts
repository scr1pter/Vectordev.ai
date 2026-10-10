import type { LLMEvent, UsageInput } from "@vectordevai/llm"

const usageFields = {
  inputTokens: "usageInputTokens",
  outputTokens: "usageOutputTokens",
  nonCachedInputTokens: "usageNonCachedInputTokens",
  cacheReadInputTokens: "usageCacheReadTokens",
  cacheWriteInputTokens: "usageCacheWriteTokens",
  reasoningTokens: "usageReasoningTokens",
  totalTokens: "usageTotalTokens",
} as const
const usageKeys = Object.keys(usageFields) as (keyof typeof usageFields)[]

// Keep milestones, not chunks or prompt content. A transport trace with the same
// request ID can distinguish a quiet provider from delayed client consumption.
export function create(now = () => performance.now()) {
  const started = now()
  const state = {
    setupMs: undefined as number | undefined,
    firstEventMs: undefined as number | undefined,
    firstContentMs: undefined as number | undefined,
    firstToolInputMs: undefined as number | undefined,
    firstToolCallMs: undefined as number | undefined,
    lastEventMs: 0,
    longestEventGapMs: 0,
    events: 0,
    terminal: undefined as "finished" | "provider-error" | undefined,
    usage: undefined as Partial<Record<keyof typeof usageFields, number>> | undefined,
    usageSource: undefined as "finish" | "steps" | undefined,
    usageSteps: 0,
    usageReportedSteps: 0,
  }
  return {
    ready() {
      state.setupMs = now() - started
    },
    observe(event: Pick<LLMEvent, "type"> & { usage?: UsageInput }) {
      const type = event.type
      const elapsed = now() - started
      state.longestEventGapMs = Math.max(state.longestEventGapMs, elapsed - state.lastEventMs)
      state.lastEventMs = elapsed
      state.events += 1
      state.firstEventMs ??= elapsed
      if (type === "text-delta" || type === "reasoning-delta") state.firstContentMs ??= elapsed
      if (type === "tool-input-start" || type === "tool-input-delta") state.firstToolInputMs ??= elapsed
      if (type === "tool-call") state.firstToolCallMs ??= elapsed
      if (type === "provider-error") state.terminal = "provider-error"
      if (type === "finish" && !state.terminal) state.terminal = "finished"
      if (type !== "step-finish" && type !== "finish") return
      if (type === "step-finish") {
        state.usageSteps += 1
        if (event.usage) state.usageReportedSteps += 1
      }
      if (type === "finish" && !event.usage) return
      // A finish carries the aggregate, not another billable step. Only complete
      // step sums survive a missing terminal aggregate; absent fields stay unknown.
      state.usage = Object.fromEntries(
        usageKeys.flatMap((key) => {
          const count = event.usage?.[key]
          if (count === undefined || !Number.isSafeInteger(count) || count < 0) return []
          if (type === "finish" || state.usageSteps === 1) return [[key, count]]
          const previous = state.usage?.[key]
          return previous === undefined ? [] : [[key, previous + count]]
        }),
      )
      state.usageSource = type === "finish" ? "finish" : "steps"
    },
    summary(outcome: "success" | "failure" | "interrupted") {
      const elapsedMs = now() - started
      return {
        setupMs: state.setupMs,
        firstEventMs: state.firstEventMs,
        firstContentMs: state.firstContentMs,
        firstToolInputMs: state.firstToolInputMs,
        firstToolCallMs: state.firstToolCallMs,
        lastEventMs: state.lastEventMs,
        events: state.events,
        terminal: state.terminal,
        usageSource: state.usageSource,
        usageSteps: state.usageSteps,
        usageReportedSteps: state.usageReportedSteps,
        usageHasInputOutput: state.usage?.inputTokens !== undefined && state.usage?.outputTokens !== undefined,
        // Inclusive input/output follow the LLM Usage contract. Never include
        // provider metadata here: it may contain provider payloads or user text.
        ...Object.fromEntries(
          usageKeys.flatMap((key) => (state.usage?.[key] === undefined ? [] : [[usageFields[key], state.usage[key]]])),
        ),
        elapsedMs,
        longestEventGapMs: Math.max(state.longestEventGapMs, elapsedMs - state.lastEventMs),
        outcome,
      }
    },
  }
}

export * as LLMTiming from "./timing"
