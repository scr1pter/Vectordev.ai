// Reads what a run cost from a runtime's JSON event stream. Pure, like score.ts: run.ts feeds it one stdout line
// at a time, and a recorded stream can be re-metered without another model call.
//
// Token classes are normalised the same way for every runtime, or a comparison means nothing: `input` is the
// uncached input, `cacheRead` and `cacheWrite` are the cached input read and written, `output` includes reasoning,
// and `reasoning` is the part of output spent thinking. Each runtime reports these differently (Codex counts cached
// input inside input_tokens; Vector keeps reasoning out of output), so each is converted here.

export type Tokens = { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number }

export type Meter = {
  costUsd?: number
  tokens?: Tokens
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
  if (!line.startsWith("{")) return meter
  const event = parse(line)
  if (!event) return meter

  // Vector: one step_finish per provider request, subagents' included, each with that request's cost and tokens.
  if (event.type === "step_finish") {
    const part = record(event.part)
    const tokens = record(part?.tokens)
    const cache = record(tokens?.cache)
    const reasoning = count(tokens?.reasoning)
    return {
      costUsd: (meter.costUsd ?? 0) + count(part?.cost),
      tokens: add(meter.tokens, {
        input: count(tokens?.input),
        cacheRead: count(cache?.read),
        cacheWrite: count(cache?.write),
        output: count(tokens?.output) + reasoning,
        reasoning,
      }),
      requests: (meter.requests ?? 0) + 1,
    }
  }

  // Claude Code and Cursor: one terminal result with the run's totals. modelUsage covers every model the run used,
  // subagents on a smaller model included; usage covers only the main model.
  if (event.type === "result") {
    const models = Object.values(record(event.modelUsage) ?? {})
      .map(record)
      .filter((item) => item !== undefined)
    const usage = record(event.usage)
    const tokens =
      models.length > 0
        ? models.reduce<Tokens>(
            (total, item) =>
              add(total, {
                input: count(item.inputTokens),
                cacheRead: count(item.cacheReadInputTokens),
                cacheWrite: count(item.cacheCreationInputTokens),
                output: count(item.outputTokens),
                reasoning: 0,
              }),
            EMPTY,
          )
        : usage
          ? {
              input: count(usage.input_tokens),
              cacheRead: count(usage.cache_read_input_tokens),
              cacheWrite: count(usage.cache_creation_input_tokens),
              output: count(usage.output_tokens),
              reasoning: 0,
            }
          : meter.tokens
    return {
      costUsd: number(event.total_cost_usd) ?? number(event.cost_usd) ?? meter.costUsd,
      tokens,
      requests: number(event.num_turns) ?? meter.requests,
    }
  }

  // Codex: turn.completed carries each turn's usage, and input_tokens includes the cached input.
  if (event.type === "turn.completed") {
    const usage = record(event.usage)
    if (!usage) return meter
    return { ...meter, tokens: add(meter.tokens, codexTokens(usage)) }
  }

  // Older Codex: token_count events carry the cumulative usage, so the last one wins.
  const info = record(record(event.msg)?.info) ?? record(event.info)
  const cumulative = record(info?.total_token_usage)
  if (cumulative) return { ...meter, tokens: codexTokens(cumulative) }

  return meter
}

function codexTokens(usage: Record<string, unknown>): Tokens {
  const cached = count(usage.cached_input_tokens)
  return {
    input: Math.max(0, count(usage.input_tokens) - cached),
    cacheRead: cached,
    cacheWrite: 0,
    output: count(usage.output_tokens),
    reasoning: count(usage.reasoning_output_tokens),
  }
}

function add(base: Tokens | undefined, next: Tokens): Tokens {
  const from = base ?? EMPTY
  return {
    input: from.input + next.input,
    cacheRead: from.cacheRead + next.cacheRead,
    cacheWrite: from.cacheWrite + next.cacheWrite,
    output: from.output + next.output,
    reasoning: from.reasoning + next.reasoning,
  }
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
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function count(value: unknown) {
  return number(value) ?? 0
}
