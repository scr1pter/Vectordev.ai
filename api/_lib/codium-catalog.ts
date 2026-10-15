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
    quantizations: ["fp8", "bf16"],
    reasoningEffort: "high",
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
    quantizations: ["fp8", "bf16"],
  },
  {
    id: "anthropic/claude-haiku-5.5",
    name: "Claude Haiku 5.5",
    category: "advanced",
    description: "For harder, multi-step problems. Uses credits faster than the other models.",
    // Vector compacts once a step reaches this window less the reply: 48,000 tokens, which the gateway's window check
    // counts as 192,000 characters. That stays under the 196,000 ASCII characters the prompt bound below admits, so for
    // ASCII text the bound never refuses a full-reply request that the window check accepts.
    contextLength: 64000,
    maxOutputTokens: 16000,
    // Every endpoint bills a whole request at five times the price once its prompt reaches 100,000 tokens.
    promptTokenLimit: 100000,
    // Covers prompt-cache writes, which these endpoints bill at up to twice the 0.11 input price.
    inputPrice: 0.22,
    outputPrice: 0.55,
    reasoningEffort: "high",
    // Without explicit breakpoints these endpoints cache nothing, and all input bills at ten times the cached price.
    explicitCache: true,
    // Its endpoints take no sampling options, and with require_parameters any one of them would leave no endpoint.
    options: ["stop", "tools", "tool_choice", "response_format"],
  },
] as const
