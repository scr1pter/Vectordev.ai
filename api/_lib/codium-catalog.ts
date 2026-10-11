// Reviewed against OpenRouter's /models and /endpoints/zdr on 2026-10-10.
// These are routing ceilings, not a promise that every provider has this price.
export const CODIUM_CATALOG_UPDATED = "2026-10-10"
export const CODIUM_MODELS = [
  {
    id: "deepseek/deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    category: "everyday",
    description: "The default: fast, capable coding for everyday changes, tests and agent work.",
    contextLength: 262144,
    maxOutputTokens: 32000,
    inputPrice: 0.3,
    outputPrice: 1.2,
  },
  {
    id: "xiaomi/mimo-v2.6-flash",
    name: "Xiaomi MiMo V2.6 Flash",
    category: "everyday",
    description: "The most economical choice for routine edits and quick fixes. Slower to respond.",
    contextLength: 262144,
    // Its providers stream slowly, so a full response still finishes inside the gateway's time limit.
    maxOutputTokens: 16384,
    inputPrice: 0.26,
    outputPrice: 0.41,
  },
  {
    id: "anthropic/claude-haiku-5.5",
    name: "Claude Haiku 5.5",
    category: "advanced",
    description: "For harder, multi-step problems. Uses credits faster than the other models.",
    // Every endpoint bills the whole request at 5x once a prompt reaches 100,000 tokens. The gateway rejects a request
    // whose prompt bound plus output exceeds this limit; the bound overcounts code, prose and tool output, so only
    // text averaging under about three bytes a token could reach that price.
    contextLength: 100000,
    maxOutputTokens: 20000,
    // Covers prompt-cache writes, which these endpoints bill at up to twice the 0.11 input price.
    inputPrice: 0.22,
    outputPrice: 0.55,
  },
] as const
