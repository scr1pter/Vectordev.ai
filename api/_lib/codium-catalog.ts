// Reviewed against OpenRouter's /models and /endpoints/zdr on 2026-10-23.
// These are routing ceilings, not a promise that every provider has this price.
// The owner approved vendor-native precision for Kimi and the closed models; ZDR remains mandatory.
export const CODIUM_CATALOG_UPDATED = "2026-10-23"
export const CODIUM_MODELS = [
  {
    id: "deepseek/deepseek-v4.1-flash-1017",
    name: "DeepSeek V4.1 Flash 1017",
    category: "everyday",
    description: "The default: fast, capable coding for everyday changes, tests and agent work.",
    contextLength: 262144,
    maxOutputTokens: 16384,
    inputPrice: 0.3,
    outputPrice: 1.2,
    quantizations: ["fp8", "bf16"],
    reasoningEffort: "high",
  },
  {
    id: "anthropic/claude-haiku-5.5",
    name: "Claude Haiku 5.5",
    category: "everyday",
    description: "Fast, focused coding, tests and tool-assisted edits.",
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
    autoToolChoice: "forced",
    // Its endpoints take no sampling options, and with require_parameters any one of them would leave no endpoint.
    options: ["stop", "tools", "tool_choice", "response_format"],
  },
  {
    id: "openai/gpt-6-luna",
    name: "GPT-6 Luna",
    category: "everyday",
    description: "Efficient reasoning for focused fixes and everyday agent tasks.",
    contextLength: 128000,
    maxOutputTokens: 8192,
    promptTokenLimit: 272000,
    // Includes the regional Azure endpoint's 1.25x cache-write price below the long-prompt threshold.
    inputPrice: 0.1375,
    outputPrice: 0.55,
    reasoningEffort: "high",
    explicitCache: true,
    cacheStyle: "openai",
    outputTokenParameter: "max_completion_tokens",
    options: ["seed", "tools", "tool_choice", "response_format"],
  },
  {
    id: "moonshotai/kimi-k3.1-pro",
    name: "Kimi K3.1 Pro",
    category: "advanced",
    description: "For demanding coding and multi-step reasoning. Uses credits faster than the everyday models.",
    contextLength: 128000,
    maxOutputTokens: 8192,
    inputPrice: 2,
    outputPrice: 10,
    quantizations: ["mxfp4"],
    reasoningEffort: "high",
    // Moonshot supports required/auto, but not forcing a particular named function.
    autoToolChoice: "named",
    options: ["stop", "frequency_penalty", "presence_penalty", "response_format", "tool_choice", "tools"],
  },
  {
    id: "google/gemini-4-argon",
    name: "Gemini 4 Argon",
    category: "advanced",
    description: "For complex coding and deeper analysis. Uses credits faster than the everyday models.",
    contextLength: 128000,
    maxOutputTokens: 8192,
    inputPrice: 2,
    outputPrice: 10,
    reasoningEffort: "high",
    explicitCache: true,
    options: ["temperature", "top_p", "seed", "response_format", "tools", "tool_choice", "stop"],
  },
] as const
