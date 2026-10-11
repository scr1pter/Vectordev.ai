// Reads what a run cost from a runtime's JSON event stream. Pure, like score.ts: run.ts feeds it one stdout line
// at a time, and a recorded stream can be re-metered without another model call.
//
// Token classes are normalised the same way for every runtime, or a comparison means nothing: `input` is the
// uncached input, `cacheRead` and `cacheWrite` are the cached input read and written, `output` includes reasoning,
// and `reasoning` is the part of output spent thinking. Each runtime reports these differently (Codex counts cached
// input inside input_tokens; Vector keeps reasoning out of output), so each is converted here.

export type Tokens = { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number }

export type CostSource = "catalog-estimate" | "runtime-reported" | "unknown"

export type Meter = {
  // Undefined if any priced step is missing, invalid, or marked unpriced.
  costUsd?: number
  knownCostUsd?: number
  costComplete?: boolean
  // A CLI report is not a billing invoice; Vector generally calculates catalog estimates.
  costSource?: CostSource
  // Undefined totals and false coverage persist after any request omits valid input/output usage.
  tokens?: Tokens
  tokensComplete?: boolean
  // Provider requests, where the runtime reports them.
  requests?: number
}

const EMPTY: Tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }

export function totalTokens(tokens: Tokens) {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output
}

// The share of input that was read from the cache: the measure of how well a runtime reuses its prompt.
export function cacheReadShare(tokens: Tokens) {
  const input = tokens.input + tokens.cacheRead + tokens.cacheWrite
  return input === 0 ? undefined : tokens.cacheRead / input
}

export function meterLine(meter: Meter, line: string): Meter {
  const trimmed = line.trim()
  if (!trimmed.startsWith("{")) return meter
  const event = parse(trimmed)
  if (!event) return meter

  // Vector: one step_finish per provider request, subagents' included, each with that request's cost and tokens.
  if (event.type === "step_finish") {
    const part = record(event.part)
    const tokens = record(part?.tokens)
    const cache = record(tokens?.cache)
    const usage =
      tokens && (tokens.cache === undefined || cache)
        ? usageTokens({
            input: tokens.input,
            output: tokens.output,
            cacheRead: cache?.read,
            cacheWrite: cache?.write,
            reasoning: tokens.reasoning,
          })
        : undefined
    const summed =
      meter.tokensComplete === false || usage === undefined
        ? undefined
        : add(meter.tokens, { ...usage, output: usage.output + usage.reasoning })
    const cost = part?.unpriced === true ? undefined : number(part?.cost)
    const knownCostUsd = (meter.knownCostUsd ?? meter.costUsd ?? 0) + (cost ?? 0)
    const costComplete = meter.costComplete !== false && cost !== undefined && Number.isFinite(knownCostUsd)
    return {
      costUsd: costComplete ? knownCostUsd : undefined,
      knownCostUsd: Number.isFinite(knownCostUsd) ? knownCostUsd : undefined,
      costComplete,
      costSource: costComplete ? "catalog-estimate" : "unknown",
      tokens: summed,
      tokensComplete: summed !== undefined,
      requests: (meter.requests ?? 0) + 1,
    }
  }

  // Claude Code and Cursor: one terminal result with the run's totals. modelUsage covers every model the run used,
  // subagents on a smaller model included; usage covers only the main model.
  if (event.type === "result") {
    const cost = number(event.total_cost_usd) ?? number(event.cost_usd)
    const modelUsage = record(event.modelUsage)
    const models = Object.values(modelUsage ?? {})
    const usage = record(event.usage)
    const tokens =
      meter.tokensComplete === false || (event.modelUsage !== undefined && !modelUsage)
        ? undefined
        : models.length > 0
          ? models.reduce<Tokens | undefined>(
              (total, item) =>
                total === undefined
                  ? undefined
                  : add(
                      total,
                      usageTokens({
                        input: record(item)?.inputTokens,
                        output: record(item)?.outputTokens,
                        cacheRead: record(item)?.cacheReadInputTokens,
                        cacheWrite: record(item)?.cacheCreationInputTokens,
                      }),
                    ),
              EMPTY,
            )
          : usageTokens({
              input: usage?.input_tokens,
              output: usage?.output_tokens,
              cacheRead: usage?.cache_read_input_tokens,
              cacheWrite: usage?.cache_creation_input_tokens,
            })
    return {
      costUsd: cost,
      knownCostUsd: cost ?? meter.knownCostUsd,
      costComplete: cost !== undefined,
      costSource: cost === undefined ? "unknown" : "runtime-reported",
      tokens,
      tokensComplete: tokens !== undefined,
      requests: number(event.num_turns) ?? meter.requests,
    }
  }

  // Codex: turn.completed carries each turn's usage, and input_tokens includes the cached input.
  if (event.type === "turn.completed") {
    const usage = record(event.usage)
    const tokens = meter.tokensComplete === false ? undefined : add(meter.tokens, codexTokens(usage))
    return {
      ...meter,
      costUsd: undefined,
      costComplete: false,
      costSource: "unknown",
      tokens,
      tokensComplete: tokens !== undefined,
    }
  }

  // Older Codex: token_count events carry the cumulative usage, so the last one wins.
  const info = record(record(event.msg)?.info) ?? record(event.info)
  const cumulative = record(info?.total_token_usage)
  if (cumulative) {
    const tokens = meter.tokensComplete === false ? undefined : codexTokens(cumulative)
    return {
      ...meter,
      costUsd: undefined,
      costComplete: false,
      costSource: "unknown",
      tokens,
      tokensComplete: tokens !== undefined,
    }
  }

  return meter
}

function codexTokens(usage: Record<string, unknown> | undefined) {
  const tokens = usageTokens({
    input: usage?.input_tokens,
    output: usage?.output_tokens,
    cacheRead: usage?.cached_input_tokens,
    reasoning: usage?.reasoning_output_tokens,
  })
  if (!tokens) return undefined
  const cached = Math.min(tokens.cacheRead, tokens.input)
  return {
    input: tokens.input - cached,
    cacheRead: cached,
    cacheWrite: 0,
    output: tokens.output,
    reasoning: Math.min(tokens.reasoning, tokens.output),
  }
}

function usageTokens(usage: {
  input: unknown
  output: unknown
  cacheRead?: unknown
  cacheWrite?: unknown
  reasoning?: unknown
}): Tokens | undefined {
  const input = tokenCount(usage.input)
  const output = tokenCount(usage.output)
  const cacheRead = tokenCount(usage.cacheRead === undefined ? 0 : usage.cacheRead)
  const cacheWrite = tokenCount(usage.cacheWrite === undefined ? 0 : usage.cacheWrite)
  const reasoning = tokenCount(usage.reasoning === undefined ? 0 : usage.reasoning)
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    reasoning === undefined
  )
    return undefined
  return { input, output, cacheRead, cacheWrite, reasoning }
}

function add(base: Tokens | undefined, next: Tokens | undefined): Tokens | undefined {
  if (!next) return undefined
  const from = base ?? EMPTY
  const tokens = {
    input: from.input + next.input,
    cacheRead: from.cacheRead + next.cacheRead,
    cacheWrite: from.cacheWrite + next.cacheWrite,
    output: from.output + next.output,
    reasoning: from.reasoning + next.reasoning,
  }
  return Object.values(tokens).every((value) => tokenCount(value) !== undefined) ? tokens : undefined
}

// Mirrors the defensive line parsing in external-agents.ts: agent stdout is a mixed stream and a malformed line must
// never take the run down.
function parse(line: string) {
  try {
    return record(JSON.parse(line))
  } catch {
    return undefined
  }
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function tokenCount(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
