// Prices the requests a footprint run records under the provider's prompt-caching rules. The cache outlives a session:
// one cache is kept per runtime for the whole harness run, as a provider keeps an account's cached prefixes between
// sessions, so a second session's first request shows how much of its prefix an earlier session already warmed.
//
// Within a request the prefix runs tools, then the system prompt (or Responses `instructions`), then the messages or
// input items, in that order.
// - Anthropic Messages caches only at the breakpoints a request marks, charges a premium to write them, and looks back
//   at most LOOKBACK_BLOCKS blocks from a breakpoint for an earlier write.
// - The OpenAI Responses API caches every prefix it has seen on its own, free to write, and reads the longest one in
//   128-token steps once it reaches 1,024 tokens. That match runs to the token, so a message that shares only its
//   first part with an earlier one still reads that part.

// Anthropic caches nothing shorter than this, and OpenAI reads no cached prefix shorter than it.
export const MIN_CACHEABLE_TOKENS = 1_024
// OpenAI reads a cached prefix in steps of this many tokens.
export const CACHE_STEP_TOKENS = 128
const LOOKBACK_BLOCKS = 20

// Per million tokens.
export type Rates = { input: number; cacheWrite: number; cacheRead: number; output: number }

export type Recorded = {
  // What the provider prices: for a request that continues an earlier response (previous_response_id), the whole
  // context the provider rebuilds, not just the new items sent.
  body: Record<string, unknown>
  output: string
  // Bytes of the request as sent.
  sentBytes: number
  headers?: Record<string, string>
  transport?: "http" | "websocket"
}

export type RequestCost = {
  index: number
  who: "agent" | "subagent" | "side" | "warmup"
  tools: number
  systemTokens: number
  toolTokens: number
  messageTokens: number
  inputTokens: number
  cacheRead: number
  cacheWrite: number
  uncached: number
  outputTokens: number
  sentBytes: number
  costUsd: number
  uncachedCostUsd: number
}

type Block = { key: string; tokens: number; breakpoint: boolean }

export function createPromptCache() {
  return {
    // Prefix keys written at an Anthropic breakpoint.
    breakpoints: new Set<string>(),
    // Every Responses prompt seen so far, as its blocks.
    prompts: [] as Block[][],
  }
}

export type PromptCache = ReturnType<typeof createPromptCache>

export function price(requests: Recorded[], cache: PromptCache, rates: Rates): RequestCost[] {
  const main = toolSignature(requests.find((item) => toolsOf(item).length > 0))
  return requests.map((request, index) => {
    const blocks = toBlocks(request.body)
    const inputTokens = blocks.reduce((total, block) => total + block.tokens, 0)
    const read = Array.isArray(request.body.input) ? implicitRead(blocks, cache) : explicitRead(blocks, cache)
    const outputTokens = estimate(request.output)
    const uncached = inputTokens - read.cacheRead - read.cacheWrite
    const tools = toolsOf(request)
    const toolTokens = tools.reduce<number>((total, tool) => total + estimate(strip(tool)), 0)
    const systemTokens = systemBlocks(request.body).reduce<number>((total, block) => total + estimate(strip(block)), 0)
    return {
      index: index + 1,
      who:
        request.body.generate === false
          ? "warmup"
          : tools.length === 0
            ? "side"
            : toolSignature(request) === main
              ? "agent"
              : "subagent",
      tools: tools.length,
      systemTokens,
      toolTokens,
      messageTokens: inputTokens - toolTokens - systemTokens,
      inputTokens,
      cacheRead: read.cacheRead,
      cacheWrite: read.cacheWrite,
      uncached,
      outputTokens,
      sentBytes: request.sentBytes,
      costUsd: dollars(
        uncached * rates.input +
          read.cacheWrite * rates.cacheWrite +
          read.cacheRead * rates.cacheRead +
          outputTokens * rates.output,
      ),
      uncachedCostUsd: dollars(inputTokens * rates.input + outputTokens * rates.output),
    }
  })
}

// The longest prefix any earlier prompt shares with this one, to the token, in 128-token steps from 1,024 tokens.
function implicitRead(blocks: Block[], cache: PromptCache) {
  const shared = Math.max(0, ...cache.prompts.map((earlier) => sharedTokens(earlier, blocks)))
  cache.prompts.push(blocks)
  const steps = Math.floor(shared / CACHE_STEP_TOKENS) * CACHE_STEP_TOKENS
  return { cacheRead: steps >= MIN_CACHEABLE_TOKENS ? steps : 0, cacheWrite: 0 }
}

function sharedTokens(earlier: Block[], blocks: Block[]) {
  const whole = blocks.findIndex((block, at) => earlier[at]?.key !== block.key)
  const matched = whole === -1 ? blocks.length : whole
  const full = blocks.slice(0, matched).reduce((total, block) => total + block.tokens, 0)
  const next = blocks[matched]
  const other = earlier[matched]
  if (!next || !other) return full
  return full + Math.floor(commonPrefix(next.key, other.key) / 4)
}

function commonPrefix(a: string, b: string) {
  const limit = Math.min(a.length, b.length)
  let at = 0
  while (at < limit && a.charCodeAt(at) === b.charCodeAt(at)) at++
  return at
}

// Anthropic: a breakpoint reads the longest prefix written at a breakpoint within LOOKBACK_BLOCKS before it, and writes
// everything up to the last breakpoint that it did not read.
function explicitRead(blocks: Block[], cache: PromptCache) {
  const prefixes = blocks.reduce<{ keys: string[]; tokens: number[] }>(
    (acc, block) => ({
      keys: [...acc.keys, `${acc.keys.at(-1) ?? ""}\u0000${block.key}`],
      tokens: [...acc.tokens, (acc.tokens.at(-1) ?? 0) + block.tokens],
    }),
    { keys: [], tokens: [] },
  )
  const breakpoints = blocks.flatMap((block, at) =>
    block.breakpoint && (prefixes.tokens[at] ?? 0) >= MIN_CACHEABLE_TOKENS ? [at] : [],
  )
  const last = breakpoints.at(-1)
  const hit = breakpoints
    .map((at) => {
      const from = Math.max(0, at - LOOKBACK_BLOCKS)
      return Array.from({ length: at - from + 1 }, (_, offset) => at - offset).find((k) =>
        cache.breakpoints.has(prefixes.keys[k] ?? ""),
      )
    })
    .reduce<number | undefined>((best, k) => (k === undefined ? best : Math.max(best ?? -1, k)), undefined)
  breakpoints.forEach((at) => cache.breakpoints.add(prefixes.keys[at] ?? ""))
  const cacheRead = hit === undefined ? 0 : (prefixes.tokens[hit] ?? 0)
  return { cacheRead, cacheWrite: last === undefined ? 0 : (prefixes.tokens[last] ?? 0) - cacheRead }
}

// A Responses request that names previous_response_id sends only its new items; the provider continues from the
// earlier request's input and output, so that whole context is what it reads and prices.
export function continued(
  body: Record<string, unknown>,
  responses: Map<string, { input: unknown[]; output: unknown[] }>,
) {
  const input = Array.isArray(body.input) ? body.input : []
  const previous = typeof body.previous_response_id === "string" ? responses.get(body.previous_response_id) : undefined
  if (!previous) return { ...body, input }
  return { ...body, input: [...previous.input, ...previous.output, ...input] }
}

export function toBlocks(body: Record<string, unknown>): Block[] {
  const block = (item: unknown) => {
    const key = strip(item)
    return { key, tokens: estimate(key), breakpoint: JSON.stringify(item).includes('"cache_control"') }
  }
  return [
    ...(Array.isArray(body.tools) ? body.tools : []).map(block),
    ...systemBlocks(body).map(block),
    ...(Array.isArray(body.messages) ? body.messages : []).map(block),
    // A Responses input item's own id (msg_…, rs_…) names the item; it is not prompt text, so it is not part of the
    // cached prefix. Codex sends a fresh one per session.
    ...(Array.isArray(body.input) ? body.input : []).map((item) =>
      block(
        typeof item === "object" && item !== null && "id" in item
          ? Object.fromEntries(Object.entries(item).filter(([key]) => key !== "id"))
          : item,
      ),
    ),
  ]
}

export function systemBlocks(body: Record<string, unknown>): unknown[] {
  if (typeof body.instructions === "string") return [{ type: "text", text: body.instructions }]
  if (typeof body.system === "string") return [{ type: "text", text: body.system }]
  return Array.isArray(body.system) ? body.system : []
}

export function toolsOf(request: Recorded | undefined) {
  return Array.isArray(request?.body.tools) ? (request.body.tools as Array<Record<string, unknown>>) : []
}

// The main agent and a subagent are told apart by the tools they are offered.
export function toolSignature(request: Recorded | undefined) {
  return toolsOf(request)
    .map((tool) => String(tool.name ?? tool.type))
    .toSorted()
    .join(",")
}

// The cache key of a block is its content; where its cache_control marker sits does not change it.
export function strip(item: unknown) {
  return JSON.stringify(item, (name, value) => (name === "cache_control" ? undefined : value))
}

// About four characters per token, close enough to compare runtimes; the same estimate is used everywhere.
export function estimate(text: string) {
  return Math.ceil(text.length / 4)
}

export function dollars(tokenDollars: number) {
  return Math.round(tokenDollars) / 1_000_000
}
